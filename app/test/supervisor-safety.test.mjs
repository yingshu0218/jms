import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CoreSupervisor } from '../engine/supervisor.mjs';
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
class Clock {
  time = 0; timers = new Map();
  set = (fn, ms) => { const id = { unref() {} }; this.timers.set(id, { at: this.time + ms, fn }); return id; };
  clear = id => this.timers.delete(id);
  async tick(ms) {
    const end = this.time + ms; await flush();
    while (true) {
      const next = [...this.timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].fn(); await flush();
    }
    this.time = end; await flush();
  }
}
class FakeChild extends EventEmitter {
  exitCode = null; signalCode = null; killed = false; signals = [];
  stdout = new EventEmitter(); stderr = new EventEmitter(); autoExit = true;
  constructor(pid) { super(); this.pid = pid; }
  kill(signal) { this.killed = true; this.signals.push(signal); if (this.autoExit) queueMicrotask(() => this.exit(null, signal)); return true; }
  exit(code = 1, signal = null) { this.exitCode = code; this.signalCode = signal; this.emit('exit', code, signal); }
}
function setup(options = {}) {
  const clock = new Clock(), children = [], events = [], spawnOptions = [];
  const sup = new CoreSupervisor({ binaryPath: '/fake/core', configPath: '/fake/config',
    readyTimeoutMs: 20, restartDelayMs: 5, maxRestarts: 2,
    now: () => clock.time, setTimeoutImpl: clock.set, clearTimeoutImpl: clock.clear, readyCheck: async () => true,
    spawnImpl: (_file, _args, options) => { spawnOptions.push(options); const child = new FakeChild(100 + children.length); children.push(child); return child; }, ...options });
  for (const e of ['started', 'restarted', 'crash', 'giveup', 'stopped']) sup.on(e, () => events.push(e));
  return { sup, clock, children, events, spawnOptions };
}
test('supervisor safety: simultaneous starts share one child and pending readiness', async () => {
  const ready = deferred(), h = setup({ readyCheck: () => ready.promise });
  const first = h.sup.start(), second = h.sup.start();
  assert.equal(first, second); assert.equal(h.children.length, 1);
  ready.resolve(); await first; assert.deepEqual(h.events, ['started']);
  await h.sup.stop(); assert.equal(h.sup.status().pid, null);
});
test('supervisor safety: hung readyCheck has a monotonic hard deadline and child is reaped', async () => {
  const h = setup({ readyCheck: () => new Promise(() => {}), maxRestarts: 0 });
  const result = h.sup.start().catch(error => error); await h.clock.tick(20);
  assert.match((await result).message, /未在/);
  assert.deepEqual(h.children[0].signals, ['SIGTERM']);
  assert.equal(h.sup.isRunning(), false); assert.equal(h.sup.status().pid, null);
  assert.deepEqual(h.events, ['giveup']);
});
test('supervisor safety: stop cancels readiness and late success cannot report started', async () => {
  const ready = deferred(), h = setup({ readyCheck: () => ready.promise });
  const start = h.sup.start().catch(error => error); await flush();
  const stop = h.sup.stop(); assert.equal(h.sup.stop(), stop);
  await assert.rejects(h.sup.start(), /停止/); await stop; assert.ok((await start) instanceof Error);
  ready.resolve(); await flush();
  assert.equal(h.events.includes('started'), false); assert.equal(h.events.includes('crash'), false);
  assert.equal(h.children.length, 1); await h.sup.start(); assert.equal(h.children.length, 2); await h.sup.stop();
});
test('supervisor safety: exit plus readiness rejection uses one restart and ignores stale exit', async () => {
  const ready = deferred(); let calls = 0;
  const h = setup({ readyCheck: () => ++calls === 1 ? ready.promise : Promise.resolve() });
  const start = h.sup.start().catch(error => error); await flush(); h.children[0].exit(1); await flush();
  assert.ok((await start) instanceof Error); ready.reject(new Error('late rejection')); await flush();
  assert.equal(h.events.filter(x => x === 'crash').length, 1); assert.equal(h.sup.status().restarts, 1);
  await h.clock.tick(5); assert.equal(h.children.length, 2); assert.equal(h.sup.status().pid, 101);
  h.children[0].emit('exit', 1, null); await flush(); assert.equal(h.sup.status().pid, 101);
  assert.equal(h.events.filter(x => x === 'crash').length, 1); await h.sup.stop();
});
test('supervisor safety: restart timeout retains live child until exit before next spawn', async () => {
  let calls = 0; const h = setup({ readyCheck: () => ++calls === 2 ? new Promise(() => {}) : Promise.resolve() });
  await h.sup.start(); h.children[0].exit(1); await h.clock.tick(5); h.children[1].autoExit = false;
  await h.clock.tick(20); assert.equal(h.children.length, 2); assert.equal(h.sup.status().pid, 101);
  assert.equal(h.sup.isRunning(), true); assert.deepEqual(h.children[1].signals, ['SIGTERM']);
  await h.clock.tick(10); assert.equal(h.children.length, 2);
  h.children[1].exit(null, 'SIGTERM'); await h.clock.tick(5);
  assert.equal(h.children.length, 3); assert.equal(h.sup.status().pid, 102);
  assert.equal(h.events.filter(x => x === 'crash').length, 2); await h.sup.stop();
});
test('supervisor safety: unconfirmed termination keeps ownership and refuses replacement', async () => {
  const h = setup(); await h.sup.start(); h.children[0].autoExit = false;
  const stopped = h.sup.stop({ timeoutMs: 2 }).catch(error => error); await h.clock.tick(4);
  assert.match((await stopped).message, /尚未确认退出/);
  assert.equal(h.sup.status().pid, 100); assert.equal(h.sup.isRunning(), true);
  await assert.rejects(h.sup.start(), /旧内核/); assert.deepEqual(h.children[0].signals, ['SIGTERM', 'SIGKILL']);
  h.children[0].exit(null, 'SIGKILL'); await h.sup.stop(); await h.sup.start(); assert.equal(h.children.length, 2); await h.sup.stop();
});
test('supervisor safety: stop cancels restart timer and repeated exit cannot rearm it', async () => {
  const h = setup(); await h.sup.start(); h.children[0].exit(1); await h.sup.stop(); h.children[0].emit('exit', 1, null);
  await h.clock.tick(100); assert.equal(h.children.length, 1); assert.equal(h.clock.timers.size, 0);
});
test('supervisor safety: spawned core never receives engine API credentials', async () => {
  const previous = [process.env.JMS_API_TOKEN, process.env.JMS_INSTANCE_ID];
  process.env.JMS_API_TOKEN = 'test-only-not-real'; process.env.JMS_INSTANCE_ID = 'test-only';
  try { const h = setup(); await h.sup.start(); assert.equal(h.spawnOptions[0].env.JMS_API_TOKEN, undefined); assert.equal(h.spawnOptions[0].env.JMS_INSTANCE_ID, undefined); await h.sup.stop(); }
  finally { for (const [i, key] of ['JMS_API_TOKEN', 'JMS_INSTANCE_ID'].entries()) { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; } }
});
test('supervisor safety: failed readiness attempts obey one shared restart budget', async () => {
  const h = setup({ readyCheck: () => new Promise(() => {}), maxRestarts: 1 });
  const initial = h.sup.start().catch(error => error);
  await h.clock.tick(20); assert.ok((await initial) instanceof Error);
  await h.clock.tick(25);
  assert.equal(h.children.length, 2);
  assert.equal(h.events.filter(x => x === 'crash').length, 1);
  assert.equal(h.events.filter(x => x === 'giveup').length, 1);
  assert.equal(h.sup.status().pid, null); assert.equal(h.clock.timers.size, 0);
});
test('supervisor safety: synchronous spawn failure consumes one attempt without a phantom PID', async () => {
  const h = setup({ spawnImpl: () => { throw new Error('launch failed'); }, maxRestarts: 1 });
  const initial = h.sup.start().catch(error => error); assert.match((await initial).message, /launch failed/);
  await h.clock.tick(5);
  assert.equal(h.sup.status().pid, null);
  assert.equal(h.events.filter(x => x === 'crash').length, 1);
  assert.equal(h.events.filter(x => x === 'giveup').length, 1);
  assert.equal(h.clock.timers.size, 0);
});
