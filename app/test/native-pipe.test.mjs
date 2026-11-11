import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeFrameDecoder } from '../engine/native-proxy.mjs';
const bounded=(promise,ms)=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('owned fixture deadline')),ms);promise.finally(()=>clearTimeout(timer)).catch(()=>{});})]);
async function until(predicate,ms) { const deadline=performance.now()+ms;while(!predicate()){if(performance.now()>=deadline)throw Error('owned fixture deadline');await new Promise(r=>setTimeout(r,5));} }
test('real isolated Node stdio speaks only private frames, refuses Candidate authorization, and exits on owned SIGTERM',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'jms-private-pipe-'));
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const launch='11111111-1111-4111-8111-111111111111',token='fixture-bearer-not-a-real-credential-12345',frames=[],errors=[];
 const child=spawn(process.execPath,['app/engine/server.mjs','--isolated','--native-control','--dir',dir,'--port',String(port)],{cwd:new URL('../..',import.meta.url),env:{...process.env,JMS_API_TOKEN:token,JMS_INSTANCE_ID:launch},stdio:['pipe','pipe','pipe']});
 const exit=once(child,'exit');const codec=new NativeFrameDecoder(frame=>frames.push(frame),error=>errors.push(error));
 child.stdout.on('data',chunk=>codec.push(chunk));child.stderr.resume();child.stdin.on('error',()=>{});
 try{
  await until(()=>{if(child.exitCode!==null)throw Error('owned fixture exited early');return frames.length>0;},10000);
  assert.deepEqual(frames[0],{version:1,type:'hello',launchId:launch});assert.equal(errors.length,0);
  child.stdin.write(JSON.stringify({version:1,type:'begin',launchId:launch,operationId:'22222222-2222-4222-8222-222222222222',action:'connect'})+'\n');
  await until(()=>frames.length>=2,1000);
  assert.equal(frames[1].code,'ISOLATED');assert.equal(frames.some(f=>f.type==='helper'),false);
  const state=await fetch(`http://127.0.0.1:${port}/api/state`,{headers:{Authorization:'Bearer '+token}});assert.equal(state.status,200);
  const snapshot=await state.json();assert.equal(snapshot.status.running,false);assert.equal(snapshot.status.pendingProxyJournal,false);
  child.kill('SIGTERM'); // Only this recorded child; no other PID/service is touched.
  await bounded(exit,5000);assert.equal(child.exitCode,0);assert.equal(errors.length,0);
 }finally{
  child.stdin.end();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  await bounded(exit,5000);codec.end();rmSync(dir,{recursive:true,force:true});
 }
});
