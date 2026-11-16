import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigWindow } from '../mcp/config-window.mjs';
test('配置窗口仅授权本机请求并限制工具与密码字段',async()=>{
 const calls=[];const app=createConfigWindow({callTool:async(tool,args)=>{calls.push({tool,args});return {ok:true}}});
 try{const {url}=await app.open();const u=new URL(url);const token=u.hash.slice(1);u.hash='';
 assert.match(await (await fetch(u)).text(),/真实 MySQL/);
 const request=(tool,args={},extra={})=>fetch(new URL('/api',u),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,...extra},body:JSON.stringify({tool,args})});
 assert.equal((await request('mysql_list_connections',{}, {Authorization:'Bearer invalid'})).status,401);
 assert.equal((await request('mysql_list_connections',{}, {Origin:'https://evil.example'})).status,403);
 assert.equal((await request('mysql_query',{sql:'SELECT 1'})).status,403);
 assert.equal((await request('mysql_save_connection',{password:'secret'})).status,400);
 assert.equal((await request('mysql_list_connections')).status,200);
 assert.equal((await request('mysql_save_connection',{name:'qa',database:'test'})).status,200);
 assert.equal(calls.length,2);
 }finally{await app.close()}
});
