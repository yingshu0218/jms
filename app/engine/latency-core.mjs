// A private, short-lived core: no inbounds, no TUN, no system proxy or routes.
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildOutbounds } from '../core/to-singbox.mjs';
import { ClashApi } from './clash-api.mjs';
import { CoreSupervisor } from './supervisor.mjs';

export async function withLatencyCore(binaryPath, nodes, work) {
  if (!binaryPath) throw new Error('找不到测速内核，请重新构建或安装应用');
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const dir = mkdtempSync(join(tmpdir(), 'jms-latency-'));
  const secret = randomBytes(32).toString('hex');
  const api = new ClashApi(`http://127.0.0.1:${port}`, { secret });
  const configPath = join(dir, 'config.json');
  let core;
  const stopOnExit = () => {
    const pid = core?.status().pid;
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  };
  try {
    writeFileSync(configPath, JSON.stringify({
      log: { disabled: true },
      dns: { servers: [{ type: 'local', tag: 'local' }] },
      route: { default_domain_resolver: 'local' },
      outbounds: buildOutbounds(nodes).outbounds,
      experimental: { clash_api: { external_controller: `127.0.0.1:${port}`, secret } },
    }), { mode: 0o600 });
    core = new CoreSupervisor({ binaryPath, configPath, workDir: dir, maxRestarts: 0, readyCheck: () => api.version() });
    process.once('exit', stopOnExit);
    await core.start();
    return await work(api);
  } finally {
    if (core) { await core.stop(); core.closeLog(); }
    process.removeListener('exit', stopOnExit);
    rmSync(dir, { recursive: true, force: true });
  }
}
