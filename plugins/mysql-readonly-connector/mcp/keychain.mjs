import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function createSystemKeychain({ run = execFileSync, platform = process.platform } = {}) {
  function invoke(action, name, password) {
    if (platform !== 'darwin') throw new Error('本地密码管理目前只支持 macOS 钥匙串。');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('连接名称不合法。');
    try {
      const output = run(fileURLToPath(new URL('../build/keychain-helper', import.meta.url)), [], {
        input: JSON.stringify({ action, name, ...(password === undefined ? {} : { password }) }),
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000, maxBuffer: 65536,
      });
      return JSON.parse(output);
    } catch { throw new Error(`无法${{get:'读取',set:'保存',exists:'检查',delete:'删除'}[action]}连接 ${name} 的钥匙串条目，请检查钥匙串授权及运行 npm run setup。`); }
  }
  return {
    get: name => invoke('get', name).password,
    has: name => invoke('exists', name).exists,
    set(name, password) { if (typeof password !== 'string' || !password) throw new Error('密码不能为空。'); invoke('set', name, password); },
    delete: name => { invoke('delete', name); },
  };
}
export const systemKeychain = createSystemKeychain();
