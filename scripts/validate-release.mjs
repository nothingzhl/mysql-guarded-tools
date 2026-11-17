import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
const root=resolve(new URL('..',import.meta.url).pathname);
const plugin=join(root,'plugins/mysql-readonly-connector');
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const marketplace=json(join(root,'.agents/plugins/marketplace.json'));
assert.equal(marketplace.name,'mysql-guarded-tools');
for(const entry of marketplace.plugins){assert.ok(entry.source.path.startsWith('./'));assert.equal(resolve(root,entry.source.path),plugin);assert.equal(entry.policy.installation,'AVAILABLE');assert.equal(entry.policy.authentication,'ON_INSTALL');assert.ok(entry.category)}
const manifest=json(join(plugin,'.codex-plugin/plugin.json')),pkg=json(join(plugin,'package.json')),lock=json(join(plugin,'package-lock.json'));
assert.equal(manifest.name,pkg.name);assert.equal(pkg.version,manifest.version);assert.equal(pkg.version,lock.version);assert.equal(pkg.version,lock.packages[''].version);assert.equal(pkg.version,json(join(root,'package.json')).version);assert.equal(manifest.requires_local_executor,true);
const mcp=json(join(plugin,'.mcp.json')).mcpServers['mysql-readonly'];assert.deepEqual(mcp.args,['./scripts/start.mjs']);assert.equal(mcp.command,'node');assert.ok(mcp.env_vars.includes('MYSQL_PASSWORDS_JSON'));
for(const legacy of ['mcp/keychain.mjs','mcp/native-password.mjs','native/keychain.swift'])assert.ok(!existsSync(join(plugin,legacy)),`Unexpected credential backend: ${legacy}`);
for(const path of ['scripts/start.mjs','scripts/setup.mjs','mcp/environment-passwords.mjs','ui/config.html','skills/mysql-readonly/SKILL.md'])assert.ok(existsSync(join(plugin,path)));
let count=0;
function scan(directory){for(const entry of readdirSync(directory)){if(['.git','node_modules','build'].includes(entry))continue;const path=join(directory,entry),stat=lstatSync(path);assert.ok(!stat.isSymbolicLink(),`Do not ship symlinks: ${path}`);if(stat.isDirectory()){scan(path);continue}const name=relative(root,path);assert.ok(!/(^|\/)(\.env($|\.)|connections\.json)|\.(log|zip|tar\.gz)$/.test(name),`Local artifact: ${name}`);if(name=== 'scripts/validate-release.mjs')continue;const text=readFileSync(path,'utf8');assert.ok(!/\/Users\/[^/\s]+|qa-my-asc|qa-dev|qa-my-|aliyuncs\.com|127\.0\.0\.1:60836|127\.0\.0\.1:61696/.test(text),`Private configuration or machine path: ${name}`);assert.ok(!/gh[pousr]_[A-Za-z0-9]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text),`Credential-like material: ${name}`);count++}}
scan(root);console.log(`PASS: marketplace, versions, startup wiring and ${count} distributable files checked. Heuristic scan is not a secret-discovery guarantee.`);
