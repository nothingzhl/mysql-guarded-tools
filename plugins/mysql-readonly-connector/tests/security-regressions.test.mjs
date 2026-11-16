import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../mcp/config-store.mjs';
import { createSystemKeychain } from '../mcp/keychain.mjs';
import { saveManagedConnection, setManagedDefaultConnection } from '../mcp/connection-manager.mjs';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'mysql-release-test-')),secrets=new Map();const keychain={get:n=>secrets.get(n)??null,set:(n,v)=>secrets.set(n,v),delete:n=>secrets.delete(n)};const store=new ConfigStore({configPath:join(dir,'connections.json'),keychain});t.after(()=>rmSync(dir,{recursive:true,force:true}));return {store,secrets};}
const args={name:'test',host:'db.example',user:'operator',database:'app'};
const input={host:args.host,user:args.user,database:args.database,password:'old-test-secret'};
const changed=async()=>{};
test('钥匙串密码通过 stdin 传递，参数与错误中均不含密码',()=>{
 let seen;const keychain=createSystemKeychain({platform:'darwin',run:(file,argv,options)=>{seen={file,argv,options};return '{"ok":true}'}});
 keychain.set('test','pipe-only-secret');assert.deepEqual(seen.argv,[]);assert.equal(JSON.parse(seen.options.input).password,'pipe-only-secret');
 const failing=createSystemKeychain({platform:'darwin',run:()=>{throw Error('pipe-only-secret')}});assert.throws(()=>failing.set('test','pipe-only-secret'),e=>!e.message.includes('pipe-only-secret'));
});
test('新增失败移除新增密码，编辑失败恢复旧密码',async t=>{
 const {store,secrets}=fixture(t);const originalWrite=store.write.bind(store);store.write=()=>{throw Error('simulated disk failure')};
 await assert.rejects(saveManagedConnection({store,args,promptPassword:async()=>'new-secret',onChanged:changed}),/disk failure/);assert.equal(secrets.has('test'),false);assert.equal(store.exists(),false);
 store.write=originalWrite;store.saveConnection('test',input);const before=readFileSync(store.configPath,'utf8');store.write=()=>{throw Error('simulated disk failure')};
 await assert.rejects(saveManagedConnection({store,args:{name:'test',change_password:true},promptPassword:async()=>'new-secret',onChanged:changed}),/disk failure/);assert.equal(secrets.get('test'),'old-test-secret');assert.equal(readFileSync(store.configPath,'utf8'),before);
});
test('复制来源密码时保存失败不会遗留目标条目',async t=>{
 const {store,secrets}=fixture(t);store.saveConnection('source',input);store.write=()=>{throw Error('simulated disk failure')};
 await assert.rejects(saveManagedConnection({store,args:{...args,copy_password_from:'source'},promptPassword:async()=>{throw Error('should not prompt')},onChanged:changed}),/disk failure/);assert.equal(secrets.has('test'),false);assert.equal(secrets.get('source'),'old-test-secret');
});
test('取消安全密码输入不会保存，且释放跨进程锁',async t=>{
 const {store}=fixture(t);await assert.rejects(saveManagedConnection({store,args,promptPassword:async()=>{throw Error('cancelled')},onChanged:changed}),/cancelled/);assert.equal(store.exists(),false);assert.equal(existsSync(store.configPath+'.lock'),false);
});
test('不同 ConfigStore 实例不能交叉覆盖正在修改的配置',async t=>{
 const {store}=fixture(t);const other=new ConfigStore({configPath:store.configPath,keychain:store.keychain});let release;let entered;const ready=new Promise(r=>entered=r);const gate=new Promise(r=>release=r);
 const first=saveManagedConnection({store,args,promptPassword:async()=>{entered();await gate;return 'secret'},onChanged:changed});await ready;
 try{await assert.rejects(setManagedDefaultConnection({store:other,name:null,onChanged:changed}),/另一进程/)}finally{release()}
 await first;assert.equal(store.read().defaultConnection,'test');
});
test('运行时刷新失败明确告知已保存，避免诱发重复提交',async t=>{
 const {store}=fixture(t);const result=await saveManagedConnection({store,args,promptPassword:async()=>'secret',onChanged:async()=>{throw Error('pool failure')}});assert.match(result.runtime_warning,/已保存/);assert.equal(store.exists(),true);
});
test('删除时磁盘失败恢复钥匙串且保留连接配置',t=>{
 const {store,secrets}=fixture(t);store.saveConnection('test',input);store.write=()=>{throw Error('disk failure')};assert.throws(()=>store.deleteConnection('test'),/disk failure/);assert.equal(secrets.get('test'),'old-test-secret');assert.ok(store.read().connections.test);
});
test('列表只检查钥匙串存在性，不读取密码；拒绝保留对象键',t=>{
 const {store}=fixture(t);store.saveConnection('test',input);store.keychain.has=()=>true;store.keychain.get=()=>{throw Error('must not read password')};assert.equal(store.publicState().connections[0].passwordConfigured,true);
 for(const name of ['__proto__','constructor','prototype'])assert.throws(()=>store.saveConnection(name,input),/连接名称/);
});


test('拒绝非事务引擎、视图、触发器、多表与别名 UPDATE',async()=>{
 const {verifyUpdateTarget}=await import('../mcp/update-target.mjs');
 for(const [engine,table_type,trigger_count]of [['MyISAM','BASE TABLE',0],['InnoDB','VIEW',0],['InnoDB','BASE TABLE',1]]){
  const connection={query:async q=>q.sql.startsWith('SELECT 1 FROM')?[[]]:[[{engine,table_type,trigger_count,trigger_visible:1}]]};
  await assert.rejects(verifyUpdateTarget(connection,'UPDATE users SET active=1 WHERE id=1',1000),/拒绝/);
 }
 for(const sql of ['UPDATE users u SET active=1 WHERE id=1','UPDATE users,other SET active=1 WHERE id=1','UPDATE users JOIN other ON users.id=other.id SET active=1 WHERE id=1'])
  await assert.rejects(verifyUpdateTarget({query:async()=>{throw Error('must not query')}},sql,1000),/单表/);
});

test('触发器元数据不可见或缺少权限证明时拒绝 UPDATE',async()=>{
 const {verifyUpdateTarget}=await import('../mcp/update-target.mjs');
 const connection={query:async q=>q.sql.startsWith('SELECT 1 FROM')?[[]]:[[{engine:'InnoDB',table_type:'BASE TABLE',trigger_count:0,trigger_visible:0}]]};
 await assert.rejects(verifyUpdateTarget(connection,'UPDATE users SET active=1 WHERE id=1',1000),/元数据可见性/);
});
