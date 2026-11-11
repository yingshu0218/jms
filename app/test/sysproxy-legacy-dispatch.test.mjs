import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProxyJournal, disableProxy, healIfNeeded, enableProxy } from '../engine/sysproxy/index.mjs';
import { createDarwinAdapter, getAdapter, MAC_KINDS } from '../engine/sysproxy/adapters.mjs';

const clone = value => structuredClone(value);
const originalBase = () => ({schema:2,services:[{
  id:'11111111-1111-1111-1111-111111111111',name:'Wi-Fi',device:'en0',
  ...Object.fromEntries(MAC_KINDS.map((kind,index)=>[kind,{enabled:index===0,host:'corp.invalid',port:3128,authenticated:false}])),
  bypass:['localhost'],autoproxy:{url:'https://pac.invalid/config',enabled:true},autodiscovery:true,
}]});
function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'jms-legacy-dispatch-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const journal=new ProxyJournal(dir),original=originalBase(),target={mode:'on',host:'127.0.0.1',port:2080,bypass:['localhost']};
  const planner=createDarwinAdapter({execute:()=>{throw Error('No real command permitted');}});
  const darwin=planner.prepareTransaction({mode:'on',host:'corp.invalid',port:3128,base:original},target);
  const middle=clone(original);middle.services[0].autoproxy.enabled=false;
  darwin.states.push(middle,clone(darwin.targetBase));
  const entry={platform:'darwin',previous:{mode:'on',host:'corp.invalid',port:3128},previousBase:original,target,darwin};
  const state={current:clone(darwin.targetBase),writes:0,events:[],failRestore:false,failVerify:false};
  const legacy={platform:'darwin',transactionVersion:2,
    async restore(base){
      state.events.push('legacy.restore');
      if(!journal.read().darwin.states.some(value=>isDeepStrictEqual(value,state.current)))throw Object.assign(Error('external change'),{code:'RECOVERY_REQUIRED'});
      if(state.failRestore)throw Error('fixture command failed');
      if(!isDeepStrictEqual(state.current,base))state.writes++;
      state.current=clone(base);
    },
    async verifyRestored(saved){state.events.push('legacy.verify');return !state.failVerify&&isDeepStrictEqual(state.current,saved.previousBase);},
  };
  const raw={platform:'darwin',transactionVersion:3,legacyRecoveryAdapter:legacy,
    async restore(){state.events.push('raw.restore');throw Error('Raw writer must not receive a legacy entry');},
    async verifyRestored(){state.events.push('raw.verify');return false;},
  };
  return {journal,original,middle,entry,state,legacy,raw};
}
for(const starting of ['original','middle','target'])test(`exact legacy journal dispatch: ${starting}`,async t=>{
  const f=setup(t);f.state.current=clone(starting==='original'?f.original:starting==='middle'?f.middle:f.entry.darwin.targetBase);
  f.journal.begin(f.entry);
  const result=await disableProxy({adapter:f.raw,journal:f.journal});
  assert.equal(result.hadJournal,true);assert.equal(f.journal.isPending(),false);
  assert.deepEqual(f.state.current,f.original);assert.deepEqual(f.state.events,['legacy.restore','legacy.verify']);
  assert.equal(f.state.writes,starting==='original'?0:1);
});
test('startup healing uses the same selected legacy adapter for restore and verification',async t=>{
  const f=setup(t);f.journal.begin(f.entry);
  assert.equal((await healIfNeeded({adapter:f.raw,journal:f.journal})).healed,true);
  assert.deepEqual(f.state.events,['legacy.restore','legacy.verify']);assert.equal(f.journal.isPending(),false);
});
for(const stage of ['restore','verify'])test(`legacy ${stage} failure retains journal and supports explicit retry`,async t=>{
  const f=setup(t);f.journal.begin(f.entry);f.state[stage==='restore'?'failRestore':'failVerify']=true;
  await assert.rejects(disableProxy({adapter:f.raw,journal:f.journal}));assert.equal(f.journal.isPending(),true);
  assert.equal(f.state.events.some(name=>name.startsWith('raw.')),false);
  f.state.failRestore=f.state.failVerify=false;
  await disableProxy({adapter:f.raw,journal:f.journal});assert.equal(f.journal.isPending(),false);assert.deepEqual(f.state.current,f.original);
});
test('incomplete, mixed-schema and cross-platform journal selection performs zero writes',async t=>{
  const edits=[
    e=>{e.previousBase.schema=3;},e=>{e.darwin.schema=3;},e=>{e.darwin.targetBase.schema=3;},
    e=>{e.darwin.states=[];},e=>{e.darwin.states[0].services[0].webproxy.port=null;},
    e=>{e.darwin.targetBase.services[0].name='renamed';},e=>{e.platform='linux';},
  ];
  for(const edit of edits){
    const f=setup(t),entry=clone(f.entry);edit(entry);f.journal.begin(entry);
    const before=readFileSync(f.journal.file,'utf8');
    await assert.rejects(disableProxy({adapter:f.raw,journal:f.journal}),{code:'RECOVERY_REQUIRED'});
    assert.equal(readFileSync(f.journal.file,'utf8'),before);assert.deepEqual(f.state.events,[]);assert.equal(f.state.writes,0);
  }
});
test('legacy external state change is refused without raw fallback or journal clear',async t=>{
  const f=setup(t);f.journal.begin(f.entry);f.state.current.services[0].autoproxy.url='https://external.invalid/pac';
  const before=readFileSync(f.journal.file,'utf8');
  await assert.rejects(disableProxy({adapter:f.raw,journal:f.journal}),{code:'RECOVERY_REQUIRED'});
  assert.equal(f.state.writes,0);assert.deepEqual(f.state.events,['legacy.restore']);assert.equal(readFileSync(f.journal.file,'utf8'),before);
});
test('raw apply or recovery failure never falls back to the legacy writer',async t=>{
  const f=setup(t);const base={schema:3,services:[{id:f.original.services[0].id,name:'Wi-Fi',device:'en0',proxies:{present:false,blob:null}}]};
  const target=clone(base);target.services[0].proxies={present:true,blob:'YnBsaXN0MDBmaXh0dXJl'};
  f.raw.snapshot=async()=>({mode:'off',base});
  f.raw.prepareTransaction=async()=>({schema:3,originalBase:base,targetBase:target});
  f.raw.apply=async()=>{f.state.events.push('raw.apply');throw Error('fixture raw failure');};
  await assert.rejects(enableProxy({adapter:f.raw,journal:f.journal,port:2080}));assert.equal(f.journal.isPending(),true);
  await assert.rejects(disableProxy({adapter:f.raw,journal:f.journal}));assert.equal(f.journal.isPending(),true);
  assert.deepEqual(f.state.events,['raw.apply','raw.restore']);assert.equal(f.state.writes,0);
});
test('bundled raw adapter exposes strict legacy recovery explicitly, not as an error fallback',()=>{
  const previous=process.env.JMS_PROXY_HELPER;process.env.JMS_PROXY_HELPER='/fixture-only/not-executed';
  try{const adapter=getAdapter('darwin');assert.equal(adapter.transactionVersion,3);assert.equal(adapter.legacyRecoveryAdapter?.transactionVersion,2);}
  finally{if(previous===undefined)delete process.env.JMS_PROXY_HELPER;else process.env.JMS_PROXY_HELPER=previous;}
});
