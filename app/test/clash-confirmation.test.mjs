import test from 'node:test';
import assert from 'node:assert/strict';
import { ClashApi } from '../engine/clash-api.mjs';

function fixture(read, options = {}) {
  const calls = [];
  const api = new ClashApi('http://127.0.0.1:1', {
    secret: 'synthetic-fixture-only', confirmationTimeoutMs: 2000, confirmationIntervalMs: 1,
    ...options, fetchImpl: async (url, request) => {
      calls.push({ path: new URL(url).pathname, method: request.method || 'GET' });
      if (request.method === 'PATCH' || request.method === 'PUT') return new Response(null, {status: 204});
      return read(calls.filter(c => c.method === 'GET').length, url, request);
    },
  });
  return { api, calls };
}
const modeResponse = mode => new Response(JSON.stringify({mode,'mode-list':['rule','global','direct']}), {headers:{'content-type':'application/json'}});

test('Clash mode confirmation waits for old value to become requested value, PATCH only once', async () => {
  const {api,calls}=fixture(read => modeResponse(read === 1 ? 'Global' : '  RULE  '));
  assert.equal(await api.setMode('rule'),'rule');
  assert.equal(calls.filter(c=>c.method==='PATCH').length,1);
  assert.equal(calls.filter(c=>c.method==='GET').length,2);
});
test('Clash mode confirmation rejects a permanently old value instead of treating 204 as success', async () => {
  const {api,calls}=fixture(()=>modeResponse('rule'),{confirmationTimeoutMs:35});
  await assert.rejects(api.setMode('global'),{code:'CLASH_UNCONFIRMED'});
  assert.equal(calls.filter(c=>c.method==='PATCH').length,1);
});
test('Clash total confirmation deadline bounds an abort-ignoring GET', async () => {
  for (const bodyOnly of [false,true]) {
    const {api,calls}=fixture(()=>bodyOnly ? {ok:true,text:()=>new Promise(()=>{})} : new Promise(()=>{}),{confirmationTimeoutMs:35});
    await assert.rejects(api.setMode('global'),{code:'CLASH_UNCONFIRMED'});
    assert.equal(calls.filter(c=>c.method==='GET').length,1);
  }
});
test('Clash invalid mode and authentication failure never confirm success', async () => {
  for(const response of [()=>modeResponse('invalid-mode'),()=>new Response('{}',{status:401})]) {
    const {api,calls}=fixture(response);
    await assert.rejects(api.setMode('global'),{code:'CLASH_UNCONFIRMED'});
    assert.equal(calls.filter(c=>c.method==='GET').length,1);
  }
});
test('Clash same target still requires a readback, without redundant PATCH retries', async () => {
  const {api,calls}=fixture(()=>modeResponse('Global'));
  assert.equal(await api.setMode('global'),'global');
  assert.deepEqual(calls.map(c=>c.method),['PATCH','GET']);
});
test('Clash target response or body returned after total deadline cannot become late success', async () => {
  for (const bodyOnly of [false,true]) {
    let release;
    const {api,calls}=fixture(()=>bodyOnly
      ? {ok:true,text:()=>new Promise(resolve=>release=()=>resolve(JSON.stringify({mode:'global','mode-list':['rule','global','direct']})))}
      : new Promise(resolve=>release=()=>resolve(modeResponse('global'))),{confirmationTimeoutMs:35});
    await assert.rejects(api.setMode('global'),{code:'CLASH_UNCONFIRMED'});
    release();await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(calls.map(c=>c.method),['PATCH','GET']);
  }
});
test('Clash selector confirmation waits for exact now tag and rejects a mismatched tag', async () => {
  for(const succeeds of [true,false]) {
    const {api,calls}=fixture(read=>new Response(JSON.stringify({proxies:{proxy:{now:succeeds&&read>1?'B':'A'}}})),{confirmationTimeoutMs:succeeds?2000:35});
    if(succeeds) assert.equal(await api.select('proxy','B'),true);
    else await assert.rejects(api.select('proxy','B'),{code:'CLASH_UNCONFIRMED'});
    assert.equal(calls.filter(c=>c.method==='PUT').length,1);
    assert.ok(calls.filter(c=>c.method==='GET').length>=1);
  }
});
test('Clash PATCH consumes the same total budget as readback', async () => {
  let release;
  const calls=[];
  const api=new ClashApi('http://127.0.0.1:1',{confirmationTimeoutMs:35,fetchImpl:(url,request)=>{
    calls.push(request.method||'GET');
    return new Promise(resolve=>release=()=>resolve(new Response(null,{status:204})));
  }});
  await assert.rejects(api.setMode('global'),{code:'CLASH_UNCONFIRMED'});
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['PATCH']);
});
test('Clash missing registered target fails explicitly without repeated PATCH', async () => {
  const {api,calls}=fixture(()=>new Response(JSON.stringify({mode:'global','mode-list':['global','direct']})));
  await assert.rejects(api.setMode('rule'),{code:'CLASH_UNSUPPORTED_MODE'});
  assert.deepEqual(calls.map(c=>c.method),['PATCH','GET']);
});
test('Clash stops confirmation requests as soon as the owned PID/session guard fails', async () => {
  for(const duringRead of [true,false]) {
    let alive=true;
    const {api,calls}=fixture(()=>{
      if(duringRead)alive=false;else setTimeout(()=>{alive=false;},0);
      return modeResponse('rule');
    },{confirmationIntervalMs:10,assertCurrent:()=>{if(!alive)throw Object.assign(new Error('fixture old PID'),{code:'STALE_SESSION'});}});
    await assert.rejects(api.setMode('global'),{code:'STALE_SESSION'});
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(calls.map(c=>c.method),['PATCH','GET']);
  }
});
