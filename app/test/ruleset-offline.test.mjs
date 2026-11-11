import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,utimesSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ensureRuleSet} from '../engine/rulesets.mjs';
import bundled from '../engine/bundled-geoip.json' with {type:'json'};
test('大陆 IP 库离线首启可用，更新失败保留已有规则',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'jms-offline-'));
 try {
 let calls=0;
 const fetchImpl=async()=>{calls++;throw new Error('offline');};
 const path=await ensureRuleSet({dir,fetchImpl});
 assert.ok(path);assert.equal(calls,0);
 assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),bundled.sha256);
 utimesSync(path,new Date(0),new Date(0));
 assert.equal(await ensureRuleSet({dir,fetchImpl}),path);assert.equal(calls,1);
 assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),bundled.sha256);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('规则集：HTTP200大HTML不能覆盖有效旧缓存；临时文件会清理', async () => {
 const {writeFileSync,readdirSync,mkdirSync}=await import('node:fs');
 const {ruleSetDir,ruleSetPath}=await import('../engine/rulesets.mjs');
 const dir=mkdtempSync(join(tmpdir(),'jms-ruleset-html-'));
 try {
  mkdirSync(ruleSetDir(dir),{recursive:true});const path=ruleSetPath(dir,'geosite-cn');
  const bytes=Buffer.from(bundled.data,'base64');writeFileSync(path,bytes);utimesSync(path,new Date(0),new Date(0));
  let validation=0;
  assert.equal(await ensureRuleSet({dir,name:'geosite-cn',fetchImpl:async()=>new Response('<html>'+('error '.repeat(2000))+'</html>'),validateFile:async()=>{validation++;}}),path);
  assert.deepEqual(readFileSync(path),bytes);
  assert.equal(validation,1,'只验证已有缓存，HTML在进入内核前即拒绝');
  assert.deepEqual(readdirSync(ruleSetDir(dir)),['geosite-cn.srs']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('规则集：即使格式头合法，完整解析失败也不能替换旧缓存', async () => {
 const {writeFileSync,mkdirSync}=await import('node:fs');
 const {ruleSetDir,ruleSetPath}=await import('../engine/rulesets.mjs');
 const dir=mkdtempSync(join(tmpdir(),'jms-ruleset-invalid-'));
 try {
  mkdirSync(ruleSetDir(dir),{recursive:true});const path=ruleSetPath(dir,'geosite-cn');
  const bytes=Buffer.from(bundled.data,'base64');writeFileSync(path,bytes);utimesSync(path,new Date(0),new Date(0));
  let refused=0;
  assert.equal(await ensureRuleSet({dir,name:'geosite-cn',fetchImpl:async()=>new Response(bytes),validateFile:async file=>{if(file.endsWith('.tmp')){refused++;throw Error('invalid fixture');}}}),path);
  assert.equal(refused,1);assert.deepEqual(readFileSync(path),bytes);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
