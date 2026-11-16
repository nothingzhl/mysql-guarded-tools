import { normalizeConnection } from "./config-store.mjs";

function optional(value, fallback) {
  return value === undefined ? fallback : value;
}

function publicConnection(name, connection, passwordConfigured) {
  return {
    name,
    host: connection.host,
    port: connection.port,
    user: connection.user,
    database: connection.database,
    connection_limit: connection.connectionLimit,
    connect_timeout_ms: connection.connectTimeoutMs,
    ssl: connection.ssl,
    ssl_reject_unauthorized: connection.sslRejectUnauthorized,
    allow_update: connection.allowUpdate,
    password_configured: passwordConfigured,
  };
}

export function managedConnectionState(store) {
  const state = store.publicState();
  return {
    management_mode: "native_mcp",
    default_connection: state.defaultConnection,
    connections: state.connections.map((connection) => publicConnection(
      connection.name,
      connection,
      connection.passwordConfigured,
    )),
  };
}

export async function saveManagedConnection(options) {
  return options.store.withLock(() => saveUnlocked(options));
}

async function saveUnlocked({ store, args, promptPassword, onChanged }) {
  const config = store.read();
  const existing = config.connections[args.name];
  const copyPasswordFrom = args.copy_password_from;
  if (copyPasswordFrom && args.change_password === true) {
    throw new Error("copy_password_from 和 change_password 不能同时使用。");
  }
  if (copyPasswordFrom === args.name) {
    throw new Error("不能从连接自身复制密码。");
  }
  const passwordRequired = (!existing || args.change_password === true) && !copyPasswordFrom;
  const input = {
    host: optional(args.host, existing?.host),
    port: optional(args.port, existing?.port),
    user: optional(args.user, existing?.user),
    database: optional(args.database, existing?.database),
    connectionLimit: optional(args.connection_limit, existing?.connectionLimit),
    connectTimeoutMs: optional(args.connect_timeout_ms, existing?.connectTimeoutMs),
    ssl: optional(args.ssl, existing?.ssl),
    sslRejectUnauthorized: optional(
      args.ssl_reject_unauthorized,
      existing?.sslRejectUnauthorized,
    ),
    allowUpdate: optional(args.allow_update, existing?.allowUpdate),
    setDefault: args.set_default === true,
    password: "",
  };

  const normalized = normalizeConnection(args.name, input);
  if (copyPasswordFrom) {
    const source = config.connections[copyPasswordFrom];
    if (!source) throw new Error(`来源连接 ${copyPasswordFrom} 不存在。`);
    const mismatchedFields = ["host", "port", "user"].filter(
      (field) => source[field] !== normalized[field],
    );
    if (mismatchedFields.length > 0) {
      throw new Error("只有主机、端口和用户名完全一致的连接才能复制密码。");
    }
    input.password = store.copyPassword(copyPasswordFrom, args.name);
  } else if (passwordRequired) {
    input.password = await promptPassword(args.name);
  }

  const saved = store.saveConnection(args.name, input);
  let runtimeWarning;
  try { await onChanged(args.name); }
  catch { runtimeWarning = "配置已保存，但运行时连接池刷新失败，请重启插件。"; }
  const updatedConfig = store.read();
  return {
    runtime_warning: runtimeWarning,
    action: existing ? "updated" : "created",
    connection: publicConnection(args.name, saved, true),
    default_connection: updatedConfig.defaultConnection,
    password_action: copyPasswordFrom
      ? "copied_from_keychain"
      : passwordRequired
        ? "stored_in_keychain"
        : "kept_existing",
    password_source: copyPasswordFrom ?? undefined,
    next_step: "可以调用 mysql_health_check 测试该连接。",
  };
}

export async function deleteManagedConnection(options) {
  return options.store.withLock(() => deleteUnlocked(options));
}
async function deleteUnlocked({ store, name, onChanged }) {
  store.deleteConnection(name);
  await onChanged(name);
  return {
    deleted: name,
    default_connection: store.read().defaultConnection,
    password_deleted_from_keychain: true,
  };
}

export async function setManagedDefaultConnection(options) {
  return options.store.withLock(() => setDefaultUnlocked(options));
}
async function setDefaultUnlocked({ store, name, onChanged }) {
  store.setDefault(name);
  await onChanged(null);
  return {
    default_connection: name,
  };
}
