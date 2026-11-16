import { systemKeychain } from "./keychain.mjs";
import { randomUUID } from "node:crypto";
export { systemKeychain } from "./keychain.mjs";
import {
  chmodSync,
  openSync,
  closeSync,
  statSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG_VERSION = 1;
const KEYCHAIN_SERVICE = "mysql-readonly-connector";
const CONNECTION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function defaultConfigPath(env = process.env) {
  return env.MYSQL_CONFIG_FILE
    || join(homedir(), "Library", "Application Support", "mysql-readonly-connector", "connections.json");
}

function emptyConfig() {
  return { version: CONFIG_VERSION, defaultConnection: null, connections: {} };
}

function integerValue(value, fallback, minimum, maximum, fieldName) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${fieldName} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return parsed;
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || /^(1|true|yes)$/i.test(String(value))) return true;
  if (value === false || /^(0|false|no)$/i.test(String(value))) return false;
  throw new Error("布尔配置必须是 true 或 false。");
}

export function normalizeConnection(name, input) {
  if (!CONNECTION_NAME_PATTERN.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) {
    throw new Error("连接名称只能包含字母、数字、下划线和连字符，长度不超过 64。");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`连接 ${name} 的配置必须是对象。`);
  }
  const connection = {
    host: String(input.host ?? "").trim(),
    port: integerValue(input.port, 3306, 1, 65535, "端口"),
    user: String(input.user ?? "").trim(),
    database: String(input.database ?? "").trim(),
    connectionLimit: integerValue(input.connectionLimit, 2, 1, 10, "连接池大小"),
    connectTimeoutMs: integerValue(input.connectTimeoutMs, 10000, 1000, 120000, "连接超时"),
    ssl: booleanValue(input.ssl, false),
    sslRejectUnauthorized: booleanValue(input.sslRejectUnauthorized, true),
    allowUpdate: booleanValue(input.allowUpdate, false),
  };
  const missing = ["host", "user", "database"].filter((field) => !connection[field]);
  if (missing.length > 0) {
    throw new Error(`连接 ${name} 缺少配置：${missing.join(", ")}。`);
  }
  return connection;
}

export class ConfigStore {
  constructor({ configPath = defaultConfigPath(), keychain = systemKeychain } = {}) {
    this.configPath = configPath;
    this.keychain = keychain;
  }

  exists() {
    return existsSync(this.configPath);
  }

  read() {
    if (!this.exists()) return emptyConfig();
    let config;
    try {
      config = JSON.parse(readFileSync(this.configPath, "utf8"));
    } catch {
      throw new Error("MySQL 插件配置文件不是有效的 JSON。");
    }
    if (config?.version !== CONFIG_VERSION || !config.connections || typeof config.connections !== "object") {
      throw new Error("MySQL 插件配置文件版本或结构不受支持。");
    }
    return {
      version: CONFIG_VERSION,
      defaultConnection: config.defaultConnection ?? null,
      connections: config.connections,
    };
  }

  prepareDirectory() {
    const directory = dirname(this.configPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if ((statSync(directory).mode & 0o077) !== 0) chmodSync(directory, 0o700);
  }

  async withLock(action) {
    this.prepareDirectory();
    const lockPath = `${this.configPath}.lock`;
    let fd;
    try { fd = openSync(lockPath, "wx", 0o600); }
    catch (error) {
      if (error.code === "EEXIST") throw new Error("另一进程正在修改连接配置；若确认所有插件进程已关闭，才可清理遗留的 .lock 文件。");
      throw error;
    }
    try { return await action(); }
    finally { closeSync(fd); unlinkSync(lockPath); }
  }

  write(config) {
    this.prepareDirectory();
    const temporaryPath = `${this.configPath}.tmp-${randomUUID()}`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporaryPath, this.configPath);
    } finally { if (existsSync(temporaryPath)) unlinkSync(temporaryPath); }
  }

  publicState() {
    const config = this.read();
    return {
      defaultConnection: config.defaultConnection,
      connections: Object.entries(config.connections).map(([name, connection]) => ({
        name,
        ...connection,
        passwordConfigured: this.keychain.has ? this.keychain.has(name) : this.keychain.get(name) !== null,
      })),
    };
  }

  copyPassword(sourceName, targetName) {
    const config = this.read();
    if (!config.connections[sourceName]) {
      throw new Error(`来源连接 ${sourceName} 不存在。`);
    }
    const password = this.keychain.get(sourceName);
    if (password === null) {
      throw new Error(`来源连接 ${sourceName} 在 macOS 钥匙串中没有密码。`);
    }
    return password;
  }

  saveConnection(name, input) {
    const normalized = normalizeConnection(name, input);
    const config = this.read();
    const existingPassword = this.keychain.get(name);
    if (input.password) {
      this.keychain.set(name, input.password);
    } else if (existingPassword === null) {
      throw new Error(`连接 ${name} 尚未配置密码。`);
    }
    config.connections[name] = normalized;
    if (input.setDefault === true || !config.defaultConnection) {
      config.defaultConnection = name;
    }
    try { this.write(config); }
    catch (error) {
      if (input.password) {
        try {
          if (existingPassword === null) this.keychain.delete(name);
          else this.keychain.set(name, existingPassword);
        } catch { throw new Error("配置保存失败且钥匙串回滚失败，请手动核对配置和密码；不要盲目重试。"); }
      }
      throw error;
    }
    return normalized;
  }

  deleteConnection(name) {
    const config = this.read();
    if (!config.connections[name]) throw new Error(`连接 ${name} 不存在。`);
    delete config.connections[name];
    if (config.defaultConnection === name) {
      config.defaultConnection = Object.keys(config.connections)[0] ?? null;
    }
    const previousPassword = this.keychain.get(name);
    this.keychain.delete(name);
    try { this.write(config); }
    catch (error) {
      try { if (previousPassword !== null) this.keychain.set(name, previousPassword); }
      catch { throw new Error("删除失败且钥匙串回滚失败，请手动核对该连接。"); }
      throw error;
    }
  }

  setDefault(name) {
    const config = this.read();
    if (name !== null && !config.connections[name]) throw new Error(`连接 ${name} 不存在。`);
    config.defaultConnection = name;
    this.write(config);
  }

  resolvedProfiles() {
    const config = this.read();
    const profiles = {};
    for (const [name, connection] of Object.entries(config.connections)) {
      const password = this.keychain.get(name);
      if (password === null) throw new Error(`连接 ${name} 在 macOS 钥匙串中没有密码。`);
      profiles[name] = { ...connection, password };
    }
    return { profiles, defaultConnection: config.defaultConnection };
  }

  removeConfigFileForTest() {
    if (this.exists()) unlinkSync(this.configPath);
  }
}

export function readManagedProfiles(env = process.env, options = {}) {
  const store = options.store ?? new ConfigStore({ configPath: defaultConfigPath(env) });
  if (!store.exists()) return null;
  return store.resolvedProfiles();
}
