import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import test from "node:test";

function startServer(extraEnv = {}) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "mysql-mcp-smoke-"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "MYSQL_URL" || key.startsWith("MYSQL_")) delete env[key];
  }
  const child = spawn(process.execPath, ["mcp/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...env,
      MYSQL_CONFIG_FILE: join(temporaryDirectory, "connections.json"),
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = [];
  lines.on("line", (line) => pending.shift()?.resolve(JSON.parse(line)));
  child.once("error", (error) => pending.shift()?.reject(error));

  return {
    child,
    cleanup() {
      child.kill("SIGTERM");
      rmSync(temporaryDirectory, { recursive: true, force: true });
    },
    request(message) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("MCP 响应超时")), 3000);
        pending.push({
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    },
  };
}

test("MCP 服务可初始化、列出工具并安全报告缺少配置", async (context) => {
  const server = startServer();
  context.after(() => server.cleanup());

  const initialized = await server.request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  assert.equal(initialized.result.serverInfo.name, "mysql-readonly-connector");

  const listed = await server.request({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    [
      "mysql_open_config_window",
      "mysql_list_connections",
      "mysql_save_connection",
      "mysql_delete_connection",
      "mysql_set_default_connection",
      "mysql_query",
      "mysql_update",
      "mysql_list_tables",
      "mysql_describe_table",
      "mysql_health_check",
    ],
  );

  const called = await server.request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "mysql_health_check", arguments: {} },
  });
  assert.equal(called.result.isError, true);
  assert.match(called.result.content[0].text, /缺少配置/);

  const modification = await server.request({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "mysql_query", arguments: { sql: "DELETE FROM users" } },
  });
  assert.equal(modification.result.isError, true);
  assert.match(modification.result.content[0].text, /仅支持|不支持修改类 SQL/);

  const empty = await server.request({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "mysql_list_connections", arguments: {} },
  });
  assert.equal(empty.result.isError, false);
  assert.match(empty.result.content[0].text, /native_mcp/);
  assert.match(empty.result.content[0].text, /"connections": \[\]/);
});

test("UPDATE 未按连接启用时会在访问数据库前拒绝", async (context) => {
  const server = startServer({
    MYSQL_CONNECTIONS_JSON: JSON.stringify({
      staging: {
        url: "mysql://operator:secret@127.0.0.1:3306/staging",
        allowUpdate: false,
      },
    }),
  });
  context.after(() => server.cleanup());

  const called = await server.request({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "mysql_update",
      arguments: { sql: "UPDATE users SET status = ? WHERE id = ?", params: ["disabled", 1] },
    },
  });
  assert.equal(called.result.isError, true);
  assert.match(called.result.content[0].text, /尚未在连接设置中启用 UPDATE/);
});

test("MCP 服务可以列出多个命名连接且不泄露凭据", async (context) => {
  const server = startServer({
    MYSQL_CONNECTIONS_JSON: JSON.stringify({
      orders: { url: "mysql://orders_user:orders_secret@127.0.0.1:3306/orders" },
      analytics: { url: "mysql://analytics_user:analytics_secret@127.0.0.1:3306/analytics" },
    }),
    MYSQL_DEFAULT_CONNECTION: "orders",
  });
  context.after(() => server.cleanup());

  const listed = await server.request({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "mysql_list_connections", arguments: {} },
  });
  assert.equal(listed.result.isError, false);
  assert.match(listed.result.content[0].text, /orders/);
  assert.match(listed.result.content[0].text, /analytics/);
  assert.doesNotMatch(listed.result.content[0].text, /orders_secret|analytics_secret/);
  assert.match(listed.result.content[0].text, /legacy_environment/);
});

test("删除连接必须显式确认", async (context) => {
  const server = startServer();
  context.after(() => server.cleanup());

  const deleted = await server.request({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "mysql_delete_connection", arguments: { name: "staging", confirm: false } },
  });
  assert.equal(deleted.result.isError, true);
  assert.match(deleted.result.content[0].text, /明确确认/);
});
