import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { AppService } from '../engine/app.mjs';
import { createAppServer } from '../engine/server.mjs';
import { TEST_SERVER_AUTH, authenticatedFetch } from './http-fixture.mjs';
const base = {schema:3,services:[{id:'11111111-1111-1111-1111-111111111111',name:'Fixture',device:'en0',proxies:{present:false,blob:null}}]};
function setup(t) {
 const dir=mkdtempSync(join(tmpdir(),'jms-limited-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const calls=[];const adapter={platform:'darwin',transactionVersion:3,read:async()=>({mode:'off'}),restore:async()=>{calls.push('restore');throw Error('must never authorize or write in boot');}};
 const app=new AppService({dir,adapter,nativeControl:true});
 app.journal.begin({platform:'darwin',previous:{mode:'off'},previousBase:base,target:{mode:'on',host:'127.0.0.1',port:2080},darwin:{schema:3,originalBase:base,targetBase:base}});
 return {app,calls};
}
test('Darwin pending journal boots limited-ready without restoration/authorization or clearing evidence',async t=>{
 const {app,calls}=setup(t),before=readFileSync(app.journal.file,'utf8');
 const result=await app.boot();assert.equal(result.recoveryRequired,true);assert.equal(calls.length,0);
 assert.equal(readFileSync(app.journal.file,'utf8'),before);assert.equal((await app.status()).recoveryRequired,true);
 assert.equal(app.startAutoRefresh({intervalMs:1}),null);assert.equal(app.refreshTimer,undefined);
 for(const operation of [()=>app.connect(),()=>app.updateSettings({port:2081}),()=>app.setRoutingMode('direct')]) await assert.rejects(operation,{code:'RECOVERY_REQUIRED'});
 await assert.rejects(()=>app.disconnect(),{code:'SYS_PROXY_AUTHORIZATION_REQUIRED'});
 assert.equal(calls.length,0);assert.equal(readFileSync(app.journal.file,'utf8'),before);
});
test('malformed pending evidence also stays visible and never enters a guessed recovery',async t=>{
 const {app,calls}=setup(t);writeFileSync(app.journal.file,'{invalid evidence');
 const result=await app.boot();assert.equal(result.recoveryRequired,true);assert.equal(calls.length,0);
 assert.equal(readFileSync(app.journal.file,'utf8'),'{invalid evidence');assert.equal((await app.status()).recoveryRequired,true);
});
test('limited-ready serves authenticated identity/state but refuses ordinary HTTP writes and fake userInitiated flags',async t=>{
 const {app,calls}=setup(t);await app.boot();app.ready=true;
 const server=createAppServer({app,port:0,...TEST_SERVER_AUTH});await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const baseURL=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await authenticatedFetch(baseURL+'/api/identity')).status,200);
 const snapshot=await (await authenticatedFetch(baseURL+'/api/state')).json();assert.equal(snapshot.status.recoveryRequired,true);
 for(const path of ['/api/connect','/api/settings','/api/routing-mode','/api/native-control','/api/disconnect']) {
  const response=await authenticatedFetch(baseURL+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userInitiated:true,action:'restore',settings:{port:2345},mode:'direct'})});
  assert.equal(response.status,400,path);
 }
 assert.equal(calls.length,0);assert.equal(app.journal.isPending(),true);
});
