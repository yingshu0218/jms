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
