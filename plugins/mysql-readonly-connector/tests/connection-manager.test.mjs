import assert from 'node:assert/strict';import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ConfigStore} from '../mcp/config-store.mjs';
import {saveManagedConnection,deleteManagedConnection,setManagedDefaultConnection,managedConnectionState} from '../mcp/connection-manager.mjs';
const args={name:'one',host:'db.example',user:'reader',database:'app'};
function fixture(t,env={MYSQL_PASSWORD:'fixture-value'}){const dir=mkdtempSync(join(tmpdir(),'mysql-env-manager-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const store=new ConfigStore({configPath:join(dir,'connections.json'),env});return {store,onChanged:async()=>{}}}
test('新增保存来源与名称，不需要密码弹框',async t=>{
 const options=fixture(t),result=await saveManagedConnection({...options,args});assert.equal(result.connection.password_source,'MYSQL_PASSWORD');assert.equal(result.connection.password_configured,true);assert.equal(result.password_action,'environment_reference_saved');
});
test('普通编辑保留环境引用，只更换引用即可切换密码',async t=>{
 const options=fixture(t,{MYSQL_PASSWORD:'default-value',MYSQL_PASSWORDS_JSON:'{"alternate":"alternate-value"}'});await saveManagedConnection({...options,args});await saveManagedConnection({...options,args:{name:'one',password_source:'MYSQL_PASSWORDS_JSON',password_key:'alternate'}});await saveManagedConnection({...options,args:{name:'one',host:'new.example'}});
 assert.equal(options.store.resolvedProfiles().profiles.one.password,'alternate-value');assert.equal(options.store.read().connections.one.host,'new.example');
});
test('缺少环境密码返回未配置，不把保存引用当成连接成功',async t=>{
 const result=await saveManagedConnection({...fixture(t,{}),args});assert.equal(result.connection.password_configured,false);
});
test('拒绝密码值与旧换密/钥匙串复制参数',async t=>{
 const options=fixture(t);for(const extra of [{password:'do-not-save'},{change_password:true},{copy_password_from:'other'}])await assert.rejects(saveManagedConnection({...options,args:{...args,...extra}}),/环境变量/);assert.equal(options.store.exists(),false);
});
test('密码环境变量格式无效时不保存也不回显',async t=>{
 const options=fixture(t,{MYSQL_PASSWORDS_JSON:'{invalid-private-value'});await assert.rejects(saveManagedConnection({...options,args:{...args,password_source:'MYSQL_PASSWORDS_JSON'}}),e=>e.message.includes('格式无效')&&!e.message.includes('invalid-private-value'));assert.equal(options.store.exists(),false);
});
test('列表、默认连接与删除不修改环境变量',async t=>{
 const options=fixture(t);await saveManagedConnection({...options,args});await saveManagedConnection({...options,args:{...args,name:'two'}});await setManagedDefaultConnection({...options,name:'two'});assert.equal(managedConnectionState(options.store).default_connection,'two');const result=await deleteManagedConnection({...options,name:'two'});assert.equal(result.environment_unchanged,true);assert.equal(options.store.env.MYSQL_PASSWORD,'fixture-value');assert.ok(!readFileSync(options.store.configPath,'utf8').includes('fixture-value'));
});
