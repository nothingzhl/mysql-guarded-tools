import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ConfigStore,defaultConfigPath} from '../mcp/config-store.mjs';
function fixture(t,env={}){const dir=mkdtempSync(join(tmpdir(),'mysql-env-store-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return new ConfigStore({configPath:join(dir,'connections.json'),env})}
const input={host:'db.example',user:'reader',database:'app'};
test('配置只保存环境引用，密码值不落盘或出现在列表',t=>{
 const secret='environment-fixture-value';const store=fixture(t,{MYSQL_PASSWORD:secret});store.saveConnection('one',input);
 assert.ok(!readFileSync(store.configPath,'utf8').includes(secret));assert.ok(!JSON.stringify(store.publicState()).includes(secret));assert.equal(store.resolvedProfiles().profiles.one.password,secret);
});
test('多连接密码从 JSON 名称分别解析',t=>{
 const store=fixture(t,{MYSQL_PASSWORDS_JSON:JSON.stringify({first:'first-value',second:'second-value'})});
 for(const [name,key]of [['one','first'],['two','second']])store.saveConnection(name,{...input,passwordSource:'MYSQL_PASSWORDS_JSON',passwordKey:key});
 assert.equal(store.resolvedProfiles().profiles.one.password,'first-value');assert.equal(store.resolvedProfiles().profiles.two.password,'second-value');
});
test('未设置密码可保存引用，解析结果标明未配置',t=>{
 const store=fixture(t);store.saveConnection('one',input);assert.equal(store.publicState().connections[0].passwordConfigured,false);assert.equal(store.resolvedProfiles().profiles.one.passwordConfigured,false);
});
test('删除只删除配置，外部环境不受影响',t=>{
 const env={MYSQL_PASSWORD:'fixture-value'},store=fixture(t,env);store.saveConnection('one',input);store.saveConnection('two',input);store.deleteConnection('one');assert.equal(store.read().defaultConnection,'two');assert.equal(env.MYSQL_PASSWORD,'fixture-value');
});
test('旧版无密码引用配置仍能列出，不触碰钥匙串',t=>{
 const store=fixture(t,{MYSQL_PASSWORD:'fixture-value'});store.write({version:1,defaultConnection:'old',connections:{old:input}});assert.equal(store.publicState().connections[0].passwordSource,'MYSQL_PASSWORD');assert.equal(store.resolvedProfiles().profiles.old.password,'fixture-value');
});
test('配置路径在各平台可选择，显式路径优先',()=>{
 assert.equal(defaultConfigPath({MYSQL_CONFIG_FILE:'/custom/path'},'linux'),'/custom/path');assert.equal(defaultConfigPath({XDG_CONFIG_HOME:'/config'},'linux'),join('/config','mysql-readonly-connector','connections.json'));assert.equal(defaultConfigPath({APPDATA:'/appdata'},'win32'),join('/appdata','mysql-readonly-connector','connections.json'));
});
