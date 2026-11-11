import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppService } from '../engine/app.mjs';
import { createDarwinAdapter, validateDarwinJournal, MAC_KINDS } from '../engine/sysproxy/adapters.mjs';
import { NativeProxyCoordinator, NativeFrameDecoder, MAX_NATIVE_FRAME } from '../engine/native-proxy.mjs';
const launch='11111111-1111-4111-8111-111111111111',op='22222222-2222-4222-8222-222222222222';
const original={schema:3,services:[{id:'33333333-3333-4333-8333-333333333333',name:'Fixture',device:'en0',proxies:{present:false,blob:null}}]};
const target={...original,services:[{...original.services[0],proxies:{present:true,blob:'dGFyZ2V0'}}]};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const begin=(action='connect',operationId=op)=>({version:1,type:'begin',launchId:launch,operationId,action});
class Supervisor extends EventEmitter {
 running=false;pid=123;stops=0;async start(){this.running=true;}isRunning(){return this.running;}
 status(){return{running:this.running,pid:this.pid};}async stop(){this.stops++;this.running=false;}closeLog(){}
}
function setup(t,{mode='ok',observeFail=false,walFail=false,cancel=false}={}) {
 const dir=mkdtempSync(join(tmpdir(),'jms-native-proxy-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const sup=new Supervisor(),frames=[];let current=structuredClone(original),prepared,commits=0,observations=0,failObservationAt=null;
 const adapter={platform:'darwin',transactionVersion:3,read:async()=>({mode:'off'}),restore:async()=>{throw Error('default adapter must never restore an interactive operation');}};
 const app=new AppService({dir,adapter,nativeControl:true,coreBinary:'/fake-not-executable',portsAvailable:async()=>{},listenerOwnership:async()=>{},ruleSetProvider:async()=>({}),supervisorFactory:()=>sup,clashApiFactory:()=>({setMode:async()=>{},getMode:async()=> 'rule',select:async()=>{},currentSelection:async()=>app.nodeTags()[0]})});
 app.store.write({subscription:{nodes:[{type:'trojan',name:'Fixture',server:'192.0.2.10',server_port:443,password:'fixture-only'}]}});
 if(walFail)app.journal.begin=()=>{throw Error('injected fsync failure');};
 let coordinator;
 const reply=(frame,response)=>coordinator.handle({version:1,type:'helper-result',launchId:launch,operationId:frame.operationId,sequence:frame.sequence,planDigest:frame.planDigest,response});
 coordinator=new NativeProxyCoordinator({app,launchId:launch,prepareTimeoutMs:15,commitTimeoutMs:15,observe:async()=>{observations++;if((observeFail&&observations>1)||observations===failObservationAt)throw Error('read failed');return structuredClone(current);},send:frame=>{
  frames.push(frame);if(frame.type!=='helper')return;
  const request=frame.request;
  if(request.operation==='interactivePrepare') {
   assert.equal(sup.running||frame.operationId!==op,true,'apply auth waits for own core readiness');
   if(cancel){coordinator.handle({version:1,type:'cancel',launchId:launch,operationId:frame.operationId});return;}
   if(mode==='no-prepared')return;
   const plan=JSON.parse(Buffer.from(request.planData,'base64').toString('utf8'));
   const desired=plan.action==='apply'?target:original;
   const state={original,target,current,desired};const bytes=Buffer.from(JSON.stringify(state));
   prepared={plan,state,preparedDigest:digest(bytes)};
   if(mode==='crash-before-permit')sup.running=false;
   if(mode==='replace-pid-before-permit')sup.pid++;
   reply(frame,{ok:true,phase:'prepared',operationId:frame.operationId,planDigest:frame.planDigest,preparedDigest:prepared.preparedDigest,preparedData:bytes.toString('base64')});
  }else{
   assert.equal(request.operation,'interactiveCommit');assert.equal(app.journal.isPending(),true);
   const journal=JSON.parse(readFileSync(app.journal.file,'utf8'));
   assert.equal(journal.darwin.outcome,'pending');assert.equal(journal.darwin.intent,prepared.plan.action);
   commits++;current=structuredClone(prepared.state.desired);
   if(mode==='lose-final')return;
   if(mode==='cancel-after-permit'){coordinator.handle({version:1,type:'cancel',launchId:launch,operationId:frame.operationId});return;}
   const response={ok:true,phase:'finished',operationId:frame.operationId,planDigest:frame.planDigest,preparedDigest:request.preparedDigest,snapshot:current,verifiedSnapshot:current,committed:true,applied:true};
   if(mode==='bad-final')response.verifiedSnapshot=original;
   reply(frame,response);
  }
 }});
 return {app,sup,coordinator,frames,commits:()=>commits,observations:()=>observations,setCurrent:value=>{current=value;},setObservationFailure:value=>{failObservationAt=value;}};
}
test('private Native connect and restore keep WAL-before-permit and independent observations',async t=>{
 const f=setup(t);f.coordinator.hello();f.coordinator.handle(begin());await f.coordinator.idle();
 assert.equal(f.commits(),1);assert.equal(f.app.journal.isPending(),true);assert.equal(f.sup.running,true);
 assert.equal(f.frames.at(-1).ok,true);assert.equal(f.observations(),2);
 f.coordinator.handle(begin('disconnect','44444444-4444-4444-8444-444444444444'));await f.coordinator.idle();
 assert.equal(f.commits(),2);assert.equal(f.app.journal.isPending(),false);assert.equal(f.sup.running,false);assert.equal(f.frames.at(-1).ok,true);
 assert.equal(f.observations(),4);f.coordinator.close();
});
for(const mode of ['lose-final','cancel-after-permit','bad-final'])test(`${mode}: committed uncertainty retains original journal/core and never replays commit`,async t=>{
 const f=setup(t,{mode});f.coordinator.handle(begin());await f.coordinator.idle();
 assert.equal(f.commits(),1);assert.equal(f.app.journal.isPending(),true);assert.equal(f.sup.running,true);assert.equal(f.sup.stops,0);
 assert.deepEqual(f.app.journal.read().previousBase,original);assert.equal(f.frames.at(-1).ok,false);
 assert.equal(f.app.recoveryRequired,true);f.coordinator.close();
});
test('failed independent readback cannot turn helper success into cleared restoration evidence',async t=>{
 const f=setup(t,{observeFail:true});f.coordinator.handle(begin());await f.coordinator.idle();
 assert.equal(f.commits(),1);assert.equal(f.frames.at(-1).ok,false);assert.equal(f.app.journal.isPending(),true);assert.equal(f.sup.running,true);f.coordinator.close();
});
test('WAL/fsync failure produces no commit permission or system writes',async t=>{
 const f=setup(t,{walFail:true});f.coordinator.handle(begin());await f.coordinator.idle();
 assert.equal(f.commits(),0);assert.equal(f.frames.filter(x=>x.type==='helper').length,1);assert.equal(f.frames.at(-1).ok,false);
 assert.equal(f.sup.running,false);f.coordinator.close();
});
for(const mode of ['no-prepared','crash-before-permit','replace-pid-before-permit'])test(`${mode}: no permit may target a dead/unconfirmed session`,async t=>{
 const f=setup(t,{mode});f.coordinator.handle(begin());await f.coordinator.idle();assert.equal(f.commits(),0);assert.equal(f.frames.at(-1).ok,false);f.coordinator.close();
});
test('explicit cancellation before prepared causes zero journal/system writes',async t=>{
 const f=setup(t,{cancel:true});f.coordinator.handle(begin());await f.coordinator.idle();assert.equal(f.commits(),0);assert.equal(f.app.journal.isPending(),false);f.coordinator.close();
});
test('operation id replay and second concurrent begin cannot call an authorizer twice',async t=>{
 const f=setup(t,{mode:'no-prepared'});f.coordinator.handle(begin());
 f.coordinator.handle(begin('connect','55555555-5555-4555-8555-555555555555'));
 await f.coordinator.idle();const count=f.frames.filter(x=>x.type==='helper').length;
 f.coordinator.handle(begin());await f.coordinator.idle();assert.equal(f.frames.filter(x=>x.type==='helper').length,count);assert.equal(f.commits(),0);f.coordinator.close();
});
test('unknown/wrong launch/extra-key private frames are rejected before any helper',async t=>{
 const f=setup(t);
 for(const frame of [{...begin(),launchId:'other'}, {...begin(),userInitiated:true}, {...begin(),action:'elevate'}, {...begin(),version:true}, {...begin(),operationId:'../bad'}])assert.throws(()=>f.coordinator.handle(frame),{code:'NATIVE_PROTOCOL'});
 assert.equal(f.frames.length,0);assert.equal(f.commits(),0);f.coordinator.close();
});
test('Candidate always refuses private begin, even when bridge was explicitly constructed',async t=>{
 const f=setup(t);f.app.isolated=true;f.coordinator.handle(begin());await f.coordinator.idle();
 assert.equal(f.frames.length,1);assert.equal(f.frames[0].code,'ISOLATED');assert.equal(f.commits(),0);assert.equal(f.app.journal.isPending(),false);f.coordinator.close();
});
test('private EOF after permit retains evidence and owned core',async t=>{
 const f=setup(t,{mode:'lose-final'});f.coordinator.handle(begin());
 while(f.commits()===0)await new Promise(resolve=>setImmediate(resolve));f.coordinator.close();await f.coordinator.idle();
 assert.equal(f.commits(),1);assert.equal(f.app.journal.isPending(),true);assert.equal(f.sup.running,true);
});
test('decoder supports bounded fragmented frames, rejects malformed UTF8/overlimit without echoing bytes',()=>{
 const frames=[],errors=[];let codec=new NativeFrameDecoder(f=>frames.push(f),e=>errors.push(e));
 codec.push(Buffer.from('{"version":'));codec.push(Buffer.from('1}\n'));assert.deepEqual(frames,[{version:1}]);codec.end();
 for(const bytes of [Buffer.from([0xc3,0x28,10]),Buffer.alloc(MAX_NATIVE_FRAME+2,120),Buffer.from('secret-not-json\n')]){
  codec=new NativeFrameDecoder(f=>frames.push(f),e=>errors.push(e));codec.push(bytes);assert.equal(codec.closed,true);
 }
 assert.equal(errors.length,3);assert.ok(errors.every(e=>!e.message.includes('secret')));
});

test('journal intent fsync failure after begin never sends commit, retains core and original proof',async t=>{
 const f=setup(t);f.app.journal.updateDarwin=()=>{throw Error('injected directory fsync failure');};
 f.coordinator.handle(begin());await f.coordinator.idle();
 assert.equal(f.commits(),0);assert.equal(f.app.journal.isPending(),true);assert.equal(f.sup.running,true);
 assert.equal(f.frames.at(-1).ok,false);assert.equal(f.app.recoveryRequired,true);f.coordinator.close();
});
test('background giveup and shutdown cannot arm interactive recovery',async t=>{
 const f=setup(t);f.coordinator.handle(begin());await f.coordinator.idle();
 const count=f.frames.filter(frame=>frame.type==='helper').length;
 const gaveup=new Promise(resolve=>f.app.once('gaveup',resolve));f.sup.running=false;f.sup.emit('giveup',{restarts:5});await gaveup;
 assert.equal(f.app.journal.isPending(),true);assert.equal(f.app.recoveryRequired,true);
 await assert.rejects(()=>f.app.shutdown(),{code:'SYS_PROXY_AUTHORIZATION_REQUIRED'});
 assert.equal(f.frames.filter(frame=>frame.type==='helper').length,count);assert.equal(f.commits(),1);f.coordinator.close();
});

test('complete legacy journal stays pending: Native interactive path never falls back to networksetup',async t=>{
 const f=setup(t);
 const legacyBase={schema:2,services:[{id:original.services[0].id,name:'Fixture',device:'en0',
  ...Object.fromEntries(MAC_KINDS.map(kind=>[kind,{enabled:false,host:'corp.invalid',port:3128,authenticated:false}])),
  bypass:['localhost'],autoproxy:{url:null,enabled:false},autodiscovery:false}]};
 const legacyTarget={mode:'on',host:'127.0.0.1',port:2080,bypass:['localhost']};
 const planner=createDarwinAdapter({execute:()=>{throw Error('no real command permitted');}});
 const darwin=planner.prepareTransaction({mode:'off',base:legacyBase},legacyTarget);
 f.app.journal.begin({platform:'darwin',previous:{mode:'off'},previousBase:legacyBase,target:legacyTarget,darwin});
 validateDarwinJournal(f.app.journal.read()); // Prove this is complete old evidence, not a malformed fixture.
 await f.app.boot();const before=readFileSync(f.app.journal.file,'utf8');
 f.coordinator.handle(begin('disconnect'));await f.coordinator.idle();
 assert.equal(f.frames.filter(frame=>frame.type==='helper').length,0);assert.equal(f.commits(),0);assert.equal(f.app.journal.isPending(),true);
 assert.equal(readFileSync(f.app.journal.file,'utf8'),before);assert.equal(f.frames.at(-1).ok,false);f.coordinator.close();
});

for(const boundary of [1,2])test(`restore independent observation ${boundary} failure never clears journal or stops owned core`,async t=>{
 const f=setup(t);f.coordinator.handle(begin());await f.coordinator.idle();
 assert.equal(f.commits(),1);assert.equal(f.observations(),2);
 f.setObservationFailure(2+boundary);
 f.coordinator.handle(begin('disconnect','66666666-6666-4666-8666-666666666666'));await f.coordinator.idle();
 assert.equal(f.commits(),2);assert.equal(f.frames.at(-1).ok,false);assert.equal(f.app.journal.isPending(),true);
 assert.equal(f.sup.running,true);assert.equal(f.sup.stops,0);assert.equal(f.app.recoveryRequired,true);
 assert.deepEqual(f.app.journal.read().previousBase,original);
 f.setObservationFailure(null);
 f.coordinator.handle(begin('disconnect','77777777-7777-4777-8777-777777777777'));await f.coordinator.idle();
 assert.equal(f.commits(),3,'already-original retry must still Commit/Apply');
 assert.equal(f.frames.at(-1).ok,true);assert.equal(f.app.journal.isPending(),false);assert.equal(f.sup.running,false);assert.equal(f.sup.stops,1);f.coordinator.close();
});
