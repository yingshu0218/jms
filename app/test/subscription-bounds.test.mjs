import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSubscription } from '../engine/subscription.mjs';
const url = 'https://subscription.invalid/SECRET';
test('stream byte limit rejects content without leaking URL',async()=>{
 await assert.rejects(fetchSubscription(url,{maxBytes:3,fetchImpl:async()=>new Response('1234')}),e=>/limit/.test(e.message)&&!e.message.includes('SECRET'));
});
test('redirect downgrade and infinite chain rejected',async()=>{
 await assert.rejects(fetchSubscription(url,{fetchImpl:async()=>new Response(null,{status:302,headers:{location:'http://subscription.invalid/SECRET'}})}),/downgrade/);
 let calls=0;
 await assert.rejects(fetchSubscription(url,{maxRedirects:2,fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location:'/again'}})}}),/redirect limit/);
 assert.equal(calls,3);
});
test('slow stream deadline applies even if fixture ignores abort',async()=>{
 await assert.rejects(fetchSubscription(url,{timeoutMs:15,fetchImpl:async()=>new Response(new ReadableStream({start(){}}))}),/超时/);
});
test('fetch failure is sanitized',async()=>{
 await assert.rejects(fetchSubscription(url,{fetchImpl:async()=>{throw new Error(url)}}), e=>!e.message.includes('SECRET'));
});
test('chunked multibyte body uses bytes not characters',async()=>{
 let cancelled = false;
 const body = new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('测'));c.enqueue(new TextEncoder().encode('试'));},cancel(){cancelled=true;}});
 await assert.rejects(fetchSubscription(url,{maxBytes:5,fetchImpl:async()=>new Response(body)}),/byte limit/);
 assert.equal(cancelled,true);
});
test('successful redirect is manual and cross-origin drops ETag',async()=>{
 const seen=[];
 const r=await fetchSubscription(url,{etag:'test',fetchImpl:async(u,o)=>{
  seen.push({u,headers:{...o.headers},redirect:o.redirect});
  return seen.length===1 ? new Response(null,{status:302,headers:{location:'https://other.invalid/sub'}}) : new Response('ok');
 }});
 assert.equal(r.body,'ok'); assert.equal(seen[0].redirect,'manual'); assert.equal(seen[1].headers['If-None-Match'],undefined);
});
test('slow fetch deadline and invalid redirects do not expose credentials',async()=>{
 await assert.rejects(fetchSubscription(url,{timeoutMs:10,fetchImpl:()=>new Promise(()=>{})}),/超时/);
 await assert.rejects(fetchSubscription(url,{fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://user:SECRET@other.invalid/'}})}),e=>e.code==='SUBSCRIPTION_URL'&&!e.message.includes('SECRET'));
});
test('malformed UTF-8 is rejected instead of silently changing node credentials', async () => {
 await assert.rejects(fetchSubscription(url, {fetchImpl: async () => new Response(Uint8Array.of(0x61, 0xc3, 0x28))}),
  e => e.code === 'SUBSCRIPTION_ENCODING' && !e.message.includes('SECRET'));
});
test('304 requires a matching conditional request, including after cross-origin redirect', async () => {
 await assert.rejects(fetchSubscription(url, {fetchImpl: async () => new Response(null, {status:304})}),
  e => e.code === 'SUBSCRIPTION_HTTP');
 let calls=0;
 await assert.rejects(fetchSubscription(url, {etag:'old', fetchImpl: async () => ++calls===1
  ? new Response(null, {status:302,headers:{location:'https://other.invalid/sub'}})
  : new Response(null, {status:304})}), e => e.code === 'SUBSCRIPTION_HTTP');
 const conditional = await fetchSubscription(url, {etag:'old', fetchImpl: async () => new Response(null,{status:304})});
 assert.deepEqual(conditional, {notModified:true,etag:'old'});
});
