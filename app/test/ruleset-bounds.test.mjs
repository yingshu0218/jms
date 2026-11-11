import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureRuleSet, ruleSetDir, ruleSetPath } from '../engine/rulesets.mjs';
import bundled from '../engine/bundled-geoip.json' with { type: 'json' };
const old = Buffer.from(bundled.data, 'base64');
const LIMIT = 16 * 1024 * 1024;
const never = () => new Promise(() => {});
async function fixture(fn, fresh = false) {
  const dir = mkdtempSync(join(tmpdir(), 'jms-ruleset-bound-'));
  mkdirSync(ruleSetDir(dir));
  const path = ruleSetPath(dir, 'geosite-cn');
  writeFileSync(path, old);
  if (!fresh) utimesSync(path, new Date(0), new Date(0));
  try { await fn({ dir, path }); assert.deepEqual(readFileSync(path), old); assert.deepEqual(readdirSync(ruleSetDir(dir)), ['geosite-cn.srs']); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
async function finishes(operation) {
  let timer;
  try {
    const result = await Promise.race([operation, new Promise(resolve => { timer = setTimeout(() => resolve('HUNG'), 700); })]);
    assert.notEqual(result, 'HUNG', 'total deadline must not depend on cooperative abort');
    return result;
  } finally { clearTimeout(timer); }
}
function response({ length, encoding, chunks, stalled = false }) {
  const state = { reads: 0, cancelled: 0, arrayBuffers: 0 };
  const value = { ok: true, headers: new Headers({ ...(length === undefined ? {} : { 'content-length': String(length) }), ...(encoding ? { 'content-encoding': encoding } : {}) }),
    arrayBuffer: async () => { state.arrayBuffers++; throw Error('unbounded API forbidden'); },
    body: { getReader: () => ({
      read: () => { state.reads++; return stalled ? never() : Promise.resolve(chunks.length ? { done: false, value: chunks.shift() } : { done: true }); },
      cancel: () => { state.cancelled++; return never(); }, releaseLock() {},
    }) },
  };
  return { value, state };
}
for (const scenario of ['chunked', 'lying-small-length', 'decoded-stream']) test(`bounded ruleset: ${scenario}`, () => fixture(async ({ dir, path }) => {
  const { value, state } = response({ length: scenario === 'chunked' ? undefined : 5, encoding: scenario === 'decoded-stream' ? 'gzip' : undefined,
    chunks: Array.from({ length: 18 }, () => Buffer.alloc(1024 * 1024)) });
  let temporaryValidation = 0;
  assert.equal(await ensureRuleSet({ dir, name: 'geosite-cn', fetchImpl: async () => value, validateFile: async file => { if (file.endsWith('.tmp')) temporaryValidation++; } }), path);
  assert.equal(state.arrayBuffers, 0);
  assert.equal(state.reads, 17, 'actual decoded bytes enforce the limit, not Content-Length');
  assert.equal(state.cancelled, 1);
  assert.equal(temporaryValidation, 0);
}));
test('oversized declared length rejects before reading or validating download', () => fixture(async ({ dir }) => {
  const { value, state } = response({ length: LIMIT + 1, chunks: [old] });
  let validations = 0;
  await ensureRuleSet({ dir, name: 'geosite-cn', fetchImpl: async () => value, validateFile: async file => { if (file.endsWith('.tmp')) validations++; } });
  assert.equal(state.arrayBuffers, 0); assert.equal(state.reads, 0); assert.equal(validations, 0);
}));
for (const stage of ['fetch', 'reader', 'download-verify', 'fresh-cache-verify', 'fallback-cache-verify']) test(`hard total deadline covers ${stage}`, () => fixture(async ({ dir }) => {
  const { value, state } = response({ chunks: [old], stalled: stage === 'reader' });
  let cacheCalls = 0;
  const result = await finishes(ensureRuleSet({ dir, name: 'geosite-cn', timeoutMs: 35,
    fetchImpl: stage === 'fetch' ? never : stage === 'fallback-cache-verify' ? async () => { throw Error('https://secret.invalid/token'); } : async () => value,
    validateFile: async file => {
      if (!file.endsWith('.tmp')) cacheCalls++;
      if (stage === 'download-verify' || stage.endsWith('cache-verify')) return never();
    },
  }));
  assert.equal(result, null);
  assert.ok(cacheCalls <= 1, 'no repeated fallback validator after deadline');
  if (stage === 'reader') assert.equal(state.cancelled, 1);
}, stage === 'fresh-cache-verify'));

test('late successful verifier cannot rename after deadline or resurrect temporary file', () => fixture(async ({ dir, path }) => {
  let release;
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const verification = new Promise(resolve => { release = resolve; });
  const running = ensureRuleSet({ dir, name: 'geosite-cn', timeoutMs: 45,
    fetchImpl: async () => new Response(old),
    validateFile: async file => { assert.ok(file.endsWith('.tmp')); started(); await verification; },
  });
  await began;
  assert.equal(await finishes(running), null);
  assert.deepEqual(readFileSync(path), old);
  release();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(readdirSync(ruleSetDir(dir)), ['geosite-cn.srs']);
}));
