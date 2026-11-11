import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {probe} from '../engine/net/proxy-request.mjs';
for(const status of [204,302,403,404,502]) test(`HTTP${status}区分HTTP响应与服务成功`,async t=>{
 const server=createServer((_req,res)=>{res.writeHead(status);res.end();});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const response=await probe(`http://127.0.0.1:${server.address().port}/fixture`);
 assert.equal(response.reachable,true);assert.equal(response.ok,status>=200&&status<400);assert.equal(response.serviceAvailable,response.ok);assert.equal(response.status,status);
});
test('代理502不再被当作目标可用；本机代理可响应不等于节点可用',async t=>{
 const server=createServer((_req,res)=>res.writeHead(502).end());server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const response=await probe('http://not-a-real-site.invalid/',{proxy:{host:'127.0.0.1',port:server.address().port}});
 assert.equal(response.ok,false);assert.equal(response.serviceAvailable,false);assert.match(response.error,/502/);
});
test('检测使用实际会话端口而非下次连接的待用端口', async t => {
 const {AppService} = await import('../engine/app.mjs');
 const {MockAdapter} = await import('../engine/sysproxy/adapters.mjs');
 const {mkdtempSync,rmSync} = await import('node:fs');
 const {tmpdir} = await import('node:os'); const {join} = await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'jms-probe-session-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const server=createServer((_req,res)=>res.writeHead(204).end());server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const app=new AppService({dir,adapter:new MockAdapter({mode:'off'})});
 app.supervisor={isRunning:()=>true};app.sessionSettings={...app.store.state.settings,port:server.address().port,mode:'tun-per-app'};
 app.store.write({settings:{port:1}});
 const result=await app.checkLinks({targets:[{id:'fixture',label:'fixture',url:'http://fixture.invalid/',group:'control'}],diagnose:false,timeoutMs:500});
 assert.equal(result.port,server.address().port);assert.equal(result.results[0].ok,true);assert.equal(result.routeScope,'selected-node');
});
