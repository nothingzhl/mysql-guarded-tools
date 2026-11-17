import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ConfigStore} from '../mcp/config-store.mjs';
import {saveManagedConnection,setManagedDefaultConnection} from '../mcp/connection-manager.mjs';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'mysql-env-regression-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const store=new ConfigStore({configPath:join(dir,'connections.json'),env:{MYSQL_PASSWORD:'fixture-value'}});return store}
const args={name:'one',host:'db.example',user:'reader',database:'app'};
const onChanged=async()=>{};
test('磁盘保存失败不改变环境密码或原配置，并释放锁',async t=>{
 const store=fixture(t);await saveManagedConnection({store,args,onChanged});const before=readFileSync(store.configPath,'utf8');store.write=()=>{throw Error('disk failure')};await assert.rejects(saveManagedConnection({store,args:{name:'one',database:'changed'},onChanged}),/disk failure/);assert.equal(readFileSync(store.configPath,'utf8'),before);assert.equal(store.env.MYSQL_PASSWORD,'fixture-value');assert.equal(existsSync(store.configPath+'.lock'),false);
});
test('跨进程写锁阻止覆盖',async t=>{
 const store=fixture(t);let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const locked=store.withLock(async()=>{entered();await gate});await ready;
 try{const other=new ConfigStore({configPath:store.configPath,env:{}});await assert.rejects(setManagedDefaultConnection({store:other,name:null,onChanged}),/另一进程/)}finally{release()}await locked;
});
test('保存后运行时刷新失败明确返回警告',async t=>{
 const store=fixture(t);const result=await saveManagedConnection({store,args,onChanged:async()=>{throw Error('pool failure')}});assert.match(result.runtime_warning,/已保存/);
});
test('拒绝保留对象键',t=>{
 const store=fixture(t);for(const name of ['__proto__','constructor','prototype']){assert.throws(()=>store.saveConnection(name,{host:'db.example',user:'reader',database:'app'}),/连接名称/);assert.throws(()=>store.setDefault(name),/不存在/);assert.throws(()=>store.deleteConnection(name),/不存在/);}
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
