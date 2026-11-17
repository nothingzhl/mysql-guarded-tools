import test from 'node:test';import assert from 'node:assert/strict';
import {environmentPassword,normalizePasswordReference} from '../mcp/environment-passwords.mjs';
test('单密码与 JSON 映射显式隔离，不误用默认密码',()=>{
 const env={MYSQL_PASSWORD:'global',MYSQL_PASSWORDS_JSON:'{"one":"specific"}'};
 assert.equal(environmentPassword('one',{},env),'global');assert.equal(environmentPassword('one',{passwordSource:'MYSQL_PASSWORDS_JSON'},env),'specific');assert.equal(environmentPassword('two',{passwordSource:'MYSQL_PASSWORDS_JSON'},env),null);
});
test('缺失、空值、无效 JSON 和嵌套非字符串均失败关闭',()=>{
 assert.equal(environmentPassword('one',{},{}),null);assert.equal(environmentPassword('one',{}, {MYSQL_PASSWORD:''}),null);
 for(const raw of ['invalid-sensitive-json','[]','null','{"one":1}','{"one":{"password":"nested"}}'])assert.throws(()=>environmentPassword('one',{passwordSource:'MYSQL_PASSWORDS_JSON'},{MYSQL_PASSWORDS_JSON:raw}),e=>!e.message.includes(raw));
});
test('引用名和密码来源受到限制，环境值不回显',()=>{
 for(const key of ['__proto__','constructor','prototype','a/b',''])assert.throws(()=>normalizePasswordReference('one',{passwordKey:key}));assert.throws(()=>normalizePasswordReference('one',{passwordSource:'ARBITRARY_VAR'}));
});
test('显式 MYSQL_PASSWORD 不受未使用的 JSON 配置错误影响',()=>{
 assert.equal(environmentPassword('one',{}, {MYSQL_PASSWORD:'global',MYSQL_PASSWORDS_JSON:'invalid'}),'global');
});
