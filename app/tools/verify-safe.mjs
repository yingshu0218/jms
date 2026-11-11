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
  // Separate counters/marker: retain the established 27-config gate above.
  // Positive cases traverse the same validation/build path as saved rules.
  const acceptedRules = [
    ...['(?i)^example\\.com$', '(?im-s:foo)', '(?P<name>foo)', '(?<name>foo)',
      '(?U)a+', '\\Afoo\\z', '[a-z0-9]+\\.example\\.com', 'a{1,1000}']
      .map(value => ({ type: 'domain_regex', value, outbound: 'proxy' })),
    ...['0.0.0.0/0', '255.255.255.255/32', '192.0.2.1', '::/0', '::1/128',
      '2001:db8::/32', '1:2:3:4:5:6:7:8', '::ffff:192.0.2.1/128']
      .map(value => ({ type: 'ip_cidr', value, outbound: 'direct' })),
  ];
  const { rulesDocument } = await import('../core/custom-rules.mjs');
  for (const rule of acceptedRules) {
    const validated = rulesDocument([rule]).rules;
    check(buildConfig(nodes, { customRules: validated }));
  }
  // Bypass UI validation deliberately: these are JavaScript-valid expressions
  // which Go/RE2 must reject, and malformed IP/CIDR typed directly into config.
  const rejectedRules = [
    ...['a(?=b)', 'a(?!b)', '(?<=a)b', '(?<!a)b', '(a)\\1', '(?<x>a)\\k<x>']
      .map(value => ({ domain_regex: [value], outbound: 'proxy' })),
    ...['999.1.2.3/24', '1.2.3.4/33', '::1/129', '1::2::3/64']
      .map(value => ({ ip_cidr: [value], outbound: 'direct' })),
  ];
  for (const [index, rule] of rejectedRules.entries()) {
    const config = buildConfig(nodes);
    config.route.rules.unshift(rule);
    const file = join(dir, `negative-${index}.json`);
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    const result = spawnSync(core, ['check', '-c', file], { encoding: 'utf8', timeout: 20_000 });
    if (result.error) throw result.error;
    if (result.signal || result.status === null) throw new Error('Negative config check terminated unexpectedly');
    if (result.status === 0) throw new Error(`Fixed core unexpectedly accepted negative rule ${index}`);
    // Nonzero alone is not enough: a missing file/loader failure is not a
    // successful rejection of this rule. Require the relevant parser diagnostic.
    const diagnostic = (result.stderr || '') + (result.stdout || '');
    const expected = rule.domain_regex ? /regexp|regular expression|regex|perl syntax|escape sequence/i : /prefix|CIDR|IP address|ParseAddr|ParsePrefix/i;
    if (!expected.test(diagnostic)) throw new Error(`Negative rule ${index} failed for an unrelated reason: ${diagnostic.slice(0, 500)}`);
  }
  console.log(`PASS fixed-core rule validation: ${acceptedRules.length} accepted, ${rejectedRules.length} rejected; check only`);

} finally { rmSync(dir, { recursive: true, force: true }); }
