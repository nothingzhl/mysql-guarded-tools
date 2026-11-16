import { existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或更新版本。');
if(process.platform !== 'darwin') throw new Error('此本地插件的连接与密码管理要求 macOS。');
const dependency = new URL('../node_modules/mysql2/promise.js', import.meta.url);
const helper = new URL('../build/keychain-helper', import.meta.url);
if (!existsSync(dependency) || !existsSync(helper)) {
  mkdirSync(new URL('../build/', import.meta.url), {recursive:true, mode:0o700});
  const lock = new URL('../build/setup.lock', import.meta.url);
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch { throw new Error('插件依赖安装正在进行；若确认没有安装进程，可删除 build/setup.lock 后重试。'); }
  try {
    if(!existsSync(dependency)) {
      console.error('首次启动：根据锁文件安装 MySQL 依赖（需要网络）。');
      const r=spawnSync('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:root,stdio:['ignore',2,2],timeout:180000});
      if(r.status!==0)throw new Error('依赖安装失败，请在插件目录手动执行 npm ci --ignore-scripts。');
    }
    if(!existsSync(helper)) {
      const r=spawnSync(process.execPath,['scripts/setup.mjs'],{cwd:root,stdio:['ignore',2,2],timeout:180000});
      if(r.status!==0)throw new Error('钥匙串组件编译失败，请安装 Apple Command Line Tools 后重试。');
    }
  } finally { closeSync(fd);unlinkSync(lock); }
}
await import('../mcp/server.mjs');
