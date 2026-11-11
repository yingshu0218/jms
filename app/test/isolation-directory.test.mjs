import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppService } from '../engine/app.mjs';
import { runEngine } from '../engine/entry.mjs';
import { TEST_SERVER_AUTH } from './http-fixture.mjs';

function directory(t) { const dir = mkdtempSync(join(tmpdir(), 'jms-dir-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const env = { JMS_API_TOKEN: TEST_SERVER_AUTH.authToken, JMS_INSTANCE_ID: TEST_SERVER_AUTH.instanceId };

test('隔离目录：正式state和活锁在拒绝启动后逐字不变', async t => {
  const dir = directory(t);
  const state = '{"settings":{"port":4567},"privateFixture":"do-not-modify"}';
  writeFileSync(join(dir, 'state.json'), state); writeFileSync(join(dir, 'app.lock'), String(process.pid));
  const before = readdirSync(dir).sort();
  await assert.rejects(() => runEngine({ argv: ['node', 'entry.mjs', '--isolated', '--dir', dir, '--port', '17788'], env }), /已有引擎/);
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), state);
  assert.equal(readFileSync(join(dir, 'app.lock'), 'utf8'), String(process.pid));
  assert.deepEqual(readdirSync(dir).sort(), before);
});

test('隔离目录：省略目录、现有正式数据或任何恢复日志均拒绝且不写Store', async t => {
  await assert.rejects(() => runEngine({ argv: ['node', 'entry.mjs', '--isolated'], env }), /显式/);
  const dir = directory(t); writeFileSync(join(dir, 'state.json'), '{corrupt fixture');
  assert.throws(() => new AppService({ dir, isolated: true }), /空目录/);
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), '{corrupt fixture');
  assert.deepEqual(readdirSync(dir), ['state.json']);
  const isolated = directory(t); new AppService({ dir: isolated, isolated: true });
  const journal = '{"previous":{"mode":"off"}}'; writeFileSync(join(isolated, 'sysproxy-journal.json'), journal);
  const before = readFileSync(join(isolated, 'state.json'), 'utf8');
  assert.throws(() => new AppService({ dir: isolated, isolated: true }), /恢复日志/);
  assert.equal(readFileSync(join(isolated, 'sysproxy-journal.json'), 'utf8'), journal);
  assert.equal(readFileSync(join(isolated, 'state.json'), 'utf8'), before);
});

test('隔离目录：正式名称大小写变体和符号链接别名均拒绝', async t => {
 const {mkdirSync,symlinkSync}=await import('node:fs');
 const root=directory(t), formal=join(root,'jms client');mkdirSync(formal);
 assert.throws(()=>new AppService({dir:formal,isolated:true}),/正式目录/);
 assert.deepEqual(readdirSync(formal),[]);
 const target=join(root,'target');mkdirSync(target);const alias=join(root,'candidate-alias');symlinkSync(target,alias,'dir');
 assert.throws(()=>new AppService({dir:alias,isolated:true}),/符号链接/);
 assert.deepEqual(readdirSync(target),[]);
});
