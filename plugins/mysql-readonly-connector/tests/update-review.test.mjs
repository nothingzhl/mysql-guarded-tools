import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_REVIEW_TTL_MS, UpdateReviewStore } from "../mcp/update-review.mjs";

const payload = {
  connection: "staging",
  sql: "UPDATE users SET status = ? WHERE tenant_id = ?",
  params: ["disabled", 42],
};

test("审查令牌只能成功使用一次", () => {
  const store = new UpdateReviewStore();
  const review = store.issue(payload, 11);
  assert.equal(store.consume(review.token, payload).affectedRows, 11);
  assert.throws(() => store.consume(review.token, payload), /不存在、已过期或已经使用/);
});

test("审查令牌绑定连接、SQL 和参数", () => {
  for (const changed of [
    { ...payload, connection: "production" },
    { ...payload, sql: "UPDATE users SET status = ? WHERE tenant_id = ? AND active = 1" },
    { ...payload, params: ["enabled", 42] },
  ]) {
    const store = new UpdateReviewStore();
    const review = store.issue(payload, 11);
    assert.throws(() => store.consume(review.token, changed), /不匹配/);
  }
});

test("审查令牌五分钟后过期", () => {
  let now = 1_000;
  const store = new UpdateReviewStore({ now: () => now });
  const review = store.issue(payload, 11);
  now += UPDATE_REVIEW_TTL_MS;
  assert.throws(() => store.consume(review.token, payload), /不存在、已过期或已经使用/);
  assert.equal(store.size(), 0);
});
