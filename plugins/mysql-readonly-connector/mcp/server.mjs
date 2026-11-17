#!/usr/bin/env node

import readline from "node:readline";
import { createConfigWindow } from "./config-window.mjs";
import mysql from "mysql2/promise";
import { BoundedExecutor } from "./bounded-executor.mjs";
import { ConfigStore, defaultConfigPath } from "./config-store.mjs";
import {
  deleteManagedConnection,
  managedConnectionState,
  saveManagedConnection,
  setManagedDefaultConnection,
} from "./connection-manager.mjs";
import { runGuardedUpdateTransaction } from "./guarded-update.mjs";
import {
  integerFromEnv,
  loadConnectionRegistry,
  resolveConnectionName,
} from "./config.mjs";
import { validateIdentifier, validateReadOnlySql, validateUpdateSql } from "./sql-policy.mjs";
import {
  UPDATE_REVIEW_THRESHOLD,
  UPDATE_REVIEW_TTL_MS,
  UpdateReviewStore,
} from "./update-review.mjs";

const SERVER_NAME = "mysql-readonly-connector";
const SERVER_VERSION = "0.8.0-rc.1";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const ABSOLUTE_MAX_ROWS = 5000;
const ABSOLUTE_MAX_TIMEOUT_MS = 120000;
const pools = new Map();
let registry;
let executor;
let configStore;
const updateReviews = new UpdateReviewStore();

function getRegistry() {
  if (!registry) registry = loadConnectionRegistry();
  return registry;
}

function getExecutor() {
  if (!executor) {
    executor = new BoundedExecutor({
      maxActive: integerFromEnv(process.env, "MYSQL_MAX_CONCURRENT_QUERIES", 4, 1, 32),
      maxQueued: integerFromEnv(process.env, "MYSQL_MAX_QUEUED_QUERIES", 20, 0, 200),
      queueTimeoutMs: integerFromEnv(process.env, "MYSQL_QUEUE_TIMEOUT_MS", 10000, 1000, 120000),
    });
  }
  return executor;
}

function getConfigStore() {
  if (!configStore) {
    configStore = new ConfigStore({ configPath: defaultConfigPath(process.env) });
  }
  return configStore;
}

function hasLegacyConnectionEnvironment() {
  return Boolean(
    process.env.MYSQL_CONNECTIONS_JSON
    || process.env.MYSQL_URL
    || process.env.MYSQL_HOST
    || process.env.MYSQL_USER
    || process.env.MYSQL_DATABASE,
  );
}

function ensureNativeManagementAvailable() {
  if (!getConfigStore().exists() && hasLegacyConnectionEnvironment()) {
    throw new Error("当前连接来自兼容环境变量，原生管理工具不会覆盖它们。请先移除旧环境变量配置并重启 Codex，再使用原生连接管理工具。");
  }
}

function connectionState() {
  const store = getConfigStore();
  if (store.exists() || !hasLegacyConnectionEnvironment()) {
    return managedConnectionState(store);
  }
  const currentRegistry = getRegistry();
  return {
    management_mode: "legacy_environment",
    default_connection: currentRegistry.defaultConnection,
    connections: [...currentRegistry.profiles.entries()].map(([name, profile]) => ({
      name,
      host: profile.host,
      port: profile.port,
      user: profile.user,
      database: profile.database,
      connection_limit: profile.connectionLimit,
      connect_timeout_ms: profile.connectTimeout,
      ssl: Boolean(profile.ssl),
      ssl_reject_unauthorized: profile.ssl?.rejectUnauthorized ?? true,
      allow_update: profile.allowUpdate === true,
      password_configured: true,
    })),
    message: "当前连接来自兼容环境变量，原生管理工具不会修改这些环境变量。",
  };
}

async function reloadManagedConnections(connectionName) {
  registry = undefined;
  if (connectionName && pools.has(connectionName)) {
    const pool = pools.get(connectionName);
    pools.delete(connectionName);
    await pool.end();
  }
}

function boundedInteger(value, fallback, minimum, maximum, fieldName) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${fieldName} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return value;
}

function defaultMaxRows() {
  return integerFromEnv(process.env, "MYSQL_MAX_ROWS", 500, 1, ABSOLUTE_MAX_ROWS);
}

function defaultQueryTimeout() {
  return integerFromEnv(
    process.env,
    "MYSQL_QUERY_TIMEOUT_MS",
    30000,
    1000,
    ABSOLUTE_MAX_TIMEOUT_MS,
  );
}

function getPool(connectionName) {
  if (pools.has(connectionName)) return pools.get(connectionName);
  const profile = getRegistry().profiles.get(connectionName);
  if (profile.passwordConfigured === false) throw new Error(`连接 ${connectionName} 的密码环境变量未配置，请设置后重启插件。`);
  const { allowUpdate: _allowUpdate, passwordConfigured: _passwordConfigured, passwordSource: _source, passwordKey: _key, ...connectionConfig } = profile;
  const pool = mysql.createPool({
    ...connectionConfig,
    waitForConnections: true,
    queueLimit: integerFromEnv(process.env, "MYSQL_POOL_QUEUE_LIMIT", 10, 0, 100),
    enableKeepAlive: true,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
  pools.set(connectionName, pool);
  return pool;
}

async function acquireConnection(pool) {
  const timeoutMs = integerFromEnv(
    process.env,
    "MYSQL_ACQUIRE_TIMEOUT_MS",
    10000,
    1000,
    120000,
  );
  let expired = false;
  let timer;
  const pending = pool.getConnection().then((connection) => {
    if (expired) {
      connection.release();
      throw new Error("获取 MySQL 连接超时。");
    }
    return connection;
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error("获取 MySQL 连接超时。"));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function truncateUtf8(value, maximumBytes) {
  const encoded = Buffer.from(value);
  if (encoded.length <= maximumBytes) return value;
  return `${encoded.subarray(0, maximumBytes).toString("utf8")}…[truncated]`;
}

function normalizeValue(value, maximumCellBytes) {
  if (value === null || value === undefined) return value ?? null;
  if (Buffer.isBuffer(value)) {
    const truncated = value.length > maximumCellBytes;
    const visible = truncated ? value.subarray(0, maximumCellBytes) : value;
    return {
      type: "binary",
      base64: visible.toString("base64"),
      original_bytes: value.length,
      truncated,
    };
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, maximumCellBytes));
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return truncateUtf8(value, maximumCellBytes);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        normalizeValue(nestedValue, maximumCellBytes),
      ]),
    );
  }
  return value;
}

function boundedQuery(sql, params, maximumRows) {
  if (/^(SELECT|WITH)\b/i.test(sql)) {
    return {
      sql: `SELECT * FROM (${sql}) AS _codex_readonly_result LIMIT ?`,
      params: [...params, maximumRows + 1],
    };
  }
  return { sql, params };
}

function boundRows(rows, maximumRows) {
  const maximumCellBytes = integerFromEnv(
    process.env,
    "MYSQL_MAX_CELL_BYTES",
    262144,
    1024,
    1048576,
  );
  const maximumResponseBytes = integerFromEnv(
    process.env,
    "MYSQL_MAX_RESPONSE_BYTES",
    5242880,
    65536,
    20971520,
  );
  const visibleRows = [];
  let usedBytes = 0;
  let responseSizeTruncated = false;
  for (const row of rows.slice(0, maximumRows)) {
    const normalized = normalizeValue(row, maximumCellBytes);
    const rowBytes = Buffer.byteLength(JSON.stringify(normalized));
    if (usedBytes + rowBytes > maximumResponseBytes) {
      responseSizeTruncated = true;
      break;
    }
    visibleRows.push(normalized);
    usedBytes += rowBytes;
  }
  return {
    rows: visibleRows,
    truncated: rows.length > visibleRows.length,
    responseSizeTruncated,
    responseBytes: usedBytes,
  };
}

async function executeReadOnlyQuery({ connection, sql, params = [], maxRows, timeoutMs }) {
  const safeSql = validateReadOnlySql(sql);
  if (!Array.isArray(params)) throw new Error("params 必须是数组。");
  const connectionName = resolveConnectionName(getRegistry(), connection);
  const effectiveMaxRows = boundedInteger(
    maxRows,
    defaultMaxRows(),
    1,
    ABSOLUTE_MAX_ROWS,
    "max_rows",
  );
  const effectiveTimeoutMs = boundedInteger(
    timeoutMs,
    defaultQueryTimeout(),
    1000,
    ABSOLUTE_MAX_TIMEOUT_MS,
    "timeout_ms",
  );

  return getExecutor().run(async () => {
    const databaseConnection = await acquireConnection(getPool(connectionName));
    try {
      await databaseConnection.query("SET SESSION TRANSACTION READ ONLY");
      await databaseConnection.query("SET SESSION SQL_SELECT_LIMIT = ?", [effectiveMaxRows + 1]);
      try {
        await databaseConnection.query("SET SESSION MAX_EXECUTION_TIME = ?", [effectiveTimeoutMs]);
      } catch (error) {
        if (error?.code !== "ER_UNKNOWN_SYSTEM_VARIABLE") throw error;
      }

      const bounded = boundedQuery(safeSql, params, effectiveMaxRows);
      const [rows, fields] = await databaseConnection.query(
        { sql: bounded.sql, timeout: effectiveTimeoutMs },
        bounded.params,
      );
      if (!Array.isArray(rows)) throw new Error("数据库返回了非查询结果，已拒绝处理。");

      const boundedResult = boundRows(rows, effectiveMaxRows);
      return {
        connection: connectionName,
        row_count: boundedResult.rows.length,
        truncated: boundedResult.truncated,
        truncation_reason: boundedResult.responseSizeTruncated
          ? "response_byte_limit"
          : rows.length > effectiveMaxRows
            ? "row_limit"
            : null,
        max_rows: effectiveMaxRows,
        response_bytes: boundedResult.responseBytes,
        columns: (fields ?? []).map((field) => ({
          name: field.name,
          table: field.table || null,
          schema: field.schema || null,
          type_id: field.columnType,
        })),
        rows: boundedResult.rows,
      };
    } finally {
      databaseConnection.release();
    }
  });
}

async function executeControlledUpdate({ connection, sql, params = [], timeoutMs, reviewToken }) {
  const safeSql = validateUpdateSql(sql);
  if (!Array.isArray(params)) throw new Error("params 必须是数组。");
  const connectionName = resolveConnectionName(getRegistry(), connection);
  const profile = getRegistry().profiles.get(connectionName);
  if (profile.allowUpdate !== true) {
    throw new Error(`连接 ${connectionName} 尚未在连接设置中启用 UPDATE。`);
  }
  const effectiveTimeoutMs = boundedInteger(
    timeoutMs,
    defaultQueryTimeout(),
    1000,
    ABSOLUTE_MAX_TIMEOUT_MS,
    "timeout_ms",
  );
  const reviewPayload = {
    connection: connectionName,
    sql: safeSql,
    params,
  };
  const approvedReview = reviewToken
    ? updateReviews.consume(reviewToken, reviewPayload)
    : undefined;

  return getExecutor().run(async () => {
    const databaseConnection = await acquireConnection(getPool(connectionName));
    try {
      const outcome = await runGuardedUpdateTransaction({
        connection: databaseConnection,
        sql: safeSql,
        params,
        timeoutMs: effectiveTimeoutMs,
        approvedAffectedRows: approvedReview?.affectedRows,
      });
      if (outcome.status === "review_required") {
        const review = updateReviews.issue(reviewPayload, outcome.affectedRows);
        return {
          status: "review_required",
          connection: connectionName,
          committed: false,
          affected_rows: outcome.affectedRows,
          changed_rows: outcome.changedRows,
          warning_status: outcome.warningStatus,
          review_threshold: UPDATE_REVIEW_THRESHOLD,
          review_token: review.token,
          review_expires_at: new Date(review.expiresAt).toISOString(),
          review_expires_in_seconds: Math.floor(UPDATE_REVIEW_TTL_MS / 1000),
          changed_since_review: outcome.changedSinceReview,
          message: outcome.changedSinceReview
            ? "影响行数在审查后发生变化，已回滚。请向用户展示新的影响行数并重新确认。"
            : "影响行数超过 10 条，已回滚。必须由用户明确审查确认后，使用相同连接、SQL、参数和 review_token 再次调用。",
        };
      }
      return {
        status: "committed",
        connection: connectionName,
        committed: true,
        affected_rows: outcome.affectedRows,
        changed_rows: outcome.changedRows,
        warning_status: outcome.warningStatus,
        reviewed: outcome.reviewed,
        message: outcome.reviewed
          ? "UPDATE 已在用户审查后提交。"
          : "UPDATE 影响不超过 10 条，已提交。",
      };
    } finally {
      databaseConnection.release();
    }
  });
}

const connectionProperty = {
  type: "string",
  description: "命名 MySQL 连接。多连接且没有默认连接时必须填写。",
};

const configWindow = createConfigWindow({ callTool });

const tools = [
  { name: "mysql_open_config_window", description: "打开本机 MySQL 连接配置窗口，管理真实连接、默认连接和访问权限。返回本机访问地址。", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  {
    name: "mysql_list_connections",
    description: "列出 MySQL 连接的非密码配置、默认连接和 UPDATE 开关状态。不会返回密码。",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "mysql_save_connection",
    description: "新增或编辑连接；密码只从 MYSQL_PASSWORD 或 MYSQL_PASSWORDS_JSON 环境变量读取，工具仅保存来源和名称。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$", description: "连接名称。" },
        host: { type: "string", description: "MySQL 主机。新增连接必填。" },
        port: { type: "integer", minimum: 1, maximum: 65535, description: "端口，默认 3306。" },
        user: { type: "string", description: "数据库用户名。新增连接必填。" },
        database: { type: "string", description: "默认数据库。新增连接必填。" },
        connection_limit: { type: "integer", minimum: 1, maximum: 10 },
        connect_timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
        ssl: { type: "boolean" },
        ssl_reject_unauthorized: { type: "boolean" },
        allow_update: {
          type: "boolean",
          description: "是否允许受控 UPDATE。默认关闭。",
        },
        set_default: { type: "boolean", description: "保存后设为默认连接。" },
        password_source: { type: "string", enum: ["MYSQL_PASSWORD", "MYSQL_PASSWORDS_JSON"], description: "密码环境变量来源；默认 MYSQL_PASSWORD。" },
        password_key: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$", description: "MYSQL_PASSWORDS_JSON 中的名称；默认连接名。" },
      },
      required: ["name"],
    },
  },
  {
    name: "mysql_delete_connection",
    description: "删除连接配置，不修改环境变量。必须在用户明确要求删除后调用。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
        confirm: { type: "boolean", description: "必须为 true，表示用户已明确确认删除。" },
      },
      required: ["name", "confirm"],
    },
  },
  {
    name: "mysql_set_default_connection",
    description: "设置默认 MySQL 连接；省略 name 可清除默认连接。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
      },
    },
  },
  {
    name: "mysql_query",
    description: "在指定连接执行单条只读 MySQL SQL。仅允许 SELECT、SHOW、DESCRIBE/DESC、EXPLAIN 和只读 WITH。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        connection: connectionProperty,
        sql: { type: "string", description: "要执行的单条只读 SQL。" },
        params: { type: "array", description: "? 占位符参数。", items: {}, default: [] },
        max_rows: { type: "integer", minimum: 1, maximum: ABSOLUTE_MAX_ROWS },
        timeout_ms: { type: "integer", minimum: 1000, maximum: ABSOLUTE_MAX_TIMEOUT_MS },
      },
      required: ["sql"],
    },
  },
  {
    name: "mysql_update",
    description: "执行带 WHERE 的单条受控 UPDATE。连接必须显式启用 UPDATE；影响不超过 10 条会提交，超过 10 条会回滚并要求用户使用一次性 review_token 明确审查确认。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        connection: connectionProperty,
        sql: { type: "string", description: "带 WHERE 条件的单条 UPDATE SQL。" },
        params: { type: "array", description: "? 占位符参数。", items: {}, default: [] },
        timeout_ms: { type: "integer", minimum: 1000, maximum: ABSOLUTE_MAX_TIMEOUT_MS },
        review_token: {
          type: "string",
          description: "影响超过 10 条并经用户明确确认后，原样传回的一次性审查令牌。",
        },
      },
      required: ["sql"],
    },
  },
  {
    name: "mysql_list_tables",
    description: "列出指定连接和数据库中的表与视图。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        connection: connectionProperty,
        database: { type: "string", description: "可选数据库名。" },
      },
    },
  },
  {
    name: "mysql_describe_table",
    description: "查看指定连接中表的字段和索引。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        connection: connectionProperty,
        database: { type: "string", description: "可选数据库名。" },
        table: { type: "string", description: "表名。" },
      },
      required: ["table"],
    },
  },
  {
    name: "mysql_health_check",
    description: "检查指定 MySQL 连接，返回当前数据库、用户、版本和只读状态。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { connection: connectionProperty },
    },
  },
];

async function callTool(name, args = {}) {
  const schema = tools.find(tool => tool.name === name)?.inputSchema;
  if (!schema) throw new Error("未知工具。");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("工具参数必须是对象。");
  for (const key of Object.keys(args)) {
    const field = schema.properties[key];
    if (!field) throw new Error("不支持的参数字段；不得通过工具参数传递密码。");
    const value = args[key];
    if (field.type === "integer" && (!Number.isInteger(value) || value < field.minimum || value > field.maximum)) throw new Error("整数参数超出范围。");
    if (["string", "boolean"].includes(field.type) && typeof value !== field.type) throw new Error("参数类型不正确。");
    if (field.enum && !field.enum.includes(value)) throw new Error("参数不在允许范围内。");
    if (field.pattern && !new RegExp(field.pattern).test(value)) throw new Error("参数格式不正确。");
    if (field.type === "array" && !Array.isArray(value)) throw new Error("参数必须为数组。");
  }
  if ((schema.required || []).some(key => args[key] === undefined)) throw new Error("缺少必填参数。");

  if (name === "mysql_open_config_window") return configWindow.open();
  if (name === "mysql_list_connections") {
    return { ...connectionState(), runtime: getExecutor().snapshot() };
  }
  if (name === "mysql_save_connection") {
    ensureNativeManagementAvailable();
    return saveManagedConnection({
      store: getConfigStore(),
      args,
      onChanged: reloadManagedConnections,
    });
  }
  if (name === "mysql_delete_connection") {
    ensureNativeManagementAvailable();
    if (args.confirm !== true) throw new Error("删除连接前必须得到用户明确确认，并传入 confirm=true。");
    return deleteManagedConnection({
      store: getConfigStore(),
      name: args.name,
      onChanged: reloadManagedConnections,
    });
  }
  if (name === "mysql_set_default_connection") {
    ensureNativeManagementAvailable();
    return setManagedDefaultConnection({
      store: getConfigStore(),
      name: args.name ?? null,
      onChanged: reloadManagedConnections,
    });
  }
  if (name === "mysql_query") {
    return executeReadOnlyQuery({
      connection: args.connection,
      sql: args.sql,
      params: args.params,
      maxRows: args.max_rows,
      timeoutMs: args.timeout_ms,
    });
  }
  if (name === "mysql_update") {
    return executeControlledUpdate({
      connection: args.connection,
      sql: args.sql,
      params: args.params,
      timeoutMs: args.timeout_ms,
      reviewToken: args.review_token,
    });
  }
  if (name === "mysql_list_tables") {
    const database = args.database === undefined ? null : validateIdentifier(args.database, "database");
    return executeReadOnlyQuery({
      connection: args.connection,
      sql: `SELECT TABLE_SCHEMA AS table_schema,
                   TABLE_NAME AS table_name,
                   TABLE_TYPE AS table_type,
                   ENGINE AS engine,
                   TABLE_ROWS AS estimated_rows,
                   TABLE_COMMENT AS table_comment
              FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = COALESCE(?, DATABASE())
             ORDER BY TABLE_TYPE, TABLE_NAME`,
      params: [database],
      maxRows: ABSOLUTE_MAX_ROWS,
    });
  }
  if (name === "mysql_describe_table") {
    const table = validateIdentifier(args.table, "table");
    const database = args.database === undefined ? null : validateIdentifier(args.database, "database");
    const common = {
      connection: args.connection,
      params: [database, table],
      maxRows: ABSOLUTE_MAX_ROWS,
    };
    const columns = await executeReadOnlyQuery({
      ...common,
      sql: `SELECT ORDINAL_POSITION AS ordinal_position,
                   COLUMN_NAME AS column_name,
                   COLUMN_TYPE AS column_type,
                   IS_NULLABLE AS is_nullable,
                   COLUMN_DEFAULT AS column_default,
                   COLUMN_KEY AS column_key,
                   EXTRA AS extra,
                   COLUMN_COMMENT AS column_comment
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION`,
    });
    const indexes = await executeReadOnlyQuery({
      ...common,
      sql: `SELECT INDEX_NAME AS index_name,
                   NON_UNIQUE AS non_unique,
                   SEQ_IN_INDEX AS seq_in_index,
                   COLUMN_NAME AS column_name,
                   INDEX_TYPE AS index_type
              FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
             ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    });
    return { connection: columns.connection, columns, indexes };
  }
  if (name === "mysql_health_check") {
    return executeReadOnlyQuery({
      connection: args.connection,
      sql: `SELECT DATABASE() AS current_database,
                   CURRENT_USER() AS authenticated_user,
                   VERSION() AS mysql_version,
                   @@global.read_only AS global_read_only,
                   @@global.super_read_only AS global_super_read_only`,
      maxRows: 1,
    });
  }
  throw new Error(`未知工具：${name}`);
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}


function success(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function failure(id, code, message, data) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

async function handleRequest(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    success(id, {
      protocolVersion: params.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: "多连接 MySQL 安全连接器。查询默认只读；UPDATE 必须在连接配置中显式启用，且超过 10 条时需要用户审查确认。密码从 MYSQL_PASSWORD 或 MYSQL_PASSWORDS_JSON 环境变量读取；修改环境变量后确保 Codex 宿主重新继承变量并重启。",
    });
    return;
  }
  if (method === "ping") {
    success(id, {});
    return;
  }
  if (method === "tools/list") {
    success(id, { tools });
    return;
  }
  if (method === "tools/call") {
    try {
      const result = await callTool(params.name, params.arguments ?? {});
      success(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: false,
      });
    } catch (error) {
      success(id, {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      });
    }
    return;
  }
  if (id !== undefined) failure(id, -32601, `不支持的方法：${method}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line);
    if (message.jsonrpc !== "2.0") {
      failure(message.id ?? null, -32600, "无效的 JSON-RPC 请求。");
      return;
    }
    if (message.id !== undefined) await handleRequest(message);
  } catch (error) {
    failure(null, -32700, "无法解析请求。", error instanceof Error ? error.message : String(error));
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await configWindow.close();
  input.close();
  executor?.close();
  updateReviews.clear();
  await Promise.allSettled([...pools.values()].map((pool) => pool.end()));
  pools.clear();
  process.exit(0);
}

input.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
