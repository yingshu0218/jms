import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClashApi } from '../engine/clash-api.mjs';
import { AppService } from '../engine/app.mjs';
import { MockAdapter } from '../engine/sysproxy/adapters.mjs';
import { createAppServer } from '../engine/server.mjs';

async function setup(t) {
 const calls=[];
 const core=createServer((req,res)=>{
   calls.push([req.method,req.url,req.headers.authorization]);
   if(req.method==='DELETE'){res.writeHead(204);res.end();return;}
   res.setHeader('content-type','application/json');res.end(JSON.stringify({uploadTotal:12,downloadTotal:34,connections:[{id:'one/a?b',metadata:{host:'local.test',network:'tcp'},upload:12,download:34,chains:['DIRECT'],rule:'Match'}]}));
 });core.listen(0,'127.0.0.1');await once(core,'listening');t.after(()=>{core.closeAllConnections();core.close();});
 const api=new ClashApi(`http://127.0.0.1:${core.address().port}`,{secret:'test-only'});
 const dir=mkdtempSync(join(tmpdir(),'jms-connections-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const app=new AppService({dir,adapter:new MockAdapter({mode:'off'}),clashApiFactory:()=>api});
 return {api,app,calls};
}
test('连接客户端：查询及单条/全部关闭，正确编码 ID 和授权',async t=>{
 const {api,calls}=await setup(t);
 assert.equal((await api.connections()).connections[0].metadata.host,'local.test');
 await api.closeConnection('one/a?b');await api.closeAllConnections();
 assert.deepEqual(calls,[['GET','/connections','Bearer test-only'],['DELETE','/connections/one%2Fa%3Fb','Bearer test-only'],['DELETE','/connections','Bearer test-only']]);
});
test('连接服务：停机空状态，拒绝无效关闭，不吞掉内核失败',async t=>{
 const {app,calls}=await setup(t);
 assert.deepEqual(await app.connections(),{running:false,connections:[],uploadTotal:0,downloadTotal:0});
 await assert.rejects(()=>app.closeConnections({all:true}),/未运行/);assert.equal(calls.length,0);
 app.supervisor={isRunning:()=>true};
 await assert.rejects(()=>app.closeConnections({id:''}),/请选择/);
 assert.equal((await app.connections()).downloadTotal,34);
 app.clashApiFactory=()=>({connections:async()=>{throw Error('test timeout');}});
 await assert.rejects(()=>app.connections(),/test timeout/);
 app.clashApiFactory=()=>({connections:async()=>({connections:null})});
 await assert.rejects(()=>app.connections(),/格式无效/);
});
test('连接 HTTP API：查询、单条及全部关闭，错误明确返回',async t=>{
 const {app,calls}=await setup(t);app.supervisor={isRunning:()=>true};
 const server=createAppServer({app,port:0});await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await (await fetch(base+'/api/connections')).json()).connections.length,1);
 const close=body=>fetch(base+'/api/connections/close',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await close({id:'one/a?b'})).status,200);assert.equal((await close({all:true})).status,200);
 assert.equal((await close({})).status,400);assert.equal(calls.length,3);
});
