import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { AppService } from '../engine/app.mjs';
import { MockAdapter } from '../engine/sysproxy/adapters.mjs';
import { createAppServer } from '../engine/server.mjs';
import { TEST_SERVER_AUTH, authenticatedFetch } from './http-fixture.mjs';

async function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jms-http-'));
  const adapter = new MockAdapter({ mode: 'off' });
  const app = new AppService({ dir, adapter, ...options });
  let writes = 0;
  adapter.apply = async () => { writes++; throw Error('unexpected adapter call'); };
  const server = createAppServer({ app, port: 0, ...TEST_SERVER_AUTH });
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { app, server, base, writes: () => writes };
}
const post = (url, body, options = {}) => authenticatedFetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...options.headers }, body: JSON.stringify(body), ...options,
});

test('API：所有私有读取、事件及写入都必须认证，不把秘密放进快照', async t => {
  const { app, base, writes } = await setup(t);
  for (const path of ['/api/identity', '/api/state', '/api/events', '/api/logs', '/api/rules', '/api/profiles', '/api/connections']) {
    assert.equal((await fetch(base + path)).status, 401, path);
    assert.equal((await fetch(base + path, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  }
  const refused = await fetch(base + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"settings":{"port":3456}}' });
  assert.equal(refused.status, 401);
  assert.equal(app.store.state.settings.port, 2080);
  assert.equal(writes(), 0);
  const snapshot = await (await authenticatedFetch(base + '/api/state')).text();
  assert.ok(!snapshot.includes(TEST_SERVER_AUTH.authToken));
  assert.ok(!snapshot.includes(app.coreSecret));
  const identity = await (await authenticatedFetch(base + '/api/identity')).json();
  assert.equal(identity.instanceId, TEST_SERVER_AUTH.instanceId);
  assert.equal(identity.protocolVersion, 1);
});

test('API：拒绝跨源/伪造Host；畸形Host请求后服务继续可用', async t => {
  const { base, server, writes } = await setup(t);
  for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1:7788', 'tauri://localhost']) {
    assert.equal((await authenticatedFetch(base + '/api/state', { headers: { Origin: origin } })).status, 403);
  }
  const invalid = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path: '/api/state',
      headers: { Host: '[invalid', Authorization: `Bearer ${TEST_SERVER_AUTH.authToken}` } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    }); req.once('error', reject); req.end();
  });
  assert.equal(invalid, 403);
  assert.equal((await authenticatedFetch(base + '/api/state')).status, 200);
  assert.equal(writes(), 0);
});

test('API：非法设置不改状态或文件，不执行真实适配器', async t => {
  const { app, base, writes } = await setup(t);
  await app.updateSettings({ port: 2345 });
  const before = readFileSync(app.store.file, 'utf8');
  for (const settings of [{ mode: '../../escape' }, { port: '1234' }, { mode: null }, { clashApi: '0.0.0.0:9090' }, { unknown: true }]) {
    assert.equal((await post(base + '/api/settings', { settings })).status, 400);
    assert.equal(readFileSync(app.store.file, 'utf8'), before);
  }
  assert.equal(writes(), 0);
});

test('API：drain等待已进入变更，随后拒绝新写入且可恢复', async t => {
  const { app, base, writes } = await setup(t);
  let finish;
  const entered = new Promise(resolve => {
    app.profiles.save = async () => { resolve(); await new Promise(done => { finish = done; }); return { ok: true }; };
  });
  const mutation = post(base + '/api/profiles', {});
  await entered;
  const shutdown = post(base + '/api/shutdown?test=1', {});
  // 确认关闭处理已经进入，不依赖sleep调度。
  while (!app.draining) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await post(base + '/api/settings', { settings: { port: 3456 } })).status, 400);
  finish();
  assert.equal((await mutation).status, 200);
  assert.equal((await shutdown).status, 200);
  assert.equal(writes(), 0);
  assert.equal((await post(base + '/api/resume', {})).status, 200);
  assert.equal(app.draining, false);
});

test('隔离实例：禁用接管、提权、检测、测速和外部订阅', async t => {
  const { app, base, writes } = await setup(t, { isolated: true });
  assert.equal(app.store.state.settings.port, 12080);
  assert.equal(app.store.state.settings.clashApi, '127.0.0.1:19090');
  for (const path of ['/api/connect', '/api/elevate', '/api/linkcheck', '/api/latency']) {
    const response = await post(base + path, {});
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'ISOLATED');
  }
  assert.equal((await post(base + '/api/profiles', { url: 'https://not-a-real-subscription.invalid/fixture' })).status, 400);
  assert.equal(writes(), 0);
});

test('API：缺少实例认证配置或非回环监听直接拒绝', () => {
  assert.throws(() => createAppServer({ host: '0.0.0.0', ...TEST_SERVER_AUTH }));
  assert.throws(() => createAppServer({}));
});

test('API：STARTING、Content-Type和body上限都有受控错误且不改状态', async t => {
  const {app,base,writes}=await setup(t);
  app.ready=false;
  const starting=await authenticatedFetch(base+'/api/identity');
  assert.equal(starting.status,503);assert.equal((await starting.json()).code,'STARTING');
  app.ready=true;
  const before=JSON.stringify(app.store.state);
  assert.equal((await authenticatedFetch(base+'/api/settings',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{"settings":{"port":4567}}'})).status,415);
  assert.equal((await post(base+'/api/settings',{settings:null})).status,400);
  const large=await post(base+'/api/settings',{settings:{unknown:'x'.repeat(270*1024)}});
  assert.equal(large.status,400);
  assert.equal(JSON.stringify(app.store.state),before);assert.equal(writes(),0);
  assert.equal((await authenticatedFetch(base+'/api/state')).status,200);
});

test('API：认证SSE实际转发操作阶段事件', async t => {
  const {app,base}=await setup(t);
  const controller=new AbortController();t.after(()=>controller.abort());
  const response=await authenticatedFetch(base+'/api/events',{signal:controller.signal});
  assert.equal(response.status,200);
  const reader=response.body.getReader();
  const opening=await reader.read();assert.ok(Buffer.from(opening.value).toString().includes('connected'));
  app.emit('operation-progress',{stage:'fixture-stage',command:'fixture-only'});
  const event=await reader.read();const text=Buffer.from(event.value).toString();
  assert.ok(text.includes('event: operation-progress'));assert.ok(text.includes('fixture-stage'));
  await reader.cancel();
});
