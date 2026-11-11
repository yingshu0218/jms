// 进程级分流（TUN）· 路由模式与自定义规则的单测
//
// 这组测试存在的理由是一个真实缺陷：TUN 模式的配置生成**完全没有引用 clash_mode**，
// 于是界面上的三档路由按钮在 TUN 模式下点了没有任何效果 —— 而且
// setRoutingMode() 还会返回「切换成功」（clash_mode 确实通过 API 写进去了），
// 属于「报成功但没生效」的最坏一类 bug。
//
// 这里逐个断言三档模式在 TUN 配置里都真的有对应规则。

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTunPerAppConfig } from '../core/per-app.mjs';
import { FALLBACK_CN_SUFFIXES, SELECTOR_TAG } from '../core/to-singbox.mjs';

const NODES = [
  { type: 'vless', name: 'HK-01', server: '192.0.2.10', server_port: 443, uuid: '11111111-2222-3333-4444-555555555555' },
  { type: 'vless', name: 'JP-01', server: '192.0.2.11', server_port: 443, uuid: '11111111-2222-3333-4444-666666666666' },
];

const NAMES = ['Antigravity.exe', 'language_server_windows_x64.exe'];
const build = (opts = {}) =>
  buildTunPerAppConfig(NODES, { processNames: NAMES, platform: 'win32', ...opts });

const routeRules = (cfg) => cfg.route.rules;
const dnsRules = (cfg) => cfg.dns.rules;
const has = (arr, pred) => arr.some(pred);

// ── 第一层：谁走代理 ────────────────────────────────────────────────
test('TUN：兜底必须是直连 —— 没这条就没有「按应用分流」', () => {
  const { config } = build();
  assert.equal(config.route.final, 'direct');
});

test('TUN：目标应用兜底走代理，位于模式等价兜底之前', () => {
  const { config } = build();
  const last = routeRules(config).slice(0, -3).at(-1);
  assert.deepEqual(last, { process_name: NAMES, outbound: SELECTOR_TAG });
});

test('TUN：每条分流规则都限定在目标进程上，绝不误伤其他应用', () => {
  const { config } = build();
  for (const r of routeRules(config).slice(0, -3)) {
    // sniff / hijack-dns 是动作规则，不参与分流判定
    if (r.action || r.inbound?.includes('mixed-in')) continue;
    assert.deepEqual(r.process_name, NAMES, `规则没有进程限定：${JSON.stringify(r)}`);
  }
});

test('TUN：TUN 入站必须开 auto_route，mixed 调试口保留', () => {
  const { config } = build({ debugPort: 2080 });
  const tun = config.inbounds.find((i) => i.type === 'tun');
  const mixed = config.inbounds.find((i) => i.type === 'mixed');
  assert.equal(tun.auto_route, true);
  assert.equal(mixed.listen_port, 2080);
});

test('TUN：必须显式写 default_domain_resolver（1.14 起缺失直接拒绝启动）', () => {
  for (const routingMode of ['rule', 'global', 'direct']) {
    const { config } = build({ routingMode });
    assert.equal(config.route.default_domain_resolver, 'local', `${routingMode} 档缺失`);
  }
});

// ── 第二层：目标应用的流量怎么走（这次的修复点）──────────────────────
test('TUN：三档模式都必须生成对应的 clash_mode 守卫 —— 否则按钮点了没反应', () => {
  const { config } = build();
  const rules = routeRules(config);
  assert.ok(has(rules, (r) => r.clash_mode === 'direct' && r.outbound === 'direct'), '缺直连档守卫');
  assert.ok(has(rules, (r) => r.clash_mode === 'global' && r.outbound === SELECTOR_TAG), '缺全局档守卫');
});

test('TUN：直连档守卫必须排在全局档守卫之前（否则全局档会压过直连）', () => {
  const rules = routeRules(build().config);
  const d = rules.findIndex((r) => r.clash_mode === 'direct');
  const g = rules.findIndex((r) => r.clash_mode === 'global');
  assert.ok(d >= 0 && g >= 0);
  assert.ok(d < g, '直连档守卫被全局档抢了');
});

test('TUN：直连档守卫要压过自定义规则（显式选「不用代理」时用户规则也不该翻盘）', () => {
  const rules = routeRules(
    build({ customRules: [{ type: 'domain_suffix', value: '.example.com', outbound: 'proxy' }] }).config,
  );
  const d = rules.findIndex((r) => r.clash_mode === 'direct');
  const c = rules.findIndex((r) => r.domain_suffix);
  assert.ok(d < c, '自定义规则排到了直连档守卫前面');
});

test('TUN：自定义规则进入配置，并带上目标进程限定', () => {
  const { config, customCount } = build({
    customRules: [
      { type: 'domain_suffix', value: '.corp.internal', outbound: 'direct' },
      { type: 'ip_cidr', value: '10.0.0.0/8', outbound: 'direct' },
    ],
  });
  assert.equal(customCount, 2);
  assert.ok(has(routeRules(config), (r) => r.domain_suffix?.[0] === '.corp.internal' && r.outbound === 'direct'));
});

test('TUN：自定义规则里的 process_name 覆盖档案限定（用户手写的更权威）', () => {
  const { config } = build({
    customRules: [{ type: 'process_name', value: 'Postman.exe', outbound: 'proxy' }],
  });
  const r = routeRules(config).find((x) => x.process_name?.[0] === 'Postman.exe');
  assert.ok(r, '自定义进程名规则丢失');
  assert.equal(r.outbound, SELECTOR_TAG);
});

test('TUN：非法自定义规则被剔除，但原因要回传而不是静默丢弃', () => {
  const { customErrors, customCount } = build({
    customRules: [
      { type: 'domain_regex', value: '([unclosed', outbound: 'proxy' },
      { type: 'domain_suffix', value: '.ok.com', outbound: 'proxy' },
    ],
  });
  assert.equal(customCount, 1, '合法的那条应当保留');
  assert.equal(customErrors.length, 1);
  assert.match(customErrors[0].error, /正则/);
});

test('TUN：规则档做国内直连，全局档与直连档不做（由守卫接管）', () => {
  const rule = routeRules(build({ routingMode: 'rule' }).config);
  const global = routeRules(build({ routingMode: 'global' }).config);
  const direct = routeRules(build({ routingMode: 'direct' }).config);

  const cnMatch = (rules) =>
    has(rules, (r) => r.domain_suffix === FALLBACK_CN_SUFFIXES || r.rule_set === 'geoip-cn');

  assert.ok(cnMatch(rule), '规则档应当有国内直连');
  assert.ok(cnMatch(global), '全局冷启动必须保留规则档规则');
  assert.ok(cnMatch(direct), '直连冷启动必须保留规则档规则');
});

test('TUN：directRules=false 时规则档也不做国内直连', () => {
  const rules = routeRules(build({ routingMode: 'rule', directRules: false }).config);
  assert.ok(!has(rules, (r) => r.domain_suffix === FALLBACK_CN_SUFFIXES));
});

test('TUN：内网直连始终存在（与路由档位无关）', () => {
  for (const routingMode of ['rule', 'global', 'direct']) {
    const rules = routeRules(build({ routingMode }).config);
    assert.ok(has(rules, (r) => r.ip_is_private === true && r.outbound === 'direct'), `${routingMode} 档缺内网直连`);
  }
});

// ── DNS 分流 ────────────────────────────────────────────────────────
test('TUN：DNS 必须做分流 —— 目标应用访问国内域名要本地解析', () => {
  const { config } = build();
  const rules = dnsRules(config);
  assert.ok(
    has(rules, (r) => r.process_name && r.domain_suffix && r.server === 'local'),
    '缺「目标应用 + 国内域名 → 本地解析」，就近 CDN 会失效',
  );
});

test('TUN：DNS 规则顺序 —— 国内判定必须排在「进程 → 远端」之前', () => {
  const rules = dnsRules(build().config);
  const cn = rules.findIndex((r) => r.domain_suffix || r.rule_set);
  const toRemote = rules.findIndex((r) => r.process_name && !r.domain_suffix && !r.rule_set && !r.clash_mode);
  assert.ok(cn >= 0 && toRemote >= 0);
  assert.ok(cn < toRemote, '国内域名判定被「进程 → 远端」抢了，DNS 分流等于没做');
});

test('TUN：DNS 兜底是 local —— 非目标应用的解析不该出国', () => {
  for (const routingMode of ['rule', 'global', 'direct']) {
    assert.equal(build({ routingMode }).config.dns.final, 'local', `${routingMode} 档 DNS 兜底不是 local`);
  }
});

test('TUN：远端解析器挂在代理出站上（detour），否则解析请求会绕过代理', () => {
  const remote = build().config.dns.servers.find((s) => s.tag === 'remote');
  assert.equal(remote.detour, SELECTOR_TAG);
});

test('TUN：有缓存规则集时用 rule_set，没有时退回内置域名后缀', () => {
  const fallback = build().config;
  assert.ok(has(dnsRules(fallback), (r) => r.domain_suffix === FALLBACK_CN_SUFFIXES));

  const withSets = build({
    ruleSetPaths: { 'geoip-cn': '/tmp/geoip-cn.srs', 'geosite-cn': '/tmp/geosite-cn.srs' },
  }).config;
  assert.ok(has(dnsRules(withSets), (r) => r.rule_set === 'geosite-cn'));
  const tags = withSets.route.rule_set.map((r) => r.tag);
  assert.ok(tags.includes('geosite-cn'), 'DNS 引用了 geosite-cn，路由里必须声明它');
});

// ── 输入校验 ────────────────────────────────────────────────────────
test('TUN：没有节点要报错', () => {
  assert.throws(() => buildTunPerAppConfig([], { processNames: NAMES }), /没有可用节点/);
});

test('TUN：未知路由模式要报错，不能静默生成一份错配置', () => {
  assert.throws(() => build({ routingMode: 'fastest' }), /未知的路由模式/);
});

test('TUN：selected 越界要报错', () => {
  assert.throws(() => build({ selected: 99 }), /selected 越界/);
});

test('TUN：未知应用档案要报错并列出可用项', () => {
  assert.throws(() => buildTunPerAppConfig(NODES, { apps: ['nope'], platform: 'win32' }), /未知的应用档案/);
});

// ── 三档模式全量过一遍，防止某一档漏生成字段 ────────────────────────
test('TUN：三档模式生成的配置结构完整（含 outbounds / rule_set / dns）', () => {
  for (const routingMode of ['rule', 'global', 'direct']) {
    const { config } = build({ routingMode });
    assert.ok(Array.isArray(config.outbounds) && config.outbounds.length >= 4, `${routingMode}: outbounds 异常`);
    assert.equal(config.outbounds[0].type, 'selector');
    assert.equal(config.route.auto_detect_interface, true, `${routingMode}: 缺 auto_detect_interface，TUN 下会形成环路`);
    assert.ok(config.dns.servers.length === 2, `${routingMode}: DNS 解析器数量异常`);
    assert.ok(routeRules(config).length >= 5, `${routingMode}: 路由规则过少`);
  }
});

test('反向名单：名单先直连，站点规则只处理名单外应用，DNS 同步排除', () => {
  const { config } = build({ reverseApps: true, customRules: [
    { type: 'domain_suffix', value: 'example.com', outbound: 'proxy' },
    { type: 'domain', value: 'corp.example', outbound: 'direct' },
  ] });
  const rules = config.route.rules.filter(r => r.outbound && !r.inbound);
  assert.deepEqual(rules[0], { process_name: NAMES, outbound: 'direct' });
  assert.equal(config.route.final, 'proxy');
  assert.ok(rules.some(r => r.domain_suffix?.includes('example.com') && !r.process_name));
  assert.deepEqual(config.dns.rules.find(r => !r.inbound), { process_name: NAMES, server: 'local' });
  assert.equal(config.dns.final, 'remote');
  assert.ok(config.dns.rules.some(r => r.domain?.includes('corp.example') && r.server === 'local'));
  assert.ok(config.dns.rules.some(r => r.clash_mode === 'direct'));
  assert.ok(config.dns.rules.some(r => r.clash_mode === 'global'));
});

test('正向名单：名单外直连优先于所有用户规则', () => {
  const { config } = build({ customRules: [{ type: 'process_name', value: 'other', outbound: 'proxy' }] });
  assert.deepEqual(config.route.rules.find(r => r.outbound && !r.inbound), { process_name: NAMES, invert: true, outbound: 'direct' });
});

test('空应用名单：正向全部直连，反向全部按规则分流', () => {
  const normal = buildTunPerAppConfig(NODES, { apps: [] }).config;
  assert.equal(normal.route.final, 'direct');
  assert.equal(normal.route.rules.slice(0, -3).filter(r => r.outbound && !r.inbound).length, 0);
  assert.equal(normal.dns.final, 'local');
  const reverse = buildTunPerAppConfig(NODES, { apps: [], reverseApps: true }).config;
  assert.equal(reverse.route.final, 'proxy');
  assert.ok(reverse.route.rules.some(r => r.clash_mode === 'direct'));
  assert.equal(reverse.dns.final, 'remote');
  assert.ok(!reverse.route.rules.some(r => r.process_name));
});
