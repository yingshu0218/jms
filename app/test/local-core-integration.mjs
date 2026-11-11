// Explicit opt-in real-core gate. All listeners and destination addresses are
// loopback literals; no TUN inbound, DNS queries, downloads or system adapters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as tcpServer, connect } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CoreSupervisor } from '../engine/supervisor.mjs';
import { ClashApi } from '../engine/clash-api.mjs';
import { assertListenerOwnership } from '../engine/ports.mjs';
import { probe } from '../engine/net/proxy-request.mjs';
import { buildConfig, ROUTING_MODES } from '../core/to-singbox.mjs';
import { buildTunPerAppConfig } from '../core/per-app.mjs';

const binary = process.env.SING_BOX;
if (process.env.JMS_ALLOW_ISOLATED_CORE_TESTS !== '1' || !binary || !isAbsolute(binary))
  throw new Error('Explicit absolute SING_BOX and JMS_ALLOW_ISOLATED_CORE_TESTS=1 required');
assert.match(execFileSync(binary, ['version'], { encoding: 'utf8', timeout: 10000 }), /^sing-box version 1\.14\.3\s*$/m);

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = server => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
const sockets = new Set();
function track(socket) { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); return socket; }
const allocatedPorts = new Set();
async function unusedPort() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const s = tcpServer(); const p = await listen(s); await close(s);
    if (!allocatedPorts.has(p)) { allocatedPorts.add(p); return p; }
  }
  throw new Error('Cannot allocate unique loopback fixture port');
}

async function startCore(config, ownedPorts) {
  const dir = await mkdtemp(join(tmpdir(), 'jms-loopback-core-'));
  const configPath = join(dir, 'config.json');
  const apiPort = Number(config.experimental.clash_api.external_controller.split(':').at(-1));
  const secret = randomBytes(32).toString('hex');
  config.experimental.clash_api.secret = secret;
  // No shared persistent caches. Each test owns its config, logs and child.
  config.experimental.cache_file = { enabled: false };
  for (const inbound of config.inbounds) {
    assert.notEqual(inbound.type, 'tun');
    assert.equal(inbound.listen, '127.0.0.1');
  }
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const api = new ClashApi(`http://127.0.0.1:${apiPort}`, { secret, timeoutMs: 3000 });
  let core;
  core = new CoreSupervisor({ binaryPath: binary, configPath, workDir: dir,
    logFile: join(dir, 'core.log'), maxRestarts: 0, readyTimeoutMs: 10000,
    readyCheck: async () => {
      await assertListenerOwnership([...ownedPorts, apiPort], core.status().pid);
      return api.verifyOwnership();
    },
  });
  async function stop() {
    // Do not erase evidence/state if stopping our own child cannot be proved.
    await core.stop();
    assert.equal(core.isRunning(), false);
    await rm(dir, { recursive: true, force: true });
  }
  try { await core.start(); } catch (error) { await stop(); throw error; }
  const guardedApi = new Proxy(api, { get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    return async (...args) => {
      assert.equal(core.isRunning(), true, 'owned core must remain alive before sending credentials');
      await assertListenerOwnership([...ownedPorts, apiPort], core.status().pid);
      return value.apply(target, args);
    };
  } });
  return { api: guardedApi, stop };
}

async function mode(api, value) {
  await api.setMode(value);
  assert.equal(String(await api.getMode()).toLowerCase(), value);
}
async function selection(api, value) {
  await api.select('proxy', value);
  assert.equal(await api.currentSelection('proxy'), value);
}

test('fixed core: loopback-only mode traffic and TUN diagnostic boundary', { timeout: 150000 }, async t => {
  const cleanups = [];
  let ssConnections = 0;
  try {
    const target = httpServer((req, res) => { res.writeHead(req.url === '/missing' ? 404 : 204); res.end(); });
    target.on('connection', track);
    const targetPort = await listen(target);
    allocatedPorts.add(targetPort);
    cleanups.push(() => close(target));
    const url = `http://127.0.0.1:${targetPort}/ok`;
    assert.equal((await probe(url)).status, 204);
    const missing = await probe(`http://127.0.0.1:${targetPort}/missing`);
    assert.equal(missing.reachable, true);
    assert.equal(missing.ok, false);

    const ssPort = await unusedPort();
    const fixtureApiPort = await unusedPort();
    const password = randomBytes(24).toString('hex');
    const fixture = await startCore({
      log: { level: 'warn' },
      experimental: { clash_api: { external_controller: `127.0.0.1:${fixtureApiPort}` } },
      inbounds: [{ type: 'shadowsocks', tag: 'ss-fixture', listen: '127.0.0.1', listen_port: ssPort,
        network: 'tcp', method: 'aes-128-gcm', password }],
      outbounds: [{ type: 'direct', tag: 'direct' }], route: { final: 'direct' },
    }, [ssPort]);
    cleanups.push(fixture.stop);
    // Count actual encrypted TCP traffic, not just API intent or HTTP success.
    const relay = tcpServer(client => {
      ssConnections++;
      track(client);
      const upstream = track(connect({ host: '127.0.0.1', port: ssPort }));
      client.pipe(upstream).pipe(client);
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
    });
    const relayPort = await listen(relay);
    allocatedPorts.add(relayPort);
    cleanups.push(() => close(relay));
    const badPort = await unusedPort();
    const nodes = [
      { type: 'shadowsocks', network: 'tcp', name: 'local-good', server: '127.0.0.1', server_port: relayPort, method: 'aes-128-gcm', password },
      { type: 'shadowsocks', network: 'tcp', name: 'local-dead', server: '127.0.0.1', server_port: badPort, method: 'aes-128-gcm', password },
    ];
    async function configOptions(routingMode) {
      return { routingMode, port: await unusedPort(), clashApi: `127.0.0.1:${await unusedPort()}`,
        // Never configure a public DNS endpoint, even though requests use IPs.
        localDns: '127.0.0.1', remoteDns: `https://127.0.0.1:${badPort}/dns-query` };
    }
    async function request(port) { return probe(url, { proxy: { host: '127.0.0.1', port }, timeoutMs: 2000 }); }
    for (const cold of ROUTING_MODES) await t.test(`sysproxy cold=${cold}: all directed transitions`, async () => {
      const opts = await configOptions(cold);
      const instance = await startCore(buildConfig(nodes, opts), [opts.port]);
      try {
        assert.equal(String(await instance.api.getMode()).toLowerCase(), cold);
        await selection(instance.api, 'local-good');
        for (const from of ROUTING_MODES) for (const to of ROUTING_MODES) {
          await mode(instance.api, from);
          await mode(instance.api, to);
          assert.equal(await instance.api.currentSelection('proxy'), 'local-good');
          const before = ssConnections;
          const response = await request(opts.port);
          assert.equal(response.ok, true, `${from}->${to}: ${JSON.stringify(response)}`);
          assert.equal(response.status, 204);
          // Loopback is private: rule/direct use direct; global uses SS.
          assert.equal(ssConnections > before, to === 'global', `${from}->${to} actual SS path`);
        }
        await mode(instance.api, 'global');
        await selection(instance.api, 'local-dead');
        assert.equal((await request(opts.port)).ok, false);
        await mode(instance.api, 'direct');
        assert.equal((await request(opts.port)).status, 204, 'direct remains independently reachable');
      } finally { await instance.stop(); }
    });
    for (const reverseApps of [false, true]) for (const apps of [[], ['antigravity']]) {
      await t.test(`TUN rules without TUN inbound: reverse=${reverseApps}, apps=${apps.length}`, async () => {
        const opts = await configOptions('rule');
        const { config } = buildTunPerAppConfig(nodes, { ...opts, debugPort: opts.port, platform: 'darwin', apps, reverseApps });
        // The only TUN-specific modification: remove the capturing inbound.
        // Keep route/DNS/process/mixed diagnostic rules exactly as generated.
        config.inbounds = config.inbounds.filter(i => i.type !== 'tun');
        const instance = await startCore(config, [opts.port]);
        try {
          for (const current of ROUTING_MODES) {
            await mode(instance.api, current);
            await selection(instance.api, 'local-dead');
            const before = ssConnections;
            assert.equal((await probe(url)).status, 204);
            assert.equal((await request(opts.port)).ok, false, `${current}: dead proxy cannot be masked by direct`);
            assert.equal(ssConnections, before);
            await selection(instance.api, 'local-good');
            const response = await request(opts.port);
            assert.equal(response.ok, true, JSON.stringify(response));
            assert.equal(response.status, 204);
            assert.ok(ssConnections > before, 'diagnostic must traverse SS even in direct mode');
          }
        } finally { await instance.stop(); }
      });
    }
  } finally {
    // Destroy only sockets created and tracked by this fixture, then owned cores.
    for (const socket of sockets) socket.destroy();
    const failures = [];
    for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch (e) { failures.push(e); } }
    if (failures.length) throw new AggregateError(failures, 'fixture cleanup failed');
  }
});
