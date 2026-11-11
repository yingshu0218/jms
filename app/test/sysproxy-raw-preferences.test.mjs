import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDarwinPreferencesAdapter } from '../engine/sysproxy/preferences.mjs';
import { ProxyJournal, enableProxy, disableProxy } from '../engine/sysproxy/index.mjs';
const base = blob => ({schema:3,services:[{id:'11111111-1111-1111-1111-111111111111',name:'Wi-Fi',device:'en0',proxies:{present:blob!==null,blob}}]});
for (const old of [null, 'YnBsaXN0MDDRAQJY', 'YnBsaXN0MDDRAQJZ']) {
  test(`raw preferences exact restore ${old}`, async () => {
    const dir=mkdtempSync(join(tmpdir(),'jms-raw-')); const journal=new ProxyJournal(dir);
    const original=base(old), target=base('YnBsaXN0MDB0YXJnZXQ='); let current=original; let calls=0;
    const invoke=async r=>{
      if(r.operation==='snapshot') return {ok:true,snapshot:current};
      if(r.operation==='prepare') return {ok:true,original:current,target};
      assert.ok(journal.isPending()); assert.deepEqual(current,r.expected); calls++; current=r.desired;
      return {ok:true,snapshot:current,committed:true,applied:true};
    };
    const adapter=createDarwinPreferencesAdapter({invoke,readPublic:async()=>({mode:'off'})});
    try { await enableProxy({adapter,journal,port:2080}); assert.deepEqual(current,target); await disableProxy({adapter,journal}); assert.deepEqual(current,original); assert.equal(calls,2); assert.equal(journal.isPending(),false); } finally {rmSync(dir,{recursive:true});}
  });
}
for (const failure of ['COMMIT_FAILED','APPLY_FAILED','READBACK_FAILED','NO_OP','CONFLICT']) {
 test(`raw ${failure} preserves proof and safely retries`, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'jms-raw-')); const journal=new ProxyJournal(dir);
  const original=base(null),target=base('YnBsaXN0MDB0YXJnZXQ='); let current=original; let fail=true; let writes=0;
  const invoke=async r=>{
   if(r.operation==='snapshot') return {ok:true,snapshot:current};
   if(r.operation==='prepare') return {ok:true,original:current,target};
   assert.ok(journal.isPending()); writes++; assert.deepEqual(r.expected,current);
   if(fail) { fail=false; if(['APPLY_FAILED','READBACK_FAILED'].includes(failure)) current=r.desired; if(failure==='NO_OP')return{ok:true,snapshot:current,committed:true,applied:true}; return {ok:false,code:failure,committed:failure==='APPLY_FAILED'}; }
   current=r.desired; return{ok:true,snapshot:current,committed:true,applied:true};
  };
  const adapter=createDarwinPreferencesAdapter({invoke,readPublic:async()=>({mode:'off'})});
  try {await assert.rejects(enableProxy({adapter,journal,port:2080}),{code:'RECOVERY_REQUIRED'}); assert.ok(journal.isPending()); await disableProxy({adapter,journal}); assert.equal(writes,2); assert.deepEqual(current,original); assert.equal(journal.isPending(),false);}finally{rmSync(dir,{recursive:true});}
 });
}
test('external modification and legacy journal never reach raw writer',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'jms-raw-')); const journal=new ProxyJournal(dir);let current=base(null),writes=0;
 const adapter=createDarwinPreferencesAdapter({readPublic:async()=>({mode:'off'}),invoke:async r=>{
  if(r.operation==='snapshot')return{ok:true,snapshot:current};
  if(r.operation==='prepare')return{ok:true,original:current,target:base('YnBsaXN0MDB0YXJnZXQ=')};
  writes++;current=r.desired;return{ok:true,snapshot:current,committed:true,applied:true};
 }});
 try{ await enableProxy({adapter,journal,port:2080});current=base('ZXh0ZXJuYWw=');await assert.rejects(disableProxy({adapter,journal}),{code:'RECOVERY_REQUIRED'});assert.equal(writes,1);journal.clear();journal.begin({platform:'darwin',previous:{mode:'off'},previousBase:{schema:2,services:[]},darwin:{schema:1,states:[]}});await assert.rejects(disableProxy({adapter,journal}),{code:'RECOVERY_REQUIRED'});assert.equal(writes,1);assert.ok(journal.isPending());}finally{rmSync(dir,{recursive:true});}
});
test('raw intent persistence failure prevents native CAS',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'jms-raw-'));const journal=new ProxyJournal(dir);let writes=0;
 const adapter=createDarwinPreferencesAdapter({readPublic:async()=>({mode:'off'}),invoke:async r=>{
  if(r.operation==='snapshot')return{ok:true,snapshot:base(null)};
  if(r.operation==='prepare')return{ok:true,original:base(null),target:base('YnBsaXN0MDB0YXJnZXQ=')};
  writes++;throw new Error('must not invoke');
 }});
 journal.updateDarwin=()=>{throw new Error('fsync failure');};
 try{await assert.rejects(enableProxy({adapter,journal,port:2080}));assert.equal(writes,0);assert.ok(journal.isPending());}finally{rmSync(dir,{recursive:true});}
});
test('helper diagnostics never leak raw data and corrupt schema is rejected',async()=>{
 for(const response of [{ok:false,code:'COMMIT_FAILED',message:'SECRET_PAC_CREDENTIALS'}, {ok:true,snapshot:{schema:2,services:[]}}]){
  const adapter=createDarwinPreferencesAdapter({invoke:async()=>response});
  await assert.rejects(adapter.snapshot(),e=>e.code==='RECOVERY_REQUIRED'&&!e.message.includes('SECRET'));
 }
});
