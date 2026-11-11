import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildConfig,
  buildDnsConfig,
  buildRouteRules,
  ROUTING_MODES,
  SELECTOR_TAG,
} from '../core/to-singbox.mjs';
import { parseSubscription } from '../core/parse.mjs';
import { ClashApi } from '../engine/clash-api.mjs';
import { CoreSupervisor, resolveCoreBinary } from '../engine/supervisor.mjs';
import { SAMPLE_PLAIN } from './sample.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'jms-mode-'));
const CORE = process.env.SING_BOX || resolveCoreBinary();
const nodes = () => parseSubscription(SAMPLE_PLAIN).nodes;

// ══════════════════ 三档路由模式 ══════════════════

test('模式：只接受 rule / global / direct 三档', () => {
  assert.deepEqual(ROUTING_MODES, ['rule', 'global', 'direct']);
  assert.throws(() => buildConfig(nodes(), { routingMode: 'turbo' }), /未知的路由模式/);
});

test('★ 规则模式：模式守卫在最前、国内直连、其余走代理', () => {
  const cfg = buildConfig(nodes(), { routingMode: 'rule', ruleSetPaths: { 'geoip-cn': '/x/geoip-cn.srs' } });
  const r = cfg.route.rules;
  assert.equal(r[0].clash_mode, 'direct', '模式守卫必须放最前，否则会被后续规则抢先匹配');
  assert.equal(r[0].outbound, 'direct');
  assert.equal(r[1].clash_mode, 'global');
  assert.equal(r[1].outbound, SELECTOR_TAG);
  assert.ok(r.some((x) => x.rule_set === 'geoip-cn' && x.outbound === 'direct'), '国内地址应直连');
  assert.equal(cfg.route.final, SELECTOR_TAG, '兜底走代理');
});

test('★ 全局模式：保留国内规则供热切，运行时全局守卫优先', () => {
  const cfg = buildConfig(nodes(), { routingMode: 'global', ruleSetPaths: { 'geoip-cn': '/x/geoip-cn.srs' } });
  assert.ok(cfg.route.rules.some((x) => x.rule_set === 'geoip-cn'), '必须保留热切规则档所需规则');
  assert.equal(cfg.route.final, SELECTOR_TAG);
  const g = cfg.route.rules.find((x) => x.clash_mode === 'global');
  assert.equal(g.outbound, SELECTOR_TAG);
});

test('★ 直连模式：全部直连（客户端保持运行但不使用代理）', () => {
  const cfg = buildConfig(nodes(), { routingMode: 'direct' });
  const d = cfg.route.rules.find((x) => x.clash_mode === 'direct');
  assert.equal(d.outbound, 'direct');
  assert.ok(!cfg.route.rules.some((x) => x.rule_set === 'geoip-cn'));
});

test('路由规则：没有规则集时退回内置域名后缀兜底（不代表失败）', () => {
  const { rules, ruleSet } = buildRouteRules({ routingMode: 'rule', ruleSetPaths: {} });
  assert.equal(ruleSet.length, 0);
  const fb = rules.find((x) => x.domain_suffix);
  assert.ok(fb && fb.outbound === 'direct');
  assert.ok(fb.domain_suffix.includes('.cn'));
});

// ══════════════════ ★ DNS 分流（本轮核心） ══════════════════

test('★ DNS：国内域名必须走本地解析器 —— 这是"直连却抖动"的根因', () => {
  const dns = buildDnsConfig({ routingMode: 'rule', ruleSetPaths: { 'geosite-cn': '/x/geosite-cn.srs' } });
  const cn = dns.rules.find((x) => x.rule_set === 'geosite-cn');
  assert.ok(cn, '要有针对国内域名的 DNS 规则');
  assert.equal(cn.server, 'local', '国内域名必须用本地解析器，否则就近 CDN 失效');
  assert.equal(dns.final, 'remote', '规则模式下其余域名走远端解析');
});

test('DNS：没有 geosite 规则集时退回内置后缀兜底', () => {
  const dns = buildDnsConfig({ routingMode: 'rule', ruleSetPaths: {} });
  const fb = dns.rules.find((x) => x.domain_suffix);
  assert.ok(fb);
  assert.equal(fb.server, 'local');
  assert.ok(fb.domain_suffix.includes('baidu.com'));
});

test('★ DNS：直连档全部本地解析（一个跨境 DNS 都不该有）', () => {
  const dns = buildDnsConfig({ routingMode: 'direct', ruleSetPaths: {} });
  assert.equal(dns.final, 'remote', '直连档靠运行时守卫，不改变热切兜底');
  assert.equal(dns.rules.find((x) => x.clash_mode === 'direct').server, 'local');
});

test('DNS：全局档兜底走远端', () => {
  const dns = buildDnsConfig({ routingMode: 'global', ruleSetPaths: {} });
  assert.equal(dns.final, 'remote');
  assert.equal(dns.rules.find((x) => x.clash_mode === 'global').server, 'remote');
});

test('DNS：本地解析器默认用系统解析器（就近解析最准）；指定地址时用该地址', () => {
  const sys = buildDnsConfig({ localDns: 'system' });
  assert.equal(sys.servers.find((s) => s.tag === 'local').type, 'local');
  const fixed = buildDnsConfig({ localDns: '223.5.5.5' });
  const s = fixed.servers.find((x) => x.tag === 'local');
  assert.equal(s.type, 'udp');
  assert.equal(s.server, '223.5.5.5');
});

test('DNS：远端解析器必须挂在代理出站上（否则解析请求会绕过代理）', () => {
  const dns = buildDnsConfig({});
  const remote = dns.servers.find((s) => s.tag === 'remote');
  assert.equal(remote.detour, SELECTOR_TAG);
});

test('DNS：进程级模式下，只把目标进程的解析送远端（其余本地）', () => {
  const dns = buildDnsConfig({ processNames: ['Antigravity.exe', 'language_server_x.exe'] });
  const p = dns.rules.find((x) => x.process_name);
  assert.ok(p, '进程级规则要在最前');
  assert.equal(p.server, 'remote');
  assert.deepEqual(dns.rules[0].process_name, ['Antigravity.exe', 'language_server_x.exe']);
  assert.equal(dns.rules[0].server, 'remote', '目标应用优先走远端，不被后续国内规则影响');
});

test('配置完整性：dns 段已被包含进主配置', () => {
  const cfg = buildConfig(nodes(), { routingMode: 'rule' });
  assert.ok(cfg.dns, '主配置必须带 dns 段');
  assert.equal(cfg.dns.servers.length, 2);
  assert.ok(cfg.dns.servers.some((s) => s.tag === 'local'));
  assert.ok(cfg.dns.servers.some((s) => s.tag === 'remote'));
});

// ══════════════════ 内核热切换（真跑） ══════════════════

test(
  '★ 实测：内核支持模式热切换 —— PATCH /configs 后 mode 真的变了，且没有重启内核',
  { skip: !CORE && '未找到 sing-box' },
  async () => {
    const dir = tmp();
    const proxyPort = 13720;
    const apiPort = 19720;
    const cfg = buildConfig(nodes(), {
      port: proxyPort,
      clashApi: `127.0.0.1:${apiPort}`,
      routingMode: 'rule',
    });
    // 用真实节点会连不通，但不影响模式切换的验证
    writeFileSync(join(dir, 'c.json'), JSON.stringify(cfg, null, 2));

    const api = new ClashApi(`http://127.0.0.1:${apiPort}`);
    const sup = new CoreSupervisor({
      binaryPath: CORE,
      configPath: join(dir, 'c.json'),
      logFile: join(dir, 'core.log'),
      readyCheck: () => api.version(),
    });

    try {
      await sup.start();
      const pid = sup.status().pid;

      const initial = await api.getMode();
      assert.equal(String(initial).toLowerCase(), 'rule', `初始模式应为 Rule，实际 ${initial}`);

      await api.setMode('global');
      const afterGlobal = await api.getMode();
      assert.equal(String(afterGlobal).toLowerCase(), 'global', `应为 Global，实际 ${afterGlobal}`);

      await api.setMode('direct');
      assert.equal(String(await api.getMode()).toLowerCase(), 'direct');

      await api.setMode('rule');
      assert.equal(String(await api.getMode()).toLowerCase(), 'rule');

      assert.equal(sup.status().pid, pid, '模式切换**不应重启内核**');
    } finally {
      await sup.stop();
      sup.closeLog();
    }
  },
);

test('模式热切换失败时应返回可读原因，而不是静默', async () => {
  const api = new ClashApi('http://127.0.0.1:1', { timeoutMs: 800 });
  await assert.rejects(() => api.setMode('global'));
});

test('DoH 地址、端口和路径分开生成，拒绝凭据与非 HTTPS', () => {
 const remote = buildDnsConfig({remoteDns:'https://dns.example.com:8443/custom-query?x=1'}).servers.find(s=>s.tag==='remote');
 assert.equal(remote.server,'dns.example.com');
 assert.equal(remote.server_port,8443);
 assert.equal(remote.path,'/custom-query?x=1');
 assert.equal(remote.domain_resolver,'local');
 assert.equal(remote.detour,SELECTOR_TAG);
 assert.throws(()=>buildDnsConfig({remoteDns:'http://1.1.1.1/dns-query'}));
 assert.throws(()=>buildDnsConfig({remoteDns:'https://secret@dns.example.com/'}));
});

test('大陆 IP 分流前先解析域名', () => {
 const {rules}=buildRouteRules({routingMode:'rule',ruleSetPaths:{'geoip-cn':'/local/cn.srs'}});
 const resolve=rules.findIndex(r=>r.action==='resolve');
 assert.ok(resolve>=0 && resolve<rules.findIndex(r=>r.rule_set==='geoip-cn'));
});
