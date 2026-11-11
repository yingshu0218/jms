import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as adapters from '../engine/sysproxy/adapters.mjs';
import { ProxyJournal, enableProxy, disableProxy, healIfNeeded } from '../engine/sysproxy/index.mjs';

const copy = value => structuredClone(value);
const KINDS = ['webproxy', 'securewebproxy', 'socksfirewallproxy'];
const proxy = (host, port, enabled) => ({ host, port, enabled, authenticated: false });
const original = () => ({ schema: 2, services: [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Wi-Fi', device: 'en0',
    webproxy: proxy('corp.example', 8080, true), securewebproxy: proxy('secure.example', 8443, false),
    socksfirewallproxy: proxy('socks.example', 1080, false), bypass: ['*.corp.example'],
    autoproxy: { url: 'https://pac.example/config.pac', enabled: true }, autodiscovery: true },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Ethernet', device: 'en1',
    webproxy: proxy('web.old.example', 3128, false), securewebproxy: proxy('tls.old.example', 3129, true),
    socksfirewallproxy: proxy('socks.old.example', 1081, true), bypass: [],
    autoproxy: { url: null, enabled: false }, autodiscovery: false },
] });

/** No command in this suite reaches the OS. Unsupported operations fail closed. */
class MemoryNetwork {
  state = original(); calls = []; readCount = 0; writeCount = 0;
  failReadAt = null; failWriteAt = null; failAfterWriteAt = null;
  noopWriteAt = null; malformedReadAt = null; beforeWrite = null;
  resetCounters() { this.calls = []; this.readCount = 0; this.writeCount = 0; }
  execute = async (cmd, args, options = {}) => {
    const write = cmd === 'networksetup' && args[0]?.startsWith('-set');
    this.calls.push({ cmd, args: [...args], input: options.input, write });
    if (write) {
      this.writeCount++;
      this.beforeWrite?.(this.writeCount, this.state);
      if (this.failWriteAt === this.writeCount) throw Error('injected mandatory write failure');
      if (this.noopWriteAt !== this.writeCount) this.mutate(args);
      if (this.failAfterWriteAt === this.writeCount) throw Error('injected failure after change');
      return '';
    }
    this.readCount++;
    if (this.failReadAt === this.readCount) throw Error('injected required read failure');
    if (this.malformedReadAt === this.readCount) return 'MALFORMED UNPARSEABLE OUTPUT';
    if (cmd === 'networksetup') {
      const [op, name] = args;
      if (op === '-listallnetworkservices') return 'An asterisk (*) denotes that a network service is disabled.\n' + this.state.services.map(s => s.name).join('\n') + '\n';
      if (op === '-listnetworkserviceorder') return 'An asterisk (*) denotes that a network service is disabled.\n' + this.state.services.map((s, i) => `(${i + 1}) ${s.name}\n(Hardware Port: ${s.name}, Device: ${s.device})\n`).join('\n');
      const service = this.state.services.find(s => s.name === name);
      if (!service) throw Error('service missing');
      for (const kind of KINDS) if (op === '-get' + kind) {
        const p = service[kind];
        return `Enabled: ${p.enabled ? 'Yes' : 'No'}\nServer: ${p.host ?? ''}\nPort: ${p.port ?? 0}\nAuthenticated Proxy Enabled: ${p.authenticated ? 1 : 0}\n`;
      }
      if (op === '-getautoproxyurl') return `URL: ${service.autoproxy.url ?? '(null)'}\nEnabled: ${service.autoproxy.enabled ? 'Yes' : 'No'}\n`;
      if (op === '-getproxyautodiscovery') return `Auto Proxy Discovery: ${service.autodiscovery ? 'On' : 'Off'}\n`;
      if (op === '-getproxybypassdomains') return service.bypass.length ? service.bypass.join('\n') + '\n' : `There aren't any bypass domains set on ${name}.\n`;
    }
    if (cmd === 'scutil') {
      const input = String(options.input ?? '');
      if (input.startsWith('list ')) return this.state.services.map((s, i) => `  subKey [${i}] = Setup:/Network/Service/${s.id}/Interface`).join('\n') + '\n';
      const match = /show Setup:\/Network\/Service\/([^/\s]+)(\/Interface)?/.exec(input);
      if (match) {
        const s = this.state.services.find(s => s.id === match[1]);
        if (!s) return '  No such key\n';
        return match[2] ? `<dictionary> {\n DeviceName : ${s.device}\n Hardware : Ethernet\n Type : Ethernet\n}\n` : `<dictionary> {\n UserDefinedName : ${s.name}\n}\n`;
      }
      if (args[0] === '--proxy') return '<dictionary> {\n HTTPEnable : 0\n HTTPSEnable : 0\n}\n';
    }
    if (cmd === 'route') return 'interface: en0\n';
    throw Error(`unexpected fake command: ${cmd} ${args.join(' ')} ${options.input ?? ''}`);
  };
  mutate([op, name, ...values]) {
    const s = this.state.services.find(s => s.name === name);
    if (!s) throw Error('service missing during write');
    for (const kind of KINDS) {
      if (op === '-set' + kind) { s[kind] = { enabled: true, host: values[0], port: Number(values[1]), authenticated: values[2] === 'on' }; return; }
      if (op === '-set' + kind + 'state') { s[kind].enabled = values[0] === 'on'; return; }
    }
    if (op === '-setautoproxystate') s.autoproxy.enabled = values[0] === 'on';
    else if (op === '-setautoproxyurl') { s.autoproxy.url = values[0] === '' || values[0] === '(null)' ? null : values[0]; s.autoproxy.enabled = true; }
    else if (op === '-setproxyautodiscovery') s.autodiscovery = values[0] === 'on';
    else if (op === '-setproxybypassdomains') s.bypass = values[0] === 'Empty' ? [] : values;
    else throw Error('unexpected fake write: ' + op);
  }
}
function setup(t, network = new MemoryNetwork()) {
  assert.equal(typeof adapters.createDarwinAdapter, 'function', 'Darwin adapter must expose an injected executor');
  const dir = mkdtempSync(join(tmpdir(), 'jms-darwin-transaction-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { network, adapter: adapters.createDarwinAdapter({ execute: network.execute }), journal: new ProxyJournal(dir) };
}
const enable = h => enableProxy({ adapter: h.adapter, journal: h.journal, port: 2080 });
const disable = h => disableProxy({ adapter: h.adapter, journal: h.journal });
const heal = h => healIfNeeded({ adapter: h.adapter, journal: h.journal });

test('Darwin transaction: malformed and incomplete proxy reads never become off', () => {
  for (const output of ['', 'permission denied', 'Enabled: No\nServer: old.example\nPort: 8080\n', 'Enabled: Maybe\nServer: old.example\nPort: 8080\nAuthenticated Proxy Enabled: 0\n']) {
    assert.throws(() => adapters.parseMacProxy(output));
  }
});

test('Darwin transaction: complete snapshot preserves disabled endpoints and authenticated flag', async t => {
  const h = setup(t), snap = await h.adapter.snapshot();
  assert.deepEqual(snap.base, original());
  assert.equal(snap.base.services[0].securewebproxy.enabled, false);
  assert.equal(snap.base.services[0].securewebproxy.host, 'secure.example');
  assert.equal(h.network.writeCount, 0);
});

test('Darwin transaction: required read failure at every initial read causes zero writes', async t => {
  const baseline = setup(t); await baseline.adapter.snapshot();
  for (let step = 1; step <= baseline.network.readCount; step++) await t.test(`read ${step}`, async t => {
    const h = setup(t); h.network.failReadAt = step;
    await assert.rejects(() => enable(h)); assert.equal(h.network.writeCount, 0);
    assert.deepEqual(h.network.state, original());
  });
});

test('Darwin transaction: malformed required read causes zero writes', async t => {
  const baseline = setup(t); await baseline.adapter.snapshot();
  for (let step = 1; step <= baseline.network.readCount; step++) await t.test(`malformed read ${step}`, async t => {
    const h = setup(t); h.network.malformedReadAt = step;
    await assert.rejects(() => enable(h)); assert.equal(h.network.writeCount, 0);
  });
});

test('Darwin transaction: authentication and unrecoverable empty disabled endpoints are refused', async t => {
  for (const kind of KINDS) {
    for (const reason of ['authenticated', 'empty']) await t.test(`${kind} ${reason}`, async t => {
      const h = setup(t), p = h.network.state.services[0][kind];
      if (reason === 'authenticated') p.authenticated = true;
      else { p.enabled = false; p.host = null; p.port = null; }
      await assert.rejects(() => enable(h)); assert.equal(h.network.writeCount, 0);
    });
  }
});

test('Darwin transaction: successful enable and restore are exact including disabled stored values', async t => {
  const h = setup(t); await enable(h); assert.equal(h.journal.isPending(), true);
  for (const s of h.network.state.services) for (const kind of KINDS) assert.deepEqual(s[kind], proxy('127.0.0.1', 2080, true));
  await disable(h); assert.deepEqual(h.network.state, original()); assert.equal(h.journal.isPending(), false);
});

test('Darwin transaction: each apply command failure remains recoverable', async t => {
  const baseline = setup(t); await enable(baseline); const count = baseline.network.writeCount;
  for (const after of [false, true]) for (let step = 1; step <= count; step++) await t.test(`apply ${step} ${after ? 'after' : 'before'}`, async t => {
    const h = setup(t); h.network[after ? 'failAfterWriteAt' : 'failWriteAt'] = step;
    await assert.rejects(() => enable(h));
    h.network.failAfterWriteAt = h.network.failWriteAt = null;
    if (h.journal.isPending()) await heal(h);
    assert.deepEqual(h.network.state, original()); assert.equal(h.journal.isPending(), false);
  });
});

test('Darwin transaction: each restore command failure retains journal until verified retry', async t => {
  const baseline = setup(t); await enable(baseline); baseline.network.resetCounters(); await disable(baseline); const count = baseline.network.writeCount;
  for (const after of [false, true]) for (let step = 1; step <= count; step++) await t.test(`restore ${step} ${after ? 'after' : 'before'}`, async t => {
    const h = setup(t); await enable(h); h.network.resetCounters(); h.network[after ? 'failAfterWriteAt' : 'failWriteAt'] = step;
    await assert.rejects(() => disable(h)); assert.equal(h.journal.isPending(), true);
    h.network.failAfterWriteAt = h.network.failWriteAt = null;
    await heal(h); assert.deepEqual(h.network.state, original()); assert.equal(h.journal.isPending(), false);
  });
});

test('Darwin transaction: false exit-zero during restore never clears journal', async t => {
  const h = setup(t); await enable(h); h.network.resetCounters(); h.network.noopWriteAt = 1;
  await assert.rejects(() => disable(h)); assert.equal(h.journal.isPending(), true);
  h.network.noopWriteAt = null; await heal(h); assert.deepEqual(h.network.state, original());
});

test('Darwin transaction: external changes in any service prevent every restore write', async t => {
  const changes = [s => { s.webproxy.host = 'external.example'; }, s => { s.bypass = ['outside.example']; }, s => { s.autoproxy.url = 'https://outside.example/proxy'; }, s => { s.securewebproxy.authenticated = true; }];
  for (const [i, change] of changes.entries()) await t.test(`external field ${i}`, async t => {
    const h = setup(t); await enable(h); change(h.network.state.services[1]); const changed = copy(h.network.state); h.network.resetCounters();
    await assert.rejects(() => disable(h)); assert.equal(h.network.writeCount, 0); assert.equal(h.journal.isPending(), true); assert.deepEqual(h.network.state, changed);
  });
});

test('Darwin transaction: service deleted, renamed, rebound or recreated blocks restore before writes', async t => {
  const changes = [s => { s.services.pop(); }, s => { s.services[1].name = 'Renamed'; }, s => { s.services[1].device = 'en99'; }, s => { s.services[1].id = '33333333-3333-4333-8333-333333333333'; }];
  for (const [i, change] of changes.entries()) await t.test(`service identity ${i}`, async t => {
    const h = setup(t); await enable(h); change(h.network.state); h.network.resetCounters();
    await assert.rejects(() => heal(h)); assert.equal(h.network.writeCount, 0); assert.equal(h.journal.isPending(), true);
  });
});

test('Darwin transaction: cross-platform and incomplete journals are retained without writes', async t => {
  for (const damage of [entry => { entry.platform = 'linux'; }, entry => { delete entry.previousBase.services[0].securewebproxy; }, entry => { delete entry.previousBase.services[0].id; }, entry => { delete entry.previousBase.schema; }]) await t.test('invalid saved identity/schema', async t => {
    const h = setup(t); await enable(h); const entry = JSON.parse(readFileSync(h.journal.file, 'utf8')); damage(entry); writeFileSync(h.journal.file, JSON.stringify(entry)); h.network.resetCounters();
    await assert.rejects(() => heal(h)); assert.equal(h.network.writeCount, 0); assert.equal(h.journal.isPending(), true);
  });
});

test('Darwin transaction: already restored exact snapshot is idempotent and requires no writes', async t => {
  const h = setup(t); await enable(h); h.network.state = original(); h.network.resetCounters();
  await heal(h); assert.equal(h.network.writeCount, 0); assert.equal(h.journal.isPending(), false);
});

test('Darwin transaction: false exit-zero during apply is rejected and retains recovery evidence', async t => {
  const h = setup(t); h.network.noopWriteAt = 1;
  await assert.rejects(() => enable(h)); assert.equal(h.journal.isPending(), true);
  h.network.noopWriteAt = null; await heal(h);
  assert.deepEqual(h.network.state, original()); assert.equal(h.journal.isPending(), false);
});

test('Darwin transaction: each restore readback boundary and final verification failure retains journal', async t => {
  const baseline = setup(t); await enable(baseline); baseline.network.resetCounters(); await disable(baseline);
  let reads = 0, afterWrite = false;
  const boundaries = new Set([1, baseline.network.readCount]);
  for (const call of baseline.network.calls) {
    if (call.write) afterWrite = true;
    else { reads++; if (afterWrite) { boundaries.add(reads); afterWrite = false; } }
  }
  for (const step of boundaries) await t.test(`restore readback ${step}`, async t => {
    const h = setup(t); await enable(h); h.network.resetCounters(); h.network.failReadAt = step;
    await assert.rejects(() => disable(h)); assert.equal(h.journal.isPending(), true);
    h.network.failReadAt = null; await heal(h);
    assert.deepEqual(h.network.state, original()); assert.equal(h.journal.isPending(), false);
  });
});
