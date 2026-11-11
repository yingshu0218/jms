import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,renameSync,chmodSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../engine/store.mjs';
import {AppService} from '../engine/app.mjs';
import {MockAdapter} from '../engine/sysproxy/adapters.mjs';
const dirFor=t=>{const d=mkdtempSync(join(tmpdir(),'jms-store-tx-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;};
for(const operation of ['writeFile','chmod','rename']) test(`Store事务：${operation}失败不改变内存/磁盘，且可重试`,t=>{
 const store=new Store(dirFor(t));store.write({settings:{port:2345}});
 const before=readFileSync(store.file,'utf8'),ref=store.state, snapshot=JSON.stringify(ref);
 store.fileIO={writeFile:writeFileSync,chmod:chmodSync,rename:renameSync};
 const original=store.fileIO[operation];store.fileIO[operation]=()=>{throw Object.assign(Error('fixture IO failure'),{code:'EIO'});};
 assert.throws(()=>store.write({settings:{port:3456}}),/fixture/);
 assert.equal(store.state,ref);assert.equal(JSON.stringify(store.state),snapshot);assert.equal(readFileSync(store.file,'utf8'),before);
 assert.equal(existsSync(store.tmp),false);
 store.fileIO[operation]=original;store.write({settings:{port:3456}});assert.equal(store.state.settings.port,3456);
});
test('Store事务：成功提交后不保留调用者可变对象别名',t=>{
 const store=new Store(dirFor(t));const patch={settings:{apps:['chrome']}};store.write(patch);patch.settings.apps.push('untrusted');
 assert.deepEqual(store.state.settings.apps,['chrome']);assert.deepEqual(JSON.parse(readFileSync(store.file)).settings.apps,['chrome']);
});
test('Profiles事务：激活保存失败不改变旧profile选择、当前镜像或延迟缓存',async t=>{
 const app=new AppService({dir:dirFor(t),adapter:new MockAdapter({mode:'off'})});
 const sub='vless://11111111-2222-3333-4444-555555555555@192.0.2.10:443#First\nvless://11111111-2222-3333-4444-555555555555@192.0.2.11:443#Second';
 app.profiles.fetchImpl=async()=>new Response(sub);const a=await app.profiles.save({url:'https://fixture.invalid/one'});const b=await app.profiles.save({url:'https://fixture.invalid/two'});
 app.store.write({settings:{selected:1}});app.lastLatency.set('First',{ok:true,delay:12});app.lastLatencyByTag.set('First',{ok:true,delay:12});
 const before=readFileSync(app.store.file,'utf8'),snapshot=JSON.stringify(app.store.state),profileA=app.profiles.find(a.id);
 app.store.fileIO={writeFile:writeFileSync,chmod:chmodSync,rename:()=>{throw Error('fixture rename failure');}};
 await assert.rejects(()=>app.profiles.activate(b.id),{code:'PERSIST_FAILED'});
 assert.equal(JSON.stringify(app.store.state),snapshot);assert.equal(readFileSync(app.store.file,'utf8'),before);assert.equal(profileA.selected,0);
 assert.equal(app.lastLatency.size,1);assert.equal(app.lastLatencyByTag.size,1);
});

test('Store读取IO失败不是损坏JSON，原文件不重命名也不被空状态覆盖',t=>{
 const dir=dirFor(t),initial=new Store(dir);initial.write({settings:{port:2345}});const before=readFileSync(initial.file,'utf8');
 assert.throws(()=>new Store(dir,{fileIO:{readFile:()=>{throw Object.assign(Error('fixture permission'),{code:'EACCES'});}}}),{code:'STORAGE_READ_FAILED'});
 assert.equal(readFileSync(initial.file,'utf8'),before);assert.equal(existsSync(initial.file+'.corrupt'),false);
});
test('Store拒绝原型污染键而不修改旧状态',t=>{
 const store=new Store(dirFor(t));store.write({settings:{port:2345}});const before=readFileSync(store.file,'utf8');
 assert.throws(()=>store.write(JSON.parse('{"settings":{"__proto__":{"polluted":true}}}')));
 assert.equal({}.polluted,undefined);assert.equal(readFileSync(store.file,'utf8'),before);assert.equal(store.state.settings.port,2345);
});
test('Profiles保存失败不再二次提交lastError覆盖失败前的快照',async t=>{
 const app=new AppService({dir:dirFor(t),adapter:new MockAdapter({mode:'off'})});
 app.profiles.fetchImpl=async()=>new Response('vless://11111111-2222-3333-4444-555555555555@192.0.2.10:443#Old');
 const profile=await app.profiles.save({url:'https://fixture.invalid/one'});const before=readFileSync(app.store.file,'utf8');
 app.profiles.fetchImpl=async()=>new Response('vless://11111111-2222-3333-4444-555555555555@192.0.2.11:443#New');
 let attempts=0;app.store.fileIO.rename=(...args)=>{if(++attempts===1)throw Error('fixture IO');return renameSync(...args);};
 await assert.rejects(()=>app.profiles.refresh(profile.id),{code:'PERSIST_FAILED'});
 assert.equal(attempts,1);assert.equal(readFileSync(app.store.file,'utf8'),before);assert.equal(app.store.state.subscription.nodes[0].name,'Old');
});
test('旧损坏节点的脱敏投影不泄露嵌套凭据，也不妨碍重新导入修复', async t => {
 const app=new AppService({dir:dirFor(t),adapter:new MockAdapter({mode:'off'})});
 app.store.write({subscription:{nodes:[null,{name:4,type:false,security:{password:'SECRET'},flow:{uuid:'SECRET'},server_port:'443'}]}});
 const projected=app.store.redacted().subscription.nodes;
 assert.ok(!JSON.stringify(projected).includes('SECRET'));
 assert.equal(projected[1].security,'none');assert.equal(projected[1].flow,null);
 const snapshot=await app.snapshot();assert.equal(snapshot.subscription.nodes.length,2);
 assert.equal(snapshot.subscription.nodes[0].type,'invalid');
});
