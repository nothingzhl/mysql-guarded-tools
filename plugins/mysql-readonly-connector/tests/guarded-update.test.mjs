import assert from "node:assert/strict";
import test from "node:test";
import { runGuardedUpdateTransaction } from "../mcp/guarded-update.mjs";

function fakeConnection({ affectedRows = 10, changedRows = affectedRows, executeError, readonlyError } = {}) {
  const calls = [];
  let destroyed = false;
  return {
    calls,
    get destroyed() {
      return destroyed;
    },
    async query(input) {
      const sql = typeof input === "string" ? input : input.sql;
      calls.push(sql);
      if (sql === "SET SESSION TRANSACTION READ ONLY" && readonlyError) throw readonlyError;
      if (sql.startsWith("SELECT 1 FROM")) return [[], []];
      if (sql.startsWith("SELECT t.ENGINE")) return [[{engine:"InnoDB",table_type:"BASE TABLE",trigger_count:0,trigger_visible:1}],[]];
      if (typeof input === "object") {
        if (executeError) throw executeError;
        return [{ affectedRows, changedRows, warningStatus: 0 }];
      }
      return [[], []];
    },
    async beginTransaction() {
      calls.push("BEGIN");
    },
    async commit() {
      calls.push("COMMIT");
    },
    async rollback() {
      calls.push("ROLLBACK");
    },
    destroy() {
      destroyed = true;
      calls.push("DESTROY");
    },
  };
}

const base = {
  sql: "UPDATE users SET status = ? WHERE tenant_id = ?",
  params: ["disabled", 42],
  timeoutMs: 30_000,
};

test("影响 10 条时直接提交", async () => {
  const connection = fakeConnection({ affectedRows: 10, changedRows: 8 });
  const result = await runGuardedUpdateTransaction({ connection, ...base });
  assert.equal(result.status, "committed");
  assert.equal(result.affectedRows, 10);
  assert.equal(result.changedRows, 8);
  assert.ok(connection.calls.includes("COMMIT"));
  assert.ok(!connection.calls.includes("ROLLBACK"));
  assert.equal(connection.calls.at(-1), "SET SESSION TRANSACTION READ ONLY");
});

test("影响 11 条时回滚并要求审查", async () => {
  const connection = fakeConnection({ affectedRows: 11 });
  const result = await runGuardedUpdateTransaction({ connection, ...base });
  assert.equal(result.status, "review_required");
  assert.equal(result.changedSinceReview, false);
  assert.ok(connection.calls.includes("ROLLBACK"));
  assert.ok(!connection.calls.includes("COMMIT"));
});

test("审查后影响行数相同才提交", async () => {
  const connection = fakeConnection({ affectedRows: 11 });
  const result = await runGuardedUpdateTransaction({
    connection,
    ...base,
    approvedAffectedRows: 11,
  });
  assert.equal(result.status, "committed");
  assert.equal(result.reviewed, true);
  assert.ok(connection.calls.includes("COMMIT"));
});

test("审查后影响行数发生任何变化都会再次回滚", async () => {
  for (const affectedRows of [9, 12]) {
    const connection = fakeConnection({ affectedRows });
    const result = await runGuardedUpdateTransaction({
      connection,
      ...base,
      approvedAffectedRows: 11,
    });
    assert.equal(result.status, "review_required");
    assert.equal(result.changedSinceReview, true);
    assert.ok(connection.calls.includes("ROLLBACK"));
    assert.ok(!connection.calls.includes("COMMIT"));
  }
});

test("执行异常时回滚并恢复只读会话", async () => {
  const failure = new Error("database failure");
  const connection = fakeConnection({ executeError: failure });
  await assert.rejects(
    runGuardedUpdateTransaction({ connection, ...base }),
    /database failure/,
  );
  assert.ok(connection.calls.includes("ROLLBACK"));
  assert.equal(connection.calls.at(-1), "SET SESSION TRANSACTION READ ONLY");
});

test("无法恢复只读会话时销毁连接", async () => {
  const connection = fakeConnection({ affectedRows: 10, readonlyError: new Error("readonly failure") });
  const result = await runGuardedUpdateTransaction({ connection, ...base });
  assert.equal(result.status, "committed");
  assert.equal(result.connectionRecycled, true);
  assert.equal(connection.destroyed, true);
});
