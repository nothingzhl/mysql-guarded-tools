import assert from "node:assert/strict";
import test from "node:test";
import { BoundedExecutor } from "../mcp/bounded-executor.mjs";

test("并发数和等待队列都有硬上限", async () => {
  const executor = new BoundedExecutor({ maxActive: 1, maxQueued: 1, queueTimeoutMs: 1000 });
  let releaseFirst;
  const first = executor.run(() => new Promise((resolve) => { releaseFirst = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const second = executor.run(async () => "second");
  await assert.rejects(executor.run(async () => "third"), /等待队列已满/);
  assert.deepEqual(executor.snapshot(), { active: 1, queued: 1 });
  releaseFirst("first");
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  executor.close();
});

test("关闭执行器会清理并拒绝排队任务", async () => {
  const executor = new BoundedExecutor({ maxActive: 1, maxQueued: 2, queueTimeoutMs: 1000 });
  let releaseFirst;
  const first = executor.run(() => new Promise((resolve) => { releaseFirst = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const queued = executor.run(async () => "queued");
  executor.close();
  await assert.rejects(queued, /正在关闭/);
  releaseFirst("done");
  assert.equal(await first, "done");
});
