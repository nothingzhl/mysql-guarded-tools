import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONNECTION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PROMPT_TIMEOUT_MS = 2 * 60 * 1000;

export async function promptForPassword(
  connectionName,
  { platform = process.platform, run = execFileAsync } = {},
) {
  if (platform !== "darwin") {
    throw new Error("原生密码输入目前只支持 macOS。");
  }
  if (!CONNECTION_NAME_PATTERN.test(connectionName)) {
    throw new Error("连接名称不合法，无法打开密码输入框。");
  }

  const script = [
    `display dialog "请输入 MySQL 连接 ${connectionName} 的密码。密码将直接保存到 macOS 钥匙串，不会发送到 Codex 对话。"`,
    'default answer "" with hidden answer',
    'buttons {"取消", "保存"} default button "保存" cancel button "取消"',
    'with title "MySQL Guarded Connector"',
  ].join(" ") + "\nreturn text returned of result";

  let stdout;
  try {
    ({ stdout } = await run("/usr/bin/osascript", ["-e", script], {
      encoding: "utf8",
      timeout: PROMPT_TIMEOUT_MS,
      maxBuffer: 4096,
      windowsHide: false,
    }));
  } catch (error) {
    const message = `${error?.stderr ?? ""} ${error?.message ?? ""}`;
    if (/User canceled|-128/i.test(message)) {
      throw new Error("已取消密码输入，连接没有保存。");
    }
    if (error?.killed || error?.signal === "SIGTERM") {
      throw new Error("密码输入等待超过 2 分钟，连接没有保存。");
    }
    throw new Error("无法打开 macOS 密码输入框，连接没有保存。");
  }

  const password = String(stdout ?? "").replace(/[\r\n]+$/, "");
  if (!password) throw new Error("密码不能为空，连接没有保存。");
  return password;
}
