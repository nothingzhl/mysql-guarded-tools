import { readManagedProfiles } from "./config-store.mjs";

const CONNECTION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function integerFromEnv(env, name, fallback, minimum, maximum) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return parsed;
}

export function booleanValue(value, fallback, fieldName) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || /^(1|true|yes)$/i.test(String(value))) return true;
  if (value === false || /^(0|false|no)$/i.test(String(value))) return false;
  throw new Error(`${fieldName} 必须是 true/false、1/0 或 yes/no。`);
}

function integerValue(value, fallback, minimum, maximum, fieldName) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${fieldName} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return parsed;
}

function configFromUrl(rawUrl, profileName) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`连接 ${profileName} 的 url 不是有效地址。`);
  }
  if (!["mysql:", "mysql2:"].includes(url.protocol)) {
    throw new Error(`连接 ${profileName} 的 url 必须使用 mysql:// 协议。`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !url.username || !database) {
    throw new Error(`连接 ${profileName} 的 url 必须包含主机、用户和数据库名。`);
  }
  return {
    host: url.hostname,
    port: url.port ? integerValue(url.port, 3306, 1, 65535, `${profileName}.port`) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

function normalizeProfile(name, input, defaults) {
  if (!CONNECTION_NAME_PATTERN.test(name)) {
    throw new Error(`连接名称 ${name} 不合法，只能使用字母、数字、下划线和连字符。`);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`连接 ${name} 的配置必须是对象。`);
  }

  const base = input.url
    ? configFromUrl(input.url, name)
    : {
        host: input.host,
        port: integerValue(input.port, 3306, 1, 65535, `${name}.port`),
        user: input.user,
        password: input.password ?? "",
        database: input.database,
      };
  const missing = ["host", "user", "database"].filter((field) => !base[field]);
  if (missing.length > 0) {
    throw new Error(`连接 ${name} 缺少配置：${missing.join(", ")}。`);
  }

  return {
    ...base,
    connectTimeout: integerValue(input.connectTimeoutMs, defaults.connectTimeout, 1000, 120000, `${name}.connectTimeoutMs`),
    connectionLimit: integerValue(input.connectionLimit, defaults.connectionLimit, 1, 10, `${name}.connectionLimit`),
    allowUpdate: booleanValue(input.allowUpdate, false, `${name}.allowUpdate`),
    ssl: booleanValue(input.ssl, defaults.ssl, `${name}.ssl`)
      ? {
          rejectUnauthorized: booleanValue(
            input.sslRejectUnauthorized,
            defaults.sslRejectUnauthorized,
            `${name}.sslRejectUnauthorized`,
          ),
        }
      : undefined,
  };
}

function singleConnectionInput(env) {
  if (env.MYSQL_URL) return { url: env.MYSQL_URL };
  return {
    host: env.MYSQL_HOST,
    port: env.MYSQL_PORT,
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
  };
}

export function loadConnectionRegistry(env = process.env, options = {}) {
  const defaults = {
    connectTimeout: integerFromEnv(env, "MYSQL_CONNECT_TIMEOUT_MS", 10000, 1000, 120000),
    connectionLimit: integerFromEnv(env, "MYSQL_CONNECTION_LIMIT", 2, 1, 10),
    ssl: booleanValue(env.MYSQL_SSL, false, "MYSQL_SSL"),
    sslRejectUnauthorized: booleanValue(env.MYSQL_SSL_REJECT_UNAUTHORIZED, true, "MYSQL_SSL_REJECT_UNAUTHORIZED"),
  };
  const maxProfiles = integerFromEnv(env, "MYSQL_MAX_PROFILES", 10, 1, 50);

  let rawProfiles;
  let requestedDefault = env.MYSQL_DEFAULT_CONNECTION;
  const managed = options.managedProfiles === undefined
    ? (env === process.env || env.MYSQL_CONFIG_FILE ? readManagedProfiles(env, options) : null)
    : options.managedProfiles;
  if (managed) {
    rawProfiles = managed.profiles;
    requestedDefault = managed.defaultConnection;
  } else if (env.MYSQL_CONNECTIONS_JSON) {
    try {
      rawProfiles = JSON.parse(env.MYSQL_CONNECTIONS_JSON);
    } catch {
      throw new Error("MYSQL_CONNECTIONS_JSON 不是有效的 JSON。配置内容不会被输出。");
    }
    if (!rawProfiles || typeof rawProfiles !== "object" || Array.isArray(rawProfiles)) {
      throw new Error("MYSQL_CONNECTIONS_JSON 顶层必须是以连接名称为键的对象。");
    }
  } else {
    rawProfiles = { default: singleConnectionInput(env) };
  }

  const entries = Object.entries(rawProfiles);
  if (entries.length === 0) throw new Error("至少需要配置一个 MySQL 连接。");
  if (entries.length > maxProfiles) {
    throw new Error(`MySQL 连接数量超过 MYSQL_MAX_PROFILES=${maxProfiles} 的限制。`);
  }

  const profiles = new Map(entries.map(([name, profile]) => [name, normalizeProfile(name, profile, defaults)]));
  const defaultConnection = requestedDefault || (profiles.size === 1 ? entries[0][0] : null);
  if (defaultConnection && !profiles.has(defaultConnection)) {
    throw new Error(`MYSQL_DEFAULT_CONNECTION 指向不存在的连接 ${defaultConnection}。`);
  }

  return { profiles, defaultConnection };
}

export function resolveConnectionName(registry, requestedName) {
  const name = requestedName || registry.defaultConnection;
  if (!name) {
    throw new Error(`配置了多个 MySQL 连接，请指定 connection。可选值：${[...registry.profiles.keys()].join(", ")}。`);
  }
  if (!registry.profiles.has(name)) {
    throw new Error(`未知 MySQL 连接 ${name}。可选值：${[...registry.profiles.keys()].join(", ")}。`);
  }
  return name;
}
