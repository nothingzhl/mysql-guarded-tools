import assert from "node:assert/strict";
import test from "node:test";
import { promptForPassword } from "../mcp/native-password.mjs";

test("原生密码弹窗使用隐藏输入且只返回密码", async () => {
  let invocation;
  const password = await promptForPassword("staging", {
    platform: "darwin",
    run: async (...args) => {
      invocation = args;
      return { stdout: "local-secret\n", stderr: "" };
    },
  });
  assert.equal(password, "local-secret");
  assert.equal(invocation[0], "/usr/bin/osascript");
  assert.match(invocation[1][1], /with hidden answer/);
  assert.match(invocation[1][1], /staging/);
  assert.doesNotMatch(invocation[1][1], /local-secret/);
});

test("取消原生密码弹窗不会保存", async () => {
  await assert.rejects(
    promptForPassword("staging", {
      platform: "darwin",
      run: async () => {
        const error = new Error("execution error: User canceled. (-128)");
        error.stderr = "User canceled. (-128)";
        throw error;
      },
    }),
    /已取消密码输入/,
  );
});

test("拒绝空密码和非 macOS 环境", async () => {
  await assert.rejects(
    promptForPassword("staging", {
      platform: "darwin",
      run: async () => ({ stdout: "\n", stderr: "" }),
    }),
    /密码不能为空/,
  );
  await assert.rejects(promptForPassword("staging", { platform: "linux" }), /只支持 macOS/);
});
