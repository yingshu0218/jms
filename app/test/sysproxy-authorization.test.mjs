import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDarwinPreferencesAdapter } from '../engine/sysproxy/preferences.mjs';
import { ProxyJournal, enableProxy, disableProxy } from '../engine/sysproxy/index.mjs';
const base = blob => ({schema:3,services:[{id:'11111111-1111-1111-1111-111111111111',name:'Wi-Fi',device:'en0',proxies:{present:blob!==null,blob}}]});
const denied = {ok:false,code:'AUTHORIZATION_REQUIRED',committed:false,message:'SECRET_RAW_VALUE'};
for (const stage of ['snapshot','prepare','compareAndSet']) test(`authorization denied during ${stage}: no writes and journal retained if created`, async()=>{
 const dir=mkdtempSync(join(tmpdir(),'jms-auth-')),journal=new ProxyJournal(dir);
 const original=base(null),target=base('dGFyZ2V0');let writes=0;
 const adapter=createDarwinPreferencesAdapter({readPublic:async()=>({mode:'off'}),invoke:async r=>{
  if(r.operation===stage)return denied;
  if(r.operation==='snapshot')return{ok:true,snapshot:original};
  if(r.operation==='prepare')return{ok:true,original,target};
  writes++;throw Error('unexpected write');
 }});
 try{
  await assert.rejects(enableProxy({adapter,journal,port:2080}),e=>e.code==='SYS_PROXY_AUTHORIZATION_REQUIRED'&&!e.message.includes('SECRET'));
  assert.equal(writes,0);assert.equal(journal.isPending(),stage==='compareAndSet');
 }finally{rmSync(dir,{recursive:true});}
});
for(const stage of ['snapshot','compareAndSet']) test(`restore ${stage} authorization denial never clears existing journal`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'jms-auth-')),journal=new ProxyJournal(dir);
 const original=base(null),target=base('dGFyZ2V0');let current=original,denying=false,writes=0;
 const adapter=createDarwinPreferencesAdapter({readPublic:async()=>({mode:'off'}),invoke:async r=>{
  if(denying&&r.operation===stage)return denied;
  if(r.operation==='snapshot')return{ok:true,snapshot:current};
  if(r.operation==='prepare')return{ok:true,original,target};
  writes++;current=r.desired;return{ok:true,snapshot:current,committed:true,applied:true};
 }});
 try{await enableProxy({adapter,journal,port:2080});denying=true;
  await assert.rejects(disableProxy({adapter,journal}),{code:'SYS_PROXY_AUTHORIZATION_REQUIRED'});
  assert.equal(writes,1);assert.ok(journal.isPending());assert.deepEqual(journal.read().previousBase,original);
 }finally{rmSync(dir,{recursive:true});}
});
for(const result of [ {...denied,committed:true}, {...denied,committed:'unknown'}, {...denied,committed:undefined}, {...denied,committed:0}, {...denied,code:'CONFLICT'} ]) test(`ambiguous authorization response stays recovery required ${JSON.stringify(result)}`,async()=>{
 const adapter=createDarwinPreferencesAdapter({invoke:async()=>result});
 await assert.rejects(adapter.snapshot(),e=>e.code==='RECOVERY_REQUIRED'&&!e.message.includes('SECRET'));
});
test('authorization denied in post-commit readback remains recovery required, never claims no write',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'jms-auth-')),journal=new ProxyJournal(dir);
 const original=base(null),target=base('dGFyZ2V0');let committed=false;
 const adapter=createDarwinPreferencesAdapter({readPublic:async()=>({mode:'off'}),invoke:async r=>{
  if(r.operation==='snapshot')return committed?denied:{ok:true,snapshot:original};
  if(r.operation==='prepare')return{ok:true,original,target};
  committed=true;return{ok:true,snapshot:target,committed:true,applied:true};
 }});
 try{await assert.rejects(enableProxy({adapter,journal,port:2080}),e=>e.code==='RECOVERY_REQUIRED'&&!e.message.includes('未写入'));assert.ok(committed);assert.ok(journal.isPending());}
 finally{rmSync(dir,{recursive:true});}
});
