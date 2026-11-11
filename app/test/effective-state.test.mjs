import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,chmodSync,renameSync,readdirSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {AppService} from '../engine/app.mjs';
import {MockAdapter} from '../engine/sysproxy/adapters.mjs';
class FakeSupervisor extends EventEmitter {
 constructor(options){super();this.options=options;this.running=false;this.pid=123;}
 isRunning(){return this.running;}status(){return {running:this.running,pid:this.running?this.pid:null};}
 async start(){this.running=true;await this.options.readyCheck();return this.status();}
 async stop(){this.running=false;}closeLog(){}
}
async function setup(t,{connect=true}={}){
 const dir=mkdtempSync(join(tmpdir(),'jms-effective-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const nodes=[0,1].map(i=>({name:'Node'+i,type:'vless',server:'192.0.2.'+(10+i),server_port:443,uuid:'11111111-2222-3333-4444-555555555555'}));
 const state={mode:'global',tag:'Node1'},events=[];
 const api={verifyOwnership:async()=>{},setMode:async m=>{events.push('mode:'+m);state.mode=m;},getMode:async()=>state.mode.toUpperCase(),select:async(_selector,tag)=>{events.push('select:'+tag);state.tag=tag;},currentSelection:async()=>state.tag};
 const adapter=new MockAdapter({mode:'off'}),apply=adapter.apply.bind(adapter);adapter.apply=async x=>{events.push('proxy:'+x.mode);return apply(x);};
 const app=new AppService({dir,adapter,coreBinary:'/fixture/no-executable',portsAvailable:async()=>{},listenerOwnership:async()=>{},ruleSetProvider:async()=>({}),clashApiFactory:()=>api,supervisorFactory:options=>new FakeSupervisor(options)});
 app.store.write({subscription:{nodes},profiles:[{id:'fixture',name:'fixture',url:'',nodes,selected:0}],activeProfileId:'fixture'});
 if(connect)await app.connect();
 t.after(async()=>{app.busy=null;await app.disconnect().catch(()=>{});});return {app,api,state,events,adapter};
}
test('连接先校准并确认mode/selector，再接管；status只展示effective',async t=>{
 const {app,state,events}=await setup(t);
 assert.equal(state.mode,'rule');assert.equal(state.tag,'Node0');assert.ok(events.indexOf('mode:rule')<events.indexOf('proxy:on'));assert.ok(events.indexOf('select:Node0')<events.indexOf('proxy:on'));
 const status=await app.status();assert.equal(status.effective.routingMode,'rule');assert.equal(status.effective.selected,0);assert.equal(status.node,'Node0');
});
test('热切失败不提前保存目标；readback不符不得applied:true',async t=>{
 const {app,api}=await setup(t);const before=readFileSync(app.store.file,'utf8');
 api.setMode=async()=>{throw Error('fixture timeout');};api.getMode=async()=>'RULE';
 let result=await app.setRoutingMode('global');assert.equal(result.applied,false);assert.equal(app.store.state.settings.routingMode,'rule');assert.equal(readFileSync(app.store.file,'utf8'),before);
 api.setMode=async()=>{};result=await app.setRoutingMode('global');assert.equal(result.applied,false);assert.equal(result.effective.routingMode,'rule');
});
test('请求响应失败但readback证实目标已生效时如实报告并保存',async t=>{
 const {app,api,state}=await setup(t);
 api.setMode=async m=>{state.mode=m;throw Error('fixture lost response');};
 const result=await app.setRoutingMode('global');assert.equal(result.applied,true);assert.equal(result.persisted,true);assert.equal(app.store.state.settings.routingMode,'global');assert.equal(result.effective.routingMode,'global');
});
test('API生效后落盘失败明确区分effective/desired，可重试保存',async t=>{
 const {app}=await setup(t);const before=readFileSync(app.store.file,'utf8');
 app.store.fileIO={writeFile:writeFileSync,chmod:chmodSync,rename:()=>{throw Error('fixture disk full');}};
 const result=await app.setRoutingMode('global');assert.equal(result.applied,true);assert.equal(result.persisted,false);assert.equal(result.code,'PERSIST_FAILED');assert.equal(app.store.state.settings.routingMode,'rule');assert.equal(readFileSync(app.store.file,'utf8'),before);assert.equal((await app.status()).effective.routingMode,'global');
 app.store.fileIO.rename=renameSync;assert.equal((await app.setRoutingMode('global')).persisted,true);
});
test('未知结果清除effective标记，节点与路由均允许重新确认',async t=>{
 const {app,api}=await setup(t);api.setMode=async()=>{throw Error('timeout');};api.getMode=async()=>{throw Error('timeout');};
 const result=await app.setRoutingMode('global');assert.equal(result.applied,false);assert.equal(result.effective.modeKnown,false);assert.equal(result.effective.routingMode,null);
 api.select=async()=>{};api.currentSelection=async()=>'Node0';const selected=await app.selectNode(1);assert.equal(selected.applied,false);assert.equal(app.store.state.settings.selected,0);assert.equal(app.store.state.profiles[0].selected,0);
});
test('热切与其他变更串行，迟到旧session响应不更新当前状态',async t=>{
 const {app,api}=await setup(t);let release;const entered=new Promise(resolve=>{api.setMode=()=>{resolve();return new Promise(r=>release=r);};});
 const pending=app.setRoutingMode('global');await entered;
 await assert.rejects(()=>app.selectNode(1),/正在执行/);await assert.rejects(()=>app.disconnect(),/正在执行/);await assert.rejects(()=>app.updateSettings({port:2345}),/正在执行/);
 app.sessionId='fixture-new-session';release();const result=await pending;assert.equal(result.applied,false);assert.equal(result.code,'STALE_SESSION');assert.equal(app.store.state.settings.routingMode,'rule');
});
test('settings不能旁路运行时selected/routingMode确认',async t=>{
 const {app}=await setup(t);const before=readFileSync(app.store.file,'utf8');
 for(const patch of [{selected:1},{routingMode:'global'}])await assert.rejects(()=>app.updateSettings(patch),/专用|切换/);
 assert.equal(readFileSync(app.store.file,'utf8'),before);
});
test('未连接选择只记录下次连接，不宣称effective当前值',async t=>{
 const {app}=await setup(t,{connect:false});const result=await app.selectNode(1);assert.equal(result.applied,false);assert.equal(result.persisted,true);assert.equal(app.store.state.settings.selected,1);assert.equal((await app.status()).effective.selected,null);
});

test('冷启动确认不一致不会接管代理或留下核心，cache不覆盖Node配置',async t=>{
 const {app,api,state,adapter}=await setup(t,{connect:false});api.setMode=async()=>{};
 await assert.rejects(()=>app.connect(),{code:'SESSION_UNCONFIRMED'});assert.equal(adapter.calls.some(x=>x.op==='apply'),false);assert.equal(app.supervisor,null);assert.equal(app.journal.isPending(),false);
});
test('已确认热切更新原子启动配置；自动重启重新校准而不重复接管',async t=>{
 const {app,api,state,adapter}=await setup(t);
 await app.setRoutingMode('global');await app.selectNode(1);
 const config=JSON.parse(readFileSync(join(app.varDir,'config-sysproxy.json')));
 assert.equal(config.experimental.cache_file.enabled,false);assert.equal(config.experimental.clash_api.default_mode,'global');assert.equal(config.outbounds[0].default,'Node1');
 const sup=app.supervisor,before=adapter.calls.filter(x=>x.op==='apply').length;
 sup.emit('crash',{code:1});state.mode='direct';state.tag='Node0';sup.pid++;
 await sup.options.readyCheck();sup.emit('restarted',sup.status());
 const status=await app.status();assert.equal(status.effective.routingMode,'global');assert.equal(status.effective.selected,1);assert.equal(adapter.calls.filter(x=>x.op==='apply').length,before);
});
test('无法准备重启配置时不发送热切请求',async t=>{
 const {app,state}=await setup(t);const original=app.writeConfig;app.writeConfig=()=>{throw Error('fixture config IO failure');};
 const result=await app.setRoutingMode('global');assert.equal(result.applied,false);assert.equal(result.persisted,false);assert.equal(state.mode,'rule');assert.equal(app.store.state.settings.routingMode,'rule');
 app.writeConfig=original;
});
for (const stage of ['backoff', 'readiness']) test(`自动重启${stage}期间拒绝节点/模式变更，不冒充真正离线`, async t => {
 const {app}=await setup(t),sup=app.supervisor,before=readFileSync(app.store.file,'utf8');
 sup.emit('crash',{code:1});sup.running=stage==='readiness';
 for(const action of [()=>app.setRoutingMode('global'),()=>app.selectNode(1)]) await assert.rejects(action,{code:'RESTARTING'});
 assert.equal(readFileSync(app.store.file,'utf8'),before);assert.equal(app.sessionSettings.routingMode,'rule');assert.equal(app.sessionSettings.selected,0);
});
for (const stage of ['api', 'readback']) test(`热切${stage}等待中崩溃：新进程只能消费上次已确认配置`, async t => {
 const {app,api,state}=await setup(t);const file=join(app.varDir,'config-sysproxy.json'),confirmed=readFileSync(file,'utf8');
 let release,entered;const blocked=new Promise(resolve=>entered=resolve);let once=true;
 if(stage==='api')api.setMode=async mode=>{if(once){once=false;entered();await new Promise(r=>release=r);return;}state.mode=mode;};
 else api.getMode=async()=>{if(once){once=false;entered();await new Promise(r=>release=r);return 'global';}return state.mode;};
 const pending=app.setRoutingMode('global');await blocked;
 assert.equal(readFileSync(file,'utf8'),confirmed,'未确认候选不得抢占正式重启配置');
 const sup=app.supervisor;sup.running=false;sup.emit('crash',{code:1});
 sup.pid++;sup.running=true;state.mode='rule';state.tag='Node0';
 await sup.options.readyCheck();sup.emit('restarted',sup.status());
 release();const result=await pending;assert.equal(result.code,'STALE_SESSION');assert.equal(result.applied,false);
 assert.equal(app.store.state.settings.routingMode,'rule');assert.equal(app.sessionSettings.routingMode,'rule');assert.equal(readFileSync(file,'utf8'),confirmed);
 assert.equal((await app.status()).effective.routingMode,'rule');assert.equal(readdirSync(app.varDir).some(name=>name.includes('.pending')),false);
});
test('API已生效而启动配置提交失败：不假报持久化并暂停自动重启', async t => {
 const {app,api}=await setup(t);const file=join(app.varDir,'config-sysproxy.json'),backup=file+'.backup';
 const before=readFileSync(app.store.file,'utf8'),setMode=api.setMode;
 api.setMode=async mode=>{await setMode(mode);renameSync(file,backup);mkdirSync(file);};
 try {
  const result=await app.setRoutingMode('global');assert.equal(result.applied,true);assert.equal(result.persisted,false);assert.equal(result.code,'PERSIST_FAILED');
  assert.equal(app.supervisor.maxRestarts,0);assert.equal(readFileSync(app.store.file,'utf8'),before);assert.equal(app.sessionSettings.routingMode,'global');
  assert.equal((await app.status()).effective.routingMode,'global');assert.equal(readdirSync(app.varDir).some(name=>name.includes('.pending')),false);
 } finally {rmSync(file,{recursive:true});renameSync(backup,file);}
});
test('API确认成功但自有PID已变，不能提交旧进程的切换结果',async t=>{
 const {app,api,state}=await setup(t);const before=readFileSync(app.store.file,'utf8'),config=readFileSync(join(app.varDir,'config-sysproxy.json'),'utf8');
 api.setMode=async mode=>{state.mode=mode;app.supervisor.pid++;};
 const result=await app.setRoutingMode('global');assert.equal(result.code,'STALE_SESSION');assert.equal(result.applied,false);
 assert.equal(readFileSync(app.store.file,'utf8'),before);assert.equal(readFileSync(join(app.varDir,'config-sysproxy.json'),'utf8'),config);
});
