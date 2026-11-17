import { environmentPassword } from "./environment-passwords.mjs";
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
    password_source: connection.passwordSource ?? "MYSQL_PASSWORD",
    password_key: connection.passwordKey ?? name,
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

async function saveUnlocked({ store, args, onChanged }) {
  if (Object.hasOwn(args,'password') || Object.hasOwn(args,'change_password') || Object.hasOwn(args,'copy_password_from')) {
    throw new Error('密码由环境变量提供；不支持密码值、换密弹窗或钥匙串复制参数。');
  }
  const config = store.read();
  const existing = Object.hasOwn(config.connections,args.name) ? config.connections[args.name] : undefined;
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
    passwordSource: optional(args.password_source, existing?.passwordSource),
    passwordKey: optional(args.password_key, existing?.passwordKey),
  };

  const normalized = normalizeConnection(args.name, input);
  const configured = environmentPassword(args.name, normalized, store.env) !== null;
  const saved = store.saveConnection(args.name, input);
  let runtimeWarning;
  try { await onChanged(args.name); }
  catch { runtimeWarning = "配置已保存，但运行时连接池刷新失败，请重启插件。"; }
  const updatedConfig = store.read();
  return {
    runtime_warning: runtimeWarning,
    action: existing ? "updated" : "created",
    connection: publicConnection(args.name, saved, configured),
    default_connection: updatedConfig.defaultConnection,
    password_action: "environment_reference_saved",
    next_step: configured ? "可以调用 mysql_health_check 测试该连接。" : "请设置密码环境变量并重启 Codex，再检查连接。",
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
    environment_unchanged: true,
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
