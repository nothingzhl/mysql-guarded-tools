import assert from "node:assert/strict";
import test from "node:test";
import { validateIdentifier, validateReadOnlySql, validateUpdateSql } from "../mcp/sql-policy.mjs";

test("允许常见只读查询", () => {
  assert.equal(validateReadOnlySql("SELECT * FROM users LIMIT 10;"), "SELECT * FROM users LIMIT 10");
  assert.equal(validateReadOnlySql("SHOW TABLES"), "SHOW TABLES");
  assert.equal(validateReadOnlySql("DESC users"), "DESC users");
  assert.equal(validateReadOnlySql("EXPLAIN SELECT * FROM users"), "EXPLAIN SELECT * FROM users");
  assert.equal(
    validateReadOnlySql("WITH recent AS (SELECT id FROM users) SELECT * FROM recent"),
    "WITH recent AS (SELECT id FROM users) SELECT * FROM recent",
  );
});

test("字符串里的写关键字不造成误判", () => {
  assert.equal(
    validateReadOnlySql("SELECT 'DELETE FROM users' AS sample"),
    "SELECT 'DELETE FROM users' AS sample",
  );
});

test("拒绝所有常见修改语句", () => {
  for (const sql of [
    "INSERT INTO users(id) VALUES (1)",
    "UPDATE users SET name = 'x'",
    "DELETE FROM users",
    "CREATE TABLE demo(id INT)",
    "ALTER TABLE users ADD COLUMN x INT",
    "DROP TABLE users",
    "TRUNCATE TABLE users",
    "WITH target AS (SELECT 1) UPDATE users SET name = 'x'",
  ]) {
    assert.throws(() => validateReadOnlySql(sql));
  }
});

test("拒绝多语句、注释和文件写入", () => {
  assert.throws(() => validateReadOnlySql("SELECT 1; SELECT 2"));
  assert.throws(() => validateReadOnlySql("SELECT 1 -- hidden"));
  assert.throws(() => validateReadOnlySql("SELECT 1 /* hidden */"));
  assert.throws(() => validateReadOnlySql("SELECT * INTO OUTFILE '/tmp/data' FROM users"));
  assert.throws(() => validateReadOnlySql("SELECT id INTO @last_id FROM users LIMIT 1"));
  assert.throws(() => validateReadOnlySql("SELECT @counter := @counter + 1"));
});

test("拒绝可用于延迟、锁和读文件的函数", () => {
  assert.throws(() => validateReadOnlySql("SELECT SLEEP(10)"));
  assert.throws(() => validateReadOnlySql("SELECT GET_LOCK('x', 10)"));
  assert.throws(() => validateReadOnlySql("SELECT LOAD_FILE('/etc/passwd')"));
  assert.throws(() => validateReadOnlySql("SELECT * FROM users FOR SHARE"));
});

test("只允许带外层 WHERE 的单条 UPDATE", () => {
  assert.equal(
    validateUpdateSql("UPDATE users SET status = ? WHERE id = ?;"),
    "UPDATE users SET status = ? WHERE id = ?",
  );
  assert.equal(
    validateUpdateSql("UPDATE users SET status = CASE WHEN id = ? THEN ? ELSE status END WHERE tenant_id = ?"),
    "UPDATE users SET status = CASE WHEN id = ? THEN ? ELSE status END WHERE tenant_id = ?",
  );
  assert.throws(() => validateUpdateSql("UPDATE users SET status = 'disabled'"), /WHERE/);
  assert.throws(
    () => validateUpdateSql("UPDATE users SET status = (SELECT status FROM archive WHERE id = 1)"),
    /WHERE/,
  );
});

test("UPDATE 拒绝其他写操作、多语句、注释和危险函数", () => {
  for (const sql of [
    "INSERT INTO users(id) VALUES (1)",
    "DELETE FROM users WHERE id = 1",
    "DROP TABLE users",
    "UPDATE users SET status = 'x' WHERE id = 1; DELETE FROM users WHERE id = 2",
    "UPDATE users SET status = 'x' WHERE id = 1 -- hidden",
    "UPDATE users SET status = SLEEP(10) WHERE id = 1",
  ]) {
    assert.throws(() => validateUpdateSql(sql));
  }
});

test("校验数据库对象名称", () => {
  assert.equal(validateIdentifier("app_db", "database"), "app_db");
  assert.equal(validateIdentifier("order$archive", "table"), "order$archive");
  assert.throws(() => validateIdentifier("app-db", "database"));
  assert.throws(() => validateIdentifier("users; DROP TABLE users", "table"));
});
