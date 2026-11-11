// 只运行隔离单测与官方内核的只读check，不自动下载、运行代理或接管网络。
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_PLAIN } from '../test/sample.mjs';
import { parseSubscription } from '../core/parse.mjs';
import { buildConfig } from '../core/to-singbox.mjs';
import { buildTunPerAppConfig } from '../core/per-app.mjs';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const tests = spawnSync(process.execPath, ['tools/test-safe.mjs'], { cwd: appDir, stdio: 'inherit' });
if (tests.error) throw tests.error;
if (tests.status !== 0) process.exit(tests.status ?? 1);
const core = process.env.SING_BOX;
if (!core) {
  console.log('SKIP 官方内核check：未提供SING_BOX；未验证Swift编译、真实内核或宿主网络接管');
  process.exit(process.env.REQUIRE_CORE_CHECK === '1' ? 1 : 0);
}
const version = execFileSync(core, ['version'], { encoding: 'utf8', timeout: 10_000 }).split('\n')[0];
if (version.trim() !== 'sing-box version 1.14.3') throw new Error('只接受固定 sing-box 1.14.3 做配置门禁');
const dir = mkdtempSync(join(tmpdir(), 'jms-check-'));
const { nodes } = parseSubscription(SAMPLE_PLAIN);
let count = 0;
try {
  const check = config => {
    const file = join(dir, `config-${++count}.json`);
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    execFileSync(core, ['check', '-c', file], { timeout: 20_000, stdio: 'pipe' });
  };
  for (const routingMode of ['rule', 'global', 'direct']) {
    check(buildConfig(nodes, { routingMode }));
    for (const reverseApps of [false, true]) for (const apps of [[], ['chrome']]) for (const customRules of [[], [{ type: 'domain', value: 'fixture.invalid', outbound: 'direct' }]]) {
      check(buildTunPerAppConfig(nodes, { platform: 'darwin', routingMode, apps, reverseApps, customRules }).config);
    }
  }
  console.log(`PASS ${count}份macOS配置通过固定内核check；没有启动代理、TUN或改写系统设置`);
} finally { rmSync(dir, { recursive: true, force: true }); }
