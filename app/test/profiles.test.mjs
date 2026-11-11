import { authenticatedFetch as fetch, TEST_SERVER_AUTH } from './http-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppService } from '../engine/app.mjs';
import { Store } from '../engine/store.mjs';
import { MockAdapter } from '../engine/sysproxy/adapters.mjs';
import { createAppServer } from '../engine/server.mjs';
import { once } from 'node:events';
const first = 'vless://11111111-2222-3333-4444-555555555555@192.0.2.10:443#First';
const second = 'vless://11111111-2222-3333-4444-555555555555@192.0.2.11:443#Second';
function setup(t) {
 const dir=mkdtempSync(join(tmpdir(),'jms-profiles-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const app=new AppService({dir,adapter:new MockAdapter({mode:'off'})});
 app.profiles.fetchImpl=async url=>new Response(url.includes('two')?second:first,{headers:{etag:'version1'}});
 return app;
}
test('订阅：首次导入自动启用，其余保存而不切换；切换保留规则和应用名单', async t=>{
 const app=setup(t);
 await app.updateSettings({customRules:[{type:'domain',value:'corp.example',outbound:'direct'}],apps:['chrome'],reverseApps:true});
 const a=await app.profiles.save({name:'One',url:'https://example.com/one?token=SECRET'});
 const b=await app.profiles.save({name:'Two',url:'https://example.com/two'});
 assert.equal(app.store.state.activeProfileId,a.id);assert.equal(app.store.state.subscription.nodes[0].name,'First');
 await app.profiles.activate(b.id);assert.equal(app.store.state.subscription.nodes[0].name,'Second');
 assert.equal(app.store.state.settings.customRules[0].value,'corp.example');assert.deepEqual(app.store.state.settings.apps,['chrome']);assert.equal(app.store.state.settings.reverseApps,true);
 const view=JSON.stringify(app.store.redacted());assert.ok(!view.includes('SECRET'));assert.ok(!view.includes('11111111-2222'));assert.equal(app.store.redacted().profiles[1].nodeCount,1);
 const restored=new Store(app.dir);assert.equal(restored.state.activeProfileId,b.id);assert.equal(restored.state.profiles.length,2);
});
test('订阅：旧版单订阅迁移为具名订阅，重复启动不重复迁移', t=>{
 const app=setup(t);app.store.write({subscription:{url:'https://example.com/old',nodes:[{name:'Old',type:'vless'}]},settings:{selected:0}});
 const migrated=new Store(app.dir);assert.equal(migrated.state.profiles.length,1);assert.equal(migrated.state.activeProfileId,'legacy');migrated.write();
 assert.equal(new Store(app.dir).state.profiles.length,1);
});
test('订阅：失败保留节点和配置，错误不包含订阅令牌', async t=>{
 const app=setup(t);const a=await app.profiles.save({name:'One',url:'https://example.com/?token=TOPSECRET'});
 app.profiles.fetchImpl=async()=>{throw Error('https://example.com/?token=TOPSECRET');};
 await assert.rejects(()=>app.profiles.refresh(a.id),/订阅更新失败/);
 assert.equal(app.store.state.subscription.nodes.length,1);assert.ok(app.store.state.profiles[0].lastError);assert.ok(!JSON.stringify(app.store.redacted()).includes('TOPSECRET'));
 const before=JSON.stringify(app.store.state);await assert.rejects(()=>app.profiles.save({name:'Broken',url:'https://example.com/bad'}));assert.equal(JSON.stringify(app.store.state),before);
});
test('订阅：连接时更新当前订阅只缓存，切换/删除/更改链接仍受保护', async t=>{
 const app=setup(t);const a=await app.profiles.save({name:'One',url:'https://example.com/one'});const b=await app.profiles.save({name:'Two',url:'https://example.com/two'});
 app.store.markRuntime({connected:true});
 for(const action of [()=>app.profiles.activate(b.id),()=>app.profiles.remove(a.id),()=>app.profiles.save({id:a.id,url:'https://example.com/change'})])await assert.rejects(action,/断开/);
 const snapshot=JSON.stringify(app.store.state.subscription);
 app.profiles.fetchImpl=async()=>new Response(second);
 const refreshed=await app.profiles.refresh(a.id); assert.equal(refreshed.pendingUpdate,true);
 assert.equal(JSON.stringify(app.store.state.subscription),snapshot);
 assert.equal(app.store.state.profiles[0].nodes[0].name,'Second');
 await app.profiles.refresh(b.id);assert.equal(app.store.state.activeProfileId,a.id);
});
test('订阅：删除当前订阅清空活动节点而不自动切换，个人规则保留', async t=>{
 const app=setup(t);const a=await app.profiles.save({name:'One',url:'https://example.com/one'});await app.profiles.save({name:'Two',url:'https://example.com/two'});
 await app.updateSettings({customRules:[{type:'domain',value:'a.example',outbound:'proxy'}]});
 await app.profiles.remove(a.id);assert.equal(app.store.state.activeProfileId,null);assert.equal(app.store.state.subscription.nodes.length,0);assert.equal(app.store.state.settings.customRules.length,1);
 assert.equal(new Store(app.dir).state.activeProfileId,null);
});
test('订阅：编辑名称不重复下载，304 保留节点，全部更新汇总', async t=>{
 const app=setup(t);const a=await app.profiles.save({name:'One',url:'https://example.com/one'});
 app.profiles.fetchImpl=async (_url,opts)=>{assert.equal(opts.headers['If-None-Match'],'version1');return new Response(null,{status:304});};
 await app.profiles.save({id:a.id,name:'Renamed'});assert.equal(app.store.state.profiles[0].name,'Renamed');
 const result=await app.profiles.refresh(a.id);assert.equal(result.notModified,true);assert.equal(app.store.state.subscription.nodes.length,1);
 assert.deepEqual(await app.profiles.refreshAll(),{updated:1,failed:0});
});
test('订阅：并发修改不覆盖状态；每份订阅保留节点选择，清理测速数据', async t=>{
 const app=setup(t);app.profiles.fetchImpl=async()=>new Response(first+'\n'+second);
 const a=await app.profiles.save({name:'One',url:'https://example.com/one'});await app.selectNode(1);const b=await app.profiles.save({name:'Two',url:'https://example.com/two'});
 app.lastLatencyByTag.set('First',{ok:true,delay:5});await app.profiles.activate(b.id);assert.equal(app.lastLatencyByTag.size,0);
 await app.profiles.activate(a.id);assert.equal(app.store.state.settings.selected,1);
 let release;app.profiles.fetchImpl=()=>new Promise(r=>{release=r;});const pending=app.profiles.refresh(a.id);await assert.rejects(()=>app.profiles.remove(b.id),/正在执行/);release(new Response(first));await pending;
});
test('订阅 API：通过 HTTP 管理和切换，列表脱敏，旧接口继续可用', async t=>{
 const app=setup(t);const server=createAppServer({app,port:0,...TEST_SERVER_AUTH});await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${server.address().port}`;
 const post=async(path,data)=>{const res=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});assert.equal(res.status,200);return res.json();};
 const a=await post('/api/profiles',{name:'One',url:'https://example.com/one?secret=HIDDEN'});const b=await post('/api/profiles',{name:'Two',url:'https://example.com/two'});
 await post('/api/profiles/activate',{id:b.id});let s=await(await fetch(base+'/api/state')).json();assert.equal(s.activeProfileId,b.id);
 const list=await(await fetch(base+'/api/profiles')).json();assert.equal(list.profiles.length,2);assert.ok(!JSON.stringify(list).includes('HIDDEN'));
 await post('/api/subscription',{url:'https://example.com/one?secret=HIDDEN'});s=await(await fetch(base+'/api/state')).json();assert.equal(s.activeProfileId,a.id);
});

test('自动刷新所有订阅：连接中缓存当前订阅，断开后应用，不切换订阅', async t => {
 const app=setup(t);const a=await app.profiles.save({name:'One',url:'https://example.com/one'});await app.profiles.save({name:'Two',url:'https://example.com/two'});
 app.store.markRuntime({connected:true});app.supervisor={isRunning:()=>true,stop:async()=>{},closeLog:()=>{}};
 let requests=0;app.profiles.fetchImpl=async()=>{requests++;return new Response(second);};
 assert.deepEqual(await app.autoRefreshSubscriptions(),{updated:2,failed:0});
 assert.equal(requests,2);assert.equal(app.store.state.activeProfileId,a.id);assert.equal(app.store.state.subscription.nodes[0].name,'First');
 assert.equal(app.store.state.profiles[0].pendingUpdate,true);
 await app.disconnect();assert.equal(app.store.state.subscription.nodes[0].name,'Second');assert.equal(app.store.state.profiles[0].pendingUpdate,false);
});
test('自动刷新：失败不阻断其余订阅，重叠周期与忙碌时不重复请求', async t => {
 const app=setup(t);await app.profiles.save({name:'One',url:'https://example.com/one'});await app.profiles.save({name:'Two',url:'https://example.com/two'});
 let release;app.profiles.fetchImpl=url=>url.endsWith('one')?new Promise(r=>{release=r;}):Promise.reject(Error('secret url'));
 const pending=app.autoRefreshSubscriptions();assert.equal(await app.autoRefreshSubscriptions(),undefined);release(new Response(first));
 assert.deepEqual(await pending,{updated:1,failed:1});assert.equal(app.store.state.profiles[1].nodes.length,1);
 app.busy='connect';assert.equal(await app.autoRefreshSubscriptions(),undefined);app.busy=null;
 assert.equal(new Store(mkdtempForDefault(t)).state.settings.autoRefreshMinutes,180);
});
function mkdtempForDefault(t) {const dir=mkdtempSync(join(tmpdir(),'jms-default-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
test('自动刷新周期：默认每三小时触发，修改间隔替换旧计时器', t => {
 const app=setup(t);t.mock.timers.enable({apis:['setInterval']});let calls=0;
 app.autoRefreshSubscriptions=async()=>{calls++;};
 app.startAutoRefresh();t.mock.timers.tick(180*60_000-1);assert.equal(calls,0);
 t.mock.timers.tick(1);assert.equal(calls,1);
 app.startAutoRefresh({intervalMs:60_000});t.mock.timers.tick(60_000);assert.equal(calls,2);
 clearInterval(app.refreshTimer);
});
