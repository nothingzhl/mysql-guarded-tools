import assert from "node:assert/strict";
import test from "node:test";
import { loadConnectionRegistry, resolveConnectionName } from "../mcp/config.mjs";

test("兼容原有单连接环境变量", () => {
  const registry = loadConnectionRegistry({
    MYSQL_HOST: "127.0.0.1",
    MYSQL_USER: "readonly",
    MYSQL_PASSWORD: "secret",
    MYSQL_DATABASE: "app",
  });
  assert.deepEqual([...registry.profiles.keys()], ["default"]);
  assert.equal(registry.defaultConnection, "default");
  assert.equal(resolveConnectionName(registry), "default");
});

test("解析多个命名连接和默认连接", () => {
  const registry = loadConnectionRegistry({
    MYSQL_CONNECTIONS_JSON: JSON.stringify({
      orders: { url: "mysql://reader:secret@db.example:3306/orders", connectionLimit: 2, allowUpdate: true },
      analytics: { host: "analytics.example", user: "reader", password: "secret", database: "dw" },
    }),
    MYSQL_DEFAULT_CONNECTION: "orders",
  });
  assert.deepEqual([...registry.profiles.keys()], ["orders", "analytics"]);
  assert.equal(resolveConnectionName(registry), "orders");
  assert.equal(resolveConnectionName(registry, "analytics"), "analytics");
  assert.equal(registry.profiles.get("orders").allowUpdate, true);
  assert.equal(registry.profiles.get("analytics").allowUpdate, false);
});

test("多个连接没有默认值时必须显式选择", () => {
  const registry = loadConnectionRegistry({
    MYSQL_CONNECTIONS_JSON: JSON.stringify({
      orders: { url: "mysql://reader:secret@db.example:3306/orders" },
      analytics: { url: "mysql://reader:secret@db.example:3306/analytics" },
    }),
  });
  assert.throws(() => resolveConnectionName(registry), /请指定 connection/);
  assert.throws(() => resolveConnectionName(registry, "missing"), /未知 MySQL 连接/);
});

test("限制连接配置数量并校验名称", () => {
  assert.throws(
    () => loadConnectionRegistry({
      MYSQL_CONNECTIONS_JSON: JSON.stringify({
        "invalid name": { url: "mysql://reader:secret@db.example:3306/app" },
      }),
    }),
    /连接名称/,
  );
  assert.throws(
    () => loadConnectionRegistry({
      MYSQL_CONNECTIONS_JSON: JSON.stringify({
        one: { url: "mysql://reader:secret@db.example:3306/one" },
        two: { url: "mysql://reader:secret@db.example:3306/two" },
      }),
      MYSQL_MAX_PROFILES: "1",
    }),
    /超过 MYSQL_MAX_PROFILES/,
  );
});
