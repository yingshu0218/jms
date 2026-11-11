import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { AppService } from '../engine/app.mjs';
import { MockAdapter, enableProxy, disableProxy, healIfNeeded } from '../engine/sysproxy/index.mjs';
import { assertPortsAvailable } from '../engine/ports.mjs';
import { parseSubscription } from '../core/parse.mjs';
import { SAMPLE_PLAIN } from './sample.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jms-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const adapter = new MockAdapter({ mode: 'on', host: 'corp.example', port: 3128 });
  const app = new AppService({ dir, adapter, coreBinary: '/fixture-only/not-an-executable', portsAvailable: async () => {}, ruleSetProvider: async () => ({}), clashApiFactory: () => ({ setMode: async()=>{}, getMode: async()=> 'rule', select: async()=>{}, currentSelection: async()=> app.nodeTags()[app.sessionSettings?.selected ?? 0] }) });
  app.store.write({ subscription: { nodes: parseSubscription(SAMPLE_PLAIN).nodes } });
  return { app, adapter };
}

class FakeSupervisor extends EventEmitter {
  running = false;
  async start() { this.running = true; return this.status(); }
  isRunning() { return this.running; }
  status() { return { running: this.running, pid: this.running ? 123 : null }; }
  async stop() { this.running = false; }
  closeLog() {}
}

test('连接：重复请求不覆盖拥有的内核和原始恢复快照', async t => {
  const { app, adapter } = setup(t);
  const supervisor = new FakeSupervisor(); supervisor.running = true;
  app.supervisor = supervisor;
  await enableProxy({ adapter, journal: app.journal, port: 2080 });
  app.store.markRuntime({ connected: true });
  const before = readFileSync(app.journal.file, 'utf8');
  const result = await app.connect();
  assert.equal(result.alreadyConnected, true);
  assert.equal(app.supervisor, supervisor);
  assert.equal(readFileSync(app.journal.file, 'utf8'), before);
  await app.disconnect();
  assert.equal(adapter.state.host, 'corp.example');
  assert.equal(adapter.state.port, 3128);
});

test('连接：孤立恢复日志与未连接旧supervisor都必须先清理', async t => {
  const { app, adapter } = setup(t);
  await enableProxy({ adapter, journal: app.journal, port: 2080 });
  await assert.rejects(() => app.connect(), /未清理/);
  app.journal.clear(); app.supervisor = new FakeSupervisor();
  await assert.rejects(() => app.connect(), /未清理/);
});

test('崩溃放弃：待生效模式改成TUN仍按journal恢复旧sysproxy', async t => {
  const { app, adapter } = setup(t);
  const supervisor = new FakeSupervisor();
  app.supervisorFactory = () => supervisor;
  await app.connect();
  await app.updateSettings({ mode: 'tun-per-app' });
  const gaveup = once(app, 'gaveup');
  supervisor.running = false;
  supervisor.emit('giveup', { restarts: 5 });
  await gaveup;
  assert.equal(app.journal.isPending(), false);
  assert.equal(adapter.state.host, 'corp.example');
  assert.equal(adapter.state.port, 3128);
});

test('崩溃放弃恢复与前台交易串行，不并发清除恢复日志', async t => {
  const {app,adapter}=setup(t);const supervisor=new FakeSupervisor();app.supervisorFactory=()=>supervisor;
  await app.connect();app.busy='fixture-foreground';supervisor.running=false;
  const recovered=once(app,'gaveup');supervisor.emit('giveup',{restarts:5});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.journal.isPending(),true);assert.equal(adapter.state.host,'127.0.0.1');
  app.busy=null;await recovered;
  assert.equal(app.journal.isPending(),false);assert.equal(adapter.state.host,'corp.example');assert.equal(app.busy,null);
});

test('等候中的旧giveup不能恢复或清除新supervisor的日志', async t => {
  const {app,adapter}=setup(t);const supervisor=new FakeSupervisor();app.supervisorFactory=()=>supervisor;
  await app.connect();app.busy='fixture-foreground';supervisor.running=false;
  const original=readFileSync(app.journal.file,'utf8');supervisor.emit('giveup',{restarts:5});
  app.supervisor=new FakeSupervisor();app.busy=null;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(readFileSync(app.journal.file,'utf8'),original);assert.equal(adapter.state.host,'127.0.0.1');
  await app.disconnect();
});

test('恢复：损坏/无效journal不能被当作缺失，更不能关闭用户原代理', async t => {
  const { app, adapter } = setup(t);
  for (const value of ['{bad json', 'null', '{}', '{"previous":{"mode":"unknown"}}', '{"previous":{"mode":"off"},"previousBase":[]}']) {
    writeFileSync(app.journal.file, value);
    const before = adapter.calls.length;
    await assert.rejects(() => disableProxy({ adapter, journal: app.journal }), { code: 'RECOVERY_REQUIRED' });
    await assert.rejects(() => healIfNeeded({ adapter, journal: app.journal }), { code: 'RECOVERY_REQUIRED' });
    assert.equal(adapter.calls.length, before);
    assert.equal(readFileSync(app.journal.file, 'utf8'), value);
  }
  app.journal.clear();
  const before = adapter.calls.length;
  assert.equal((await disableProxy({ adapter, journal: app.journal })).hadJournal, false);
  assert.equal(adapter.calls.length, before);
});

test('停机：恢复失败保留内核、journal与draining，允许显式重试', async t => {
  const { app, adapter } = setup(t);
  await enableProxy({ adapter, journal: app.journal, port: 2080 });
  const supervisor = new FakeSupervisor(); supervisor.running = true; app.supervisor = supervisor;
  adapter.failNext = true;
  await assert.rejects(() => app.shutdown());
  assert.equal(app.supervisor, supervisor);
  assert.equal(supervisor.running, true);
  assert.equal(app.journal.isPending(), true);
  assert.equal(app.draining, true);
  await assert.rejects(() => app.connect(), { code: 'DRAINING' });
  await app.shutdown();
  assert.equal(supervisor.running, false);
  assert.equal(app.journal.isPending(), false);
});

test('端口：已有监听器被前置拒绝，不触碰内核或系统设置', async t => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  await assert.rejects(() => assertPortsAvailable([server.address().port]), /已被占用/);
});

test('监听归属：只接受本次PID的精确回环端口', async () => {
  const { assertListenerOwnership } = await import('../engine/ports.mjs');
  const calls = [];
  await assertListenerOwnership([9090, 2080], 123, { platform: 'darwin', run: async (binary, args) => {
    calls.push({binary,args});return {stdout:'p123\nn127.0.0.1:'+args.find(a=>a.startsWith('-iTCP:')).slice(6)+'\n'};
  }});
  assert.equal(calls.length,2);assert.equal(calls[0].binary,'/usr/sbin/lsof');
  await assert.rejects(()=>assertListenerOwnership([9090],123,{run:async()=>({stdout:'p456\nn127.0.0.1:9090\n'})}),/本次/);
});

test('Clash身份：无鉴权旧API不能被当作本次内核', async t => {
  const { createServer } = await import('node:http');
  const { ClashApi } = await import('../engine/clash-api.mjs');
  const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('{"version":"fixture"}');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  await assert.rejects(()=>new ClashApi(`http://127.0.0.1:${server.address().port}`,{secret:'fixture-only-not-a-real-secret'}).verifyOwnership(),/未拒绝/);
});

test('竞争端口：规则下载期间新监听器出现，不能进入adapter或误认旧API就绪', async t => {
  const { app, adapter } = setup(t);
  const reserve = async () => { const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;await new Promise(r=>s.close(r));return port; };
  const port=await reserve(), apiPort=await reserve();
  app.store.write({settings:{port,clashApi:`127.0.0.1:${apiPort}`}});
  app.portsAvailable=assertPortsAvailable;
  let spawned=0;app.supervisorFactory=()=>{spawned++;return new FakeSupervisor();};
  const servers=[];
  app.ruleSetProvider=async()=>{
    const {createServer: httpServer}=await import('node:http');
    for(const p of [port,apiPort]) { const s=httpServer((_req,res)=>res.end('{"version":"old-unauthenticated"}'));s.listen(p,'127.0.0.1');await once(s,'listening');servers.push(s); }
    return {};
  };
  t.after(()=>{for(const s of servers){s.closeAllConnections();s.close();}});
  await assert.rejects(()=>app.connect(),/已被占用/);
  assert.equal(spawned,0);assert.equal(adapter.calls.length,0);assert.equal(app.journal.isPending(),false);
});
