import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { AppService } from '../engine/app.mjs';
import { MockAdapter } from '../engine/sysproxy/adapters.mjs';
import { validateSettings } from '../core/settings.mjs';
import { parseSubscription } from '../core/parse.mjs';
import { SAMPLE_PLAIN } from './sample.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jms-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new AppService({ dir, adapter: new MockAdapter({ mode: 'off' }) });
}

test('设置：拒绝未知字段、类型、端口及非回环内核 API', () => {
  for (const patch of [null, [], 'mode', { mode: '../../escape' }, { mode: '__proto__' },
    { mode: null }, { routingMode: 'bogus' }, { port: 0 }, { port: 65536 }, { port: '2080' },
    { selected: NaN }, { selected: 0.5 }, { autoRefreshMinutes: -1 }, { autoRefreshMinutes: 10081 },
    { directRules: 'true' }, { reverseApps: null }, { apps: ['unknown'] }, { customRules: {} },
    { clashApi: '0.0.0.0:9090' }, { clashApi: 'http://127.0.0.1:9090/path' }, { clashApi: '127.0.0.1:0' },
    { clashApi: '127.0.0.1:65536' }, { localDns: ':::::' }, { localDns: {} }, { remoteDns: 'http://dns.example' },
    { remoteDns: 'https://secret@dns.example' }, JSON.parse('{"__proto__":{"polluted":true}}'), { unexpected: 1 }]) {
    assert.throws(() => validateSettings(patch), undefined, JSON.stringify(patch));
  }
});

test('设置：所有字段校验完成前不写盘，不改变内存', async t => {
  const app = setup(t);
  await app.updateSettings({ port: 2345 });
  const before = readFileSync(app.store.file, 'utf8');
  await assert.rejects(() => app.updateSettings({ port: 3456, mode: '../../escape' }));
  assert.equal(app.store.state.settings.port, 2345);
  assert.equal(readFileSync(app.store.file, 'utf8'), before);
});

test('配置：只使用固定文件名；旧状态非法模式在任何文件或连接副作用前拒绝', async t => {
  const app = setup(t);
  app.store.write({ subscription: { nodes: parseSubscription(SAMPLE_PLAIN).nodes } });
  const meta = app.writeConfig();
  assert.equal(dirname(meta.configPath), app.varDir);
  assert.equal(meta.configPath, join(app.varDir, 'config-sysproxy.json'));
  const before = readdirSync(app.varDir);
  app.store.state.settings.mode = '../../escape';
  assert.throws(() => app.writeConfig(), /接管/);
  await assert.rejects(() => app.connect(), /接管/);
  assert.deepEqual(readdirSync(app.varDir), before);
  assert.equal(app.supervisor, null);
  assert.equal(app.journal.isPending(), false);
});

test('设置：合法更新与零自动刷新间隔仍可用', () => {
  const patch = { mode: 'tun-per-app', routingMode: 'direct', port: 2080, selected: 0,
    clashApi: '127.0.0.1:19090', autoRefreshMinutes: 0, directRules: false,
    localDns: '223.5.5.5', remoteDns: 'https://dns.example:8443/query?x=1',
    apps: ['chrome'], reverseApps: true, customRules: [] };
  assert.deepEqual(validateSettings(patch), patch);
});

test('设置：端口互相冲突被拒绝，节点索引严格而不保存NaN', async t => {
  const app = setup(t);
  app.store.write({ subscription: { nodes: parseSubscription(SAMPLE_PLAIN).nodes } });
  const before = readFileSync(app.store.file, 'utf8');
  for (const patch of [{ port: 9090 }, { port: 7788 }, { clashApi: '127.0.0.1:2080' }, { clashApi: '127.0.0.1:7788' }]) {
    await assert.rejects(() => app.updateSettings(patch), /端口/);
  }
  for (const index of [undefined, null, '1', NaN, 0.5, -1, 999]) await assert.rejects(() => app.selectNode(index), /索引/);
  assert.equal(readFileSync(app.store.file, 'utf8'), before);
});
