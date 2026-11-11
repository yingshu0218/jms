import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubscription, parseShareLink } from '../core/parse.mjs';
const id = '00000000-0000-4000-8000-000000000001';
const good = `vless://${id}@192.0.2.1:443?security=tls`;
test('flow YAML booleans and ordinary TLS retain types', () => {
 for (const value of [false, true]) {
  const {nodes} = parseSubscription(`proxies:\n  - {type: vless, server: 192.0.2.1, port: 443, uuid: ${id}, tls: ${value}}`);
  assert.equal(nodes[0].tls.enabled, value);
  assert.equal(nodes[0].security, value ? 'tls' : 'none');
 }
});
test('mixed invalid nodes are skipped without sharing credentials', () => {
 const r = parseSubscription(`${good}\nvless://SECRET@192.0.2.1:99999\n${good}&type=h2`);
 assert.equal(r.nodes.length, 1);
 assert.equal(r.skipped.length, 2);
 assert.ok(!JSON.stringify(r.skipped).includes('SECRET'));
});
test('trojan decoding and SIP002 IPv6 trailing slash', () => {
 assert.equal(parseShareLink('trojan://test%3Apass@192.0.2.1:443').password,'test:pass');
 const n = parseShareLink(`ss://${Buffer.from('aes-128-gcm:test-password').toString('base64url')}@[2001:db8::1]:443/`);
 assert.equal(n.server_port,443);
 assert.equal(n.server,'2001:db8::1');
 assert.throws(()=>parseShareLink('ss://aes-128-gcm:test@192.0.2.1:443?plugin=test'));
});
test('YAML bad node does not discard valid neighbors', () => {
 const r = parseSubscription(`proxies:\n - {type: ss, server: 192.0.2.1, port: 443, cipher: aes-128-gcm, password: test}\n - {type: ss, server: 192.0.2.1, port: -1, cipher: invalid, password: test}`);
 assert.equal(r.nodes.length,1); assert.equal(r.skipped.length,1);
});
test('node count rejects entire oversized subscription',()=>assert.throws(()=>parseSubscription(`${good}\n${good}`,{maxNodes:1}), /limit/i));
test('typed schema rejects malformed endpoint and protocol fields', () => {
 for (const port of ['0','65536','1.5','NaN','-1']) assert.throws(()=>parseShareLink(`vless://${id}@192.0.2.1:${port}`));
 for (const server of ['bad host','host/path','user@host']) assert.throws(()=>parseShareLink(`vless://${id}@${server}:443`));
 for (const fragment of ['uuid: false','uuid: null','uuid: {}']) {
  assert.equal(parseSubscription(`proxies:\n - {type: vless, server: 192.0.2.1, port: 443, ${fragment}}`).nodes.length,0);
 }
 for (const port of ['true','false','null','{}']) assert.equal(parseSubscription(`proxies:\n - {type: ss, server: 192.0.2.1, port: ${port}, password: test, cipher: aes-128-gcm}`).nodes.length,0);
});
test('legacy SS IPv6 and malformed transport are explicit', () => {
 const link = 'ss://' + Buffer.from('aes-128-gcm:test@[2001:db8::1]:443').toString('base64');
 assert.equal(parseShareLink(link).server,'2001:db8::1');
 const payload = Buffer.from(JSON.stringify({add:'192.0.2.1',port:443,id,net:'httpupgrade'})).toString('base64');
 assert.throws(()=>parseShareLink(`vmess://${payload}`));
 assert.throws(()=>parseShareLink('trojan://test@192.0.2.1:443?type=quic'));
});
test('nested YAML websocket and grpc options are preserved, unsupported headers rejected', () => {
 const base = `type: vless, server: 192.0.2.1, port: 443, uuid: ${id}, tls: true`;
 const r = parseSubscription(`proxies:\n - {${base}, network: ws, ws-opts: {path: /socket, headers: {Host: test.invalid}}, skip-cert-verify: false}\n - {${base}, network: grpc, grpc-opts: {grpc-service-name: test-service}}\n - {${base}, network: ws, ws-opts: {headers: {Authorization: SECRET}}}`);
 assert.equal(r.nodes.length,2); assert.equal(r.skipped.length,1);
 assert.deepEqual(r.nodes[0].ws,{path:'/socket',host:'test.invalid'});
 assert.equal(r.nodes[0].tls.insecure,false);
 assert.deepEqual(r.nodes[1].grpc,{service_name:'test-service'});
 assert.ok(!JSON.stringify(r.skipped).includes('SECRET'));
});

import { validateNode } from '../core/node-schema.mjs';
import { nodeToOutbound, buildOutbounds } from '../core/to-singbox.mjs';
const baseNode = () => ({ type:'vmess',server:'192.0.2.1',server_port:443,uuid:id });
test('final generation validates nested TLS without credential disclosure',()=>{
 for (const tls of [{enabled:true,insecure:'false'},{enabled:true,alpn:'h2'},{enabled:true,alpn:[false]},{enabled:true,utls:{enabled:'false'}},{enabled:true,reality:{enabled:'false',public_key:'SECRET'}},false,[]]) {
  assert.throws(()=>nodeToOutbound({...baseNode(),tls}), e=>e.code==='INVALID_NODE'&&!e.message.includes('SECRET'));
 }
 assert.throws(()=>buildOutbounds([{...baseNode(),server_port:'443'}]));
});
test('transport inferred for legacy fixtures but conflicts and missing objects reject',()=>{
 for (const patch of [{network:'ws'},{network:'grpc'},{network:'tcp',ws:{path:'/',host:''}},{ws:{path:'/',host:''},grpc:{service_name:''}},{ws:false},{grpc:{service_name:4}}]) assert.throws(()=>nodeToOutbound({...baseNode(),...patch}));
 assert.equal(nodeToOutbound({...baseNode(),ws:{path:'/test',host:''}}).transport.type,'ws');
 assert.equal(nodeToOutbound({...baseNode(),grpc:{service_name:'test'}}).transport.type,'grpc');
});
test('strict IP literals and safe integer ports; VMess defaults do not coerce',()=>{
 for (const server of ['127.1','2130706433','0x7f000001','192.000.2.1','999.0.0.1','2001:db8:::1']) assert.throws(()=>nodeToOutbound({...baseNode(),server}));
 for (const patch of [{alter_id:false},{cipher:false},{network:false},{flow:{}},{server_port:NaN},{server_port:Infinity},{server_port:1.5}]) assert.throws(()=>nodeToOutbound({...baseNode(),...patch}));
 assert.equal(nodeToOutbound(baseNode()).alter_id,0);
 assert.equal(nodeToOutbound({...baseNode(),server:'2001:db8::1'}).server,'2001:db8::1');
 const input=baseNode(); validateNode(input); assert.equal(input.alter_id,undefined);
});
test('VMess JSON scalars cannot bypass normalized schema via coercion',()=>{
 for (const patch of [{aid:false},{aid:{}},{net:false},{scy:false},{port:true}]) {
  const json={add:'192.0.2.1',port:443,id,...patch};
  assert.throws(()=>parseShareLink('vmess://'+Buffer.from(JSON.stringify(json)).toString('base64')));
 }
});
test('TLS disabled switches remain disabled rather than truthy defaults',()=>{
 const out=nodeToOutbound({...baseNode(),tls:{enabled:true,insecure:false,alpn:['h2'],utls:{enabled:false},reality:{enabled:false}}});
 assert.equal(out.tls.utls,undefined); assert.equal(out.tls.reality,undefined); assert.equal(out.tls.insecure,undefined);
 assert.deepEqual(out.tls.alpn,['h2']);
});
test('node name is bounded display text, never an unchecked core tag',()=>{
 for (const name of [false,{},'x'.repeat(257),'line\nSECRET','nul\0value','c1\u0085value']) {
  assert.throws(()=>nodeToOutbound({...baseNode(),name}),e=>e.code==='INVALID_NODE'&&!e.message.includes('SECRET'));
 }
 assert.equal(nodeToOutbound({...baseNode(),name:'x'.repeat(256)}).type,'vmess');
 assert.equal(nodeToOutbound(baseNode()).type,'vmess');
});
test('flow quoted scalars preserve whitespace and YAML escaping',()=>{
 const prefix='proxies:\n - {type: ss, server: 192.0.2.1, port: 443, cipher: aes-128-gcm, password: ';
 for (const [quoted, expected] of [['" keep spaces "',' keep spaces '],[String.raw`"a\"b"`,'a"b'],["'it''s test'","it's test"],[String.raw`"\u0061\x62\U00000063"`,'abc']]) {
  const result=parseSubscription(prefix+quoted+'}'); assert.equal(result.nodes.length,1); assert.equal(result.nodes[0].password,expected);
 }
});
test('flow syntax failures skip complete node rather than accept prefix',()=>{
 const base='{type: ss, server: 192.0.2.1, port: 443, cipher: aes-128-gcm, password: test';
 for (const value of [base,base+'} garbage',base+', port: 444}',base.replace('test','"unclosed')+'}',base+', ignored: [1, 2]}',base+', ignored: {x: 1, x: 2}}']) {
  const result=parseSubscription('proxies:\n - '+value); assert.equal(result.nodes.length,0); assert.equal(result.skipped.length,1);
 }
});
test('share ports require decimal digits',()=>{
 for (const port of ['0x1bb','4.43e2','+443',' 443']) assert.throws(()=>parseShareLink(`trojan://test@192.0.2.1:${port}`));
});
test('VMess optional strings and base64 UTF8 are not coerced or repaired',()=>{
 for (const key of ['alpn','sni','host','path','fp']) for (const value of [false,{},[]]) {
  const payload=Buffer.from(JSON.stringify({add:'192.0.2.1',port:443,id,tls:'tls',[key]:value})).toString('base64');
  assert.throws(()=>parseShareLink('vmess://'+payload));
 }
 const valid=Buffer.from(JSON.stringify({add:'192.0.2.1',port:443,id})).toString('base64');
 assert.throws(()=>parseShareLink('vmess://'+valid+'!'));
 const broken=Buffer.concat([Buffer.from(`{"add":"192.0.2.1","port":443,"id":"${id}","ps":"`),Buffer.from([255]),Buffer.from('"}')]);
 assert.throws(()=>parseShareLink('vmess://'+broken.toString('base64')));
 assert.equal(parseShareLink('vmess://'+valid.replace(/=+$/,'').replace(/(.{10})/g,'$1\n')).server_port,443);
});
test('nested quoted flow delimiters are data; incomplete nested maps and duplicate quoted keys reject',()=>{
 const prefix=`proxies:\n - {type: vless, server: 192.0.2.1, port: 443, uuid: ${id}, network: ws, ws-opts: `;
 const valid=parseSubscription(prefix+'{path: "/a,{b}", headers: {Host: "test.invalid"}}}');
 assert.equal(valid.nodes[0].ws.path,'/a,{b}');
 for (const suffix of ['{path: "/a"}} garbage','{path: "/a", "path": "/b"}}','{path: "bad\\q"}}','{path: "/a"}']) {
  assert.equal(parseSubscription(prefix+suffix).nodes.length,0);
 }
});
test('raw YAML optional scalars never coerce false null maps or arrays',()=>{
 const base=`type: vless, server: 192.0.2.1, port: 443, uuid: ${id}, tls: true`;
 for (const key of ['flow','servername','sni','client-fingerprint']) for (const value of ['false','null','{}','[]']) {
  const r=parseSubscription(`proxies:\n - {${base}, ${key}: ${value}}`); assert.equal(r.nodes.length,0,`${key}:${value}`);
 }
 for (const value of ['false','null','{}','[]']) {
  const r=parseSubscription(`proxies:\n - {${base}, reality-opts: {public-key: ${'A'.repeat(43)}, short-id: ${value}}}`);
  assert.equal(r.nodes.length,0,`short-id:${value}`);
 }
});
test('raw YAML option maps and presence must match transport',()=>{
 const base=`type: vless, server: 192.0.2.1, port: 443, uuid: ${id}, tls: true`;
 const patches=['network: ws, ws-opts: false','network: ws, ws-opts: null','network: grpc, grpc-opts: false','network: grpc, grpc-opts: []','network: ws, ws-opts: {headers: false}','network: ws, ws-opts: {headers: null}','network: ws, ws-opts: {headers: {Host: a.invalid, host: b.invalid}}','network: tcp, ws-opts: {}','network: ws, grpc-opts: {}','h2-opts: false','http-opts: null','reality-opts: false','reality-opts: []'];
 for (const patch of patches) assert.equal(parseSubscription(`proxies:\n - {${base}, ${patch}}`).nodes.length,0,patch);
 assert.equal(parseSubscription(`proxies:\n - {${base}, flow: '', servername: '', client-fingerprint: '', network: ws, ws-opts: {path: '', headers: {Host: ''}}}`).nodes.length,1);
});
test('YAML transport strings and protocol type have strict raw types',()=>{
 const base=`server: 192.0.2.1, port: 443, uuid: ${id}, tls: true`;
 for (const value of ['false','null','{}','[]']) {
  for (const patch of [`type: ${value}`,`type: vless, network: ${value}`,`type: vless, network: ws, ws-opts: {path: ${value}}`,`type: vless, network: ws, ws-opts: {headers: {Host: ${value}}}`,`type: vless, network: grpc, grpc-opts: {grpc-service-name: ${value}}`,`type: vless, reality-opts: ${value}`]) {
   assert.equal(parseSubscription(`proxies:\n - {${base}, ${patch}}`).nodes.length,0,patch);
  }
 }
});
