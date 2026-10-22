import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppService } from '../engine/app.mjs';
import { MockAdapter } from '../engine/sysproxy/adapters.mjs';
import { withLatencyCore } from '../engine/latency-core.mjs';
const nodes=[0,1].map(i=>({name:'Same',type:'vless',server:'127.0.0.1',server_port:1+i,uuid:'11111111-2222-3333-4444-555555555555'}));
function appFor(t, runner) {
 const dir=mkdtempSync(join(tmpdir(),'jms-latency-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const app=new AppService({dir,adapter:new MockAdapter({mode:'off'}),latencyCoreRunner:runner});
 app.store.write({subscription:{nodes},settings:{mode:'tun-per-app'}});return app;
}
test('未连接测速：使用独立内核，重复节点名仍按索引返回，网络设置不变',async t=>{
 let runs=0;const app=appFor(t,async(_binary,copy,work)=>{runs++;assert.deepEqual(copy,nodes);return work({delay:async tag=>tag==='Same #2'?42:11,delayAll:async tags=>new Map(tags.map((tag,i)=>[tag,{ok:true,delay:20+i}]))});});
 const before=JSON.stringify(app.store.state);await app.measureLatency({index:1});assert.equal(app.lastLatencyByTag.get('Same #2').delay,42);
 await app.measureLatency({all:true});assert.equal(app.lastLatencyByTag.get('Same').delay,20);assert.equal(runs,2);
 assert.equal(JSON.stringify(app.store.state),before);assert.equal(app.supervisor,null);assert.equal(app.busy,null);
});
test('测速异常清除忙碌状态；阻止并发、空节点及非法索引',async t=>{
 const app=appFor(t,async()=>{throw Error('启动失败');});
 await assert.rejects(()=>app.measureLatency({index:0}),/启动失败/);assert.equal(app.busy,null);
 app.busy='connect';await assert.rejects(()=>app.measureLatency(),/正在执行/);app.busy=null;
 await assert.rejects(()=>app.measureLatency({index:-1}),/索引/);
 app.store.write({subscription:{nodes:[]}});await assert.rejects(()=>app.measureLatency(),/没有可用/);
});
test('已连接测速复用内核，不启用临时内核',async t=>{
 const app=appFor(t,async()=>{throw Error('不应调用');});app.supervisor={isRunning:()=>true};app.clashApiFactory=()=>({delay:async()=>33});
 await app.measureLatency({index:0});assert.equal(app.lastLatencyByTag.get('Same').delay,33);
});
test('真实独立测速内核：启动 Clash API，无 TUN，成功及失败都停止', {skip:!process.env.SING_BOX},async()=>{
 for(const fail of [false,true]) {
 let api;const work=withLatencyCore(process.env.SING_BOX,nodes,async client=>{api=client;assert.ok(await client.version());assert.equal(Object.keys(await client.proxies()).includes('Same #2'),true);if(fail)throw Error('callback failed');return 7;});
 if(fail)await assert.rejects(()=>work,/callback failed/);else assert.equal(await work,7);
 await assert.rejects(()=>api.version());
 }
 await assert.rejects(()=>withLatencyCore('/not/a/binary',nodes,()=>{}));
});
test('真实延迟：本机 Shadowsocks → 本机 HTTP，离线也能取得延迟数值', {skip:!process.env.SING_BOX},async t=>{
 const { createServer }=await import('node:http');const net=await import('node:net');const { once }=await import('node:events');const { writeFileSync }=await import('node:fs');const { CoreSupervisor }=await import('../engine/supervisor.mjs');
 const target=createServer((_req,res)=>{res.writeHead(204);res.end();});target.listen(0,'127.0.0.1');await once(target,'listening');t.after(()=>{target.closeAllConnections();target.close();});
 const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const dir=mkdtempSync(join(tmpdir(),'jms-ss-latency-'));const path=join(dir,'server.json');
 writeFileSync(path,JSON.stringify({log:{disabled:true},inbounds:[{type:'shadowsocks',listen:'127.0.0.1',listen_port:port,method:'aes-128-gcm',password:'local-test-only'}],outbounds:[{type:'direct'}]}),{mode:0o600});
 const server=new CoreSupervisor({binaryPath:process.env.SING_BOX,configPath:path,maxRestarts:0,readyCheck:()=>new Promise((resolve,reject)=>{const s=net.connect(port,'127.0.0.1');s.once('connect',()=>{s.destroy();resolve();});s.once('error',reject);})});
 t.after(async()=>{await server.stop();server.closeLog();rmSync(dir,{recursive:true,force:true});});await server.start();
 const result=await withLatencyCore(process.env.SING_BOX,[{name:'local-ss',type:'shadowsocks',server:'127.0.0.1',server_port:port,method:'aes-128-gcm',password:'local-test-only'}],api=>api.delay('local-ss',{url:`http://127.0.0.1:${target.address().port}/generate_204`}));
 assert.equal(typeof result,'number');assert.ok(result>=0);
});
