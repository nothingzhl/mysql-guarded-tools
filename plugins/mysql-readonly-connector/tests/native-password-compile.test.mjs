import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promptForPassword } from '../mcp/native-password.mjs';
test('原生密码脚本可编译且包含隐藏输入；不打开实际弹窗',{skip:process.platform!=='darwin'},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'mysql-password-compile-'));
 try{await promptForPassword('fixture',{platform:'darwin',run:async(_file,args)=>{
  assert.match(args[1],/with hidden answer/);
  const result=spawnSync('/usr/bin/osacompile',['-o',join(directory,'prompt.scpt'),'-e',args[1]],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);return {stdout:'test-value\n'};
 }})}finally{rmSync(directory,{recursive:true,force:true})}
});
