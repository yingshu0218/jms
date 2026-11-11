import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store, maskUrl, nodeFingerprint } from '../engine/store.mjs';
import { diffNodes, dedupeNodes, fetchSubscription } from '../engine/subscription.mjs';
import { ProxyJournal } from '../engine/sysproxy/journal.mjs';
import { MockAdapter } from '../engine/sysproxy/adapters.mjs';
import { enableProxy, disableProxy, healIfNeeded, isPointingAtUs } from '../engine/sysproxy/index.mjs';
import { CoreSupervisor, resolveCoreBinary } from '../engine/supervisor.mjs';
import { ClashApi } from '../engine/clash-api.mjs';
import { AppService } from '../engine/app.mjs';
import { buildOutbounds, buildConfig, tagsForNodes, SELECTOR_TAG } from '../core/to-singbox.mjs';
import { parseSubscription, parseShareLink } from '../core/parse.mjs';
import { buildTunPerAppConfig } from '../core/per-app.mjs';
import { SAMPLE_PLAIN } from './sample.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'jms-'));
const CORE = process.env.SING_BOX || resolveCoreBinary();

// ═══════════════════════════ 存储 ═══════════════════════════

test('存储：落盘后权限是 0600，目录 0700', () => {
  const dir = tmp();
  const s = new Store(dir);
  s.write({ settings: { port: 9999 } });
  assert.equal(statSync(join(dir, 'state.json')).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('存储：状态文件损坏时不崩溃，重命名为 .corrupt 后从空状态继续', () => {
  const dir = tmp();
  new Store(dir).write({});
  writeFileSync(join(dir, 'state.json'), '{ 这不是 JSON');
  const s = new Store(dir);
  assert.equal(s.state.settings.port, 2080); // 回到默认值
  assert.ok(existsSync(join(dir, 'state.json.corrupt')), '损坏文件应被保留以便排查');
});

test('脱敏：redacted() 绝不能泄漏 uuid / 公钥 / 密码 / 订阅链接', () => {
  const dir = tmp();
  const s = new Store(dir);
  const { nodes } = parseSubscription(SAMPLE_PLAIN);
  s.write({
    subscription: { url: 'https://secret.example/sub?token=abcd1234', nodes },
  });
  const out = s.redacted();
  const dump = JSON.stringify(out);
  assert.ok(!dump.includes('secret.example/sub'), '订阅路径不能出现');
  assert.ok(!dump.includes('abcd1234'), '订阅 token 不能出现');
  assert.ok(!dump.includes('11111111-2222'), 'uuid 不能出现');
  assert.ok(!/public_key|pbk|password|"uuid"/.test(dump), '凭据字段不能出现');
  // 但用户需要能辨认节点
  assert.equal(out.subscription.nodes.length, nodes.length);
  assert.ok(out.subscription.nodes[0].name);
});

test('maskUrl：只保留主机名', () => {
  assert.equal(maskUrl('https://host.example/path?token=x'), 'https://host.example/…');
  assert.equal(maskUrl('随便一段文本'), '…');
});

// ═══════════════════════════ 订阅 ═══════════════════════════

test('订阅：支持 ETag 条件请求，304 时不重复解析', async () => {
  let seen = null;
  const fake = async (url, init) => {
    seen = init.headers;
    return { status: 304, ok: false, headers: new Map() };
  };
  const res = await fetchSubscription('https://x/y', { etag: 'W/"abc"', fetchImpl: fake });
  assert.equal(res.notModified, true);
  assert.equal(seen['If-None-Match'], 'W/"abc"');
});

test('订阅：HTTP 错误要抛出可读信息', async () => {
  const fake = async () => ({ status: 403, ok: false, headers: new Map() });
  await assert.rejects(() => fetchSubscription('https://x/y', { fetchImpl: fake }), /HTTP 403/);
});

test('★ 变更检测：能识别出「同名节点但入口参数变了」—— 这就是参数轮换', () => {
  const prev = [
    { name: 'HK-1', type: 'vless', server: '1.1.1.1', server_port: 443, security: 'reality' },
    { name: 'JP-1', type: 'vless', server: '2.2.2.2', server_port: 443, security: 'reality' },
    { name: 'OLD', type: 'ss', server: '3.3.3.3', server_port: 8388 },
  ];
  const next = [
    { name: 'HK-1', type: 'vless', server: '9.9.9.9', server_port: 8443, security: 'reality' }, // 轮换
    { name: 'JP-1', type: 'vless', server: '2.2.2.2', server_port: 443, security: 'reality' }, // 未变
    { name: 'NEW', type: 'ss', server: '4.4.4.4', server_port: 8388 }, // 新增
  ];
  const c = diffNodes(prev, next);
  assert.deepEqual(c.added, ['NEW']);
  assert.deepEqual(c.removed, ['OLD']);
  assert.equal(c.changed.length, 1);
  assert.equal(c.changed[0].name, 'HK-1');
  assert.equal(c.changed[0].from, '1.1.1.1:443');
  assert.equal(c.changed[0].to, '9.9.9.9:8443');
});

test('指纹不包含凭据字段', () => {
  const n = { type: 'vless', server: 'a', server_port: 1, uuid: 'SECRET', tls: { reality: { public_key: 'SECRET2' } } };
  assert.ok(!nodeFingerprint(n).includes('SECRET'));
});

test('节点去重', () => {
  const { nodes } = parseSubscription(SAMPLE_PLAIN);
  assert.equal(dedupeNodes([...nodes, ...nodes]).length, nodes.length);
});

// 回归测试：端到端自证时真实踩到的解析缺陷
test('ss:// 回归：userinfo 的 base64 无填充 / 有填充 / 明文 / percent 编码，四种都要能解析', () => {
  const mk = (userinfo) => `ss://${userinfo}@192.0.2.30:8388#SS-Regression`;
  const padded = Buffer.from('aes-256-gcm:e2e-local-password', 'utf8').toString('base64');
  const unpadded = padded.replace(/=+$/, ''); // 真实订阅里常见：没有 '=' 填充
  const base64url = padded.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

  const cases = [
    ['有填充 base64', padded],
    ['无填充 base64', unpadded],
    ['base64url 无填充', base64url],
    ['明文 method:password', 'aes-256-gcm:plain-password'],
    ['percent 编码的 base64', encodeURIComponent(padded)],
  ];
  for (const [label, userinfo] of cases) {
    const node = parseShareLink(mk(userinfo));
    assert.equal(node.type, 'shadowsocks', `${label}：协议识别`);
    assert.equal(node.method, 'aes-256-gcm', `${label}：加密方式`);
    assert.ok(node.password.length > 0, `${label}：口令非空`);
    assert.equal(node.server, '192.0.2.30', `${label}：服务器地址`);
    assert.equal(node.server_port, 8388, `${label}：端口`);
  }
  // 旧版遗留形态：ss://BASE64(method:pass@host:port)
  const legacy = 'ss://' + Buffer.from('aes-256-gcm:legacy-pass@192.0.2.31:8389', 'utf8').toString('base64') + '#Legacy';
  const ln = parseShareLink(legacy);
  assert.equal(ln.type, 'shadowsocks');
  assert.equal(ln.server, '192.0.2.31');
  assert.equal(ln.server_port, 8389);
});

test('ss:// 回归：无法识别的 userinfo 必须报错而不是生成坏节点', () => {
  assert.throws(() => parseShareLink('ss://bm9jb2xvbg@192.0.2.32:8388#Bad'), /缺少 method:password/);
});

// ═══════════════════════ 系统代理自愈（重点） ═══════════════════════

test('系统代理：开启后崩溃 → 下次启动能精确还原到用户原有的代理设置', async () => {
  const dir = tmp();
  const journal = new ProxyJournal(dir);
  // 用户本来有一个公司代理 —— 还原必须回到它，而不是简单"关掉"
  const adapter = new MockAdapter({ mode: 'on', host: 'corp.proxy', port: 8080, bypass: '*.local' });

  await enableProxy({ adapter, journal, port: 2080 });
  assert.deepEqual(adapter.state, { mode: 'on', host: '127.0.0.1', port: 2080, bypass: null });
  assert.ok(journal.isPending(), '改动前必须留下日志');

  // 模拟崩溃：不调 disableProxy（进程被强杀）
  const healed = await healIfNeeded({ adapter, journal });
  assert.equal(healed.healed, true);
  assert.deepEqual(adapter.state, { mode: 'on', host: 'corp.proxy', port: 8080, bypass: '*.local' });
  assert.equal(journal.isPending(), false, '自愈后日志必须清除');
});

test('系统代理：原本没开代理时，自愈应关掉而不是留下我们的代理', async () => {
  const dir = tmp();
  const journal = new ProxyJournal(dir);
  const adapter = new MockAdapter({ mode: 'off' });
  await enableProxy({ adapter, journal, port: 2080 });
  await healIfNeeded({ adapter, journal });
  assert.equal(adapter.state.mode, 'off');
});

test('系统代理：设置失败时必须还原并清日志（不能留下半改状态）', async () => {
  const dir = tmp();
  const journal = new ProxyJournal(dir);
  const adapter = new MockAdapter({ mode: 'off' });
  adapter.failNext = true;
  await assert.rejects(() => enableProxy({ adapter, journal, port: 2080 }), /设置系统代理失败/);
  assert.equal(adapter.state.mode, 'off', '失败后应还原');
  assert.equal(journal.isPending(), false, '已还原则不该留下日志');
});

test('系统代理：正常断开还原原始状态并清日志', async () => {
  const dir = tmp();
  const journal = new ProxyJournal(dir);
  const adapter = new MockAdapter({ mode: 'on', host: 'prev', port: 3128 });
  await enableProxy({ adapter, journal, port: 2080 });
  const out = await disableProxy({ adapter, journal });
  assert.equal(out.restored.host, 'prev');
  assert.deepEqual(adapter.state, { mode: 'on', host: 'prev', port: 3128, bypass: null });
  assert.equal(journal.isPending(), false);
});

test('系统代理：没有残留日志时自愈应为空操作', async () => {
  const dir = tmp();
  const journal = new ProxyJournal(dir);
  const adapter = new MockAdapter({ mode: 'off' });
  const r = await healIfNeeded({ adapter, journal });
  assert.equal(r.healed, false);
  assert.equal(adapter.calls.length, 0, '不该去碰系统设置');
});

test('系统代理：状态一致性判断', async () => {
  const adapter = new MockAdapter({ mode: 'on', host: '127.0.0.1', port: 2080 });
  assert.equal(await isPointingAtUs({ adapter, port: 2080 }), true);
  assert.equal(await isPointingAtUs({ adapter, port: 9999 }), false);
  adapter.state.mode = 'off';
  assert.equal(await isPointingAtUs({ adapter, port: 2080 }), false);
});

// ═══════════════════════ 出站与标签 ═══════════════════════

test('出站：每个节点独立成 outbound，最前面是 selector', () => {
  const { nodes } = parseSubscription(SAMPLE_PLAIN);
  const { outbounds, tags } = buildOutbounds(nodes, 2);
  assert.equal(outbounds[0].type, 'selector');
  assert.equal(outbounds[0].tag, SELECTOR_TAG);
  assert.deepEqual(outbounds[0].outbounds, tags);
  assert.equal(outbounds[0].default, tags[2]);
  assert.equal(outbounds[outbounds.length - 1].type, 'direct');
  assert.equal(new Set(tags).size, nodes.length, '标签必须唯一');
});

test('出站：节点名撞保留字或重复时自动改名', () => {
  const nodes = [
    { name: 'direct', type: 'shadowsocks', server: 'a', server_port: 1, method: 'm', password: 'p' },
    { name: 'proxy', type: 'shadowsocks', server: 'b', server_port: 2, method: 'm', password: 'p' },
    { name: 'proxy', type: 'shadowsocks', server: 'c', server_port: 3, method: 'm', password: 'p' },
  ];
  const tags = tagsForNodes(nodes);
  assert.equal(new Set(tags).size, 3);
  assert.ok(!tags.includes('direct') && !tags.includes('proxy'));
});

test('配置：系统代理模式结构正确', () => {
  const { nodes } = parseSubscription(SAMPLE_PLAIN);
  const cfg = buildConfig(nodes, { port: 2080, selected: 1 });
  assert.equal(cfg.inbounds.length, 1);
  assert.equal(cfg.route.final, SELECTOR_TAG);
  assert.equal(cfg.outbounds[0].type, 'selector');
  assert.equal(cfg.outbounds.filter((o) => o.tag !== 'direct' && o.type !== 'selector').length, nodes.length);
});

test('配置：TUN 进程分流结构正确（捕获全部、只代理指定进程）', () => {
  // 自带 fixture：这个测试要独立可读，不依赖文件里别处的节点变量
  const nodes = [
    { type: 'vless', name: 'HK-01', server: '192.0.2.10', server_port: 443, uuid: '11111111-2222-3333-4444-555555555555' },
    { type: 'vless', name: 'JP-01', server: '192.0.2.11', server_port: 443, uuid: '11111111-2222-3333-4444-666666666666' },
  ];
  const { config, processNames } = buildTunPerAppConfig(nodes, { platform: 'win32', selected: 0 });
  const tun = config.inbounds.find((i) => i.type === 'tun');
  assert.equal(tun.auto_route, true);
  assert.equal(config.route.auto_detect_interface, true, 'TUN 下必须绑默认网卡，否则形成路由环路');

  // per-app 的根基：非目标应用一律直连
  assert.equal(config.route.final, 'direct');

  // 目标进程的每条分流规则都要带进程限定，绝不误伤其他应用
  assert.deepEqual(config.route.rules[0], { inbound: ['mixed-in'], outbound: SELECTOR_TAG });
  assert.deepEqual(config.route.rules.slice(-3), ['rule','global','direct'].map(clash_mode=>({clash_mode,outbound:config.route.final})));
  const routing = config.route.rules.slice(0,-3).filter((r) => !r.action && !r.inbound?.includes('mixed-in'));
  assert.ok(routing.length >= 5);
  for (const r of routing) {
    assert.deepEqual(r.process_name, processNames, `规则缺少进程限定: ${JSON.stringify(r)}`);
  }
  // 末尾必须是「目标应用兜底 → 代理」
  assert.equal(routing.at(-1).outbound, SELECTOR_TAG);
  // 三档路由模式必须有对应守卫，否则界面上的按钮点了没反应（曾经的真实缺陷）
  assert.ok(routing.some((r) => r.clash_mode === 'direct'));
  assert.ok(routing.some((r) => r.clash_mode === 'global'));
  // DNS 也要做分流，否则目标应用访问国内站点时就近解析失效
  assert.ok(config.dns.rules.some((r) => r.process_name && r.server === 'local'));
});

// ═══════════════════════ 内核守护（用真实 sing-box） ═══════════════════════

function directConfig(port, apiPort) {
  return {
    log: { level: 'warn' },
    experimental: { clash_api: { external_controller: `127.0.0.1:${apiPort}` } },
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: port }],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { final: 'direct' },
  };
}

test('内核守护：启动 → 就绪 → 状态正确 → 干净停止', { skip: !CORE && '未找到 sing-box' }, async () => {
  const dir = tmp();
  const cfg = join(dir, 'c.json');
  writeFileSync(cfg, JSON.stringify(directConfig(13081, 19081)));
  const api = new ClashApi('http://127.0.0.1:19081');
  const sup = new CoreSupervisor({
    binaryPath: CORE,
    configPath: cfg,
    logFile: join(dir, 'core.log'),
    readyCheck: () => api.version(),
  });

  const st = await sup.start();
  assert.equal(st.running, true);
  assert.ok(st.pid > 0);
  const v = await api.version();
  assert.ok(v.version, '应能读到内核版本');

  const after = await sup.stop();
  assert.equal(after.running, false);
  sup.closeLog();
});

test('内核守护：被强杀后自动重启，并上报崩溃', { skip: !CORE && '未找到 sing-box' }, async () => {
  const dir = tmp();
  const cfg = join(dir, 'c.json');
  writeFileSync(cfg, JSON.stringify(directConfig(13082, 19082)));
  const api = new ClashApi('http://127.0.0.1:19082');
  const sup = new CoreSupervisor({
    binaryPath: CORE,
    configPath: cfg,
    logFile: join(dir, 'core.log'),
    readyCheck: () => api.version(),
    restartDelayMs: 300,
  });

  const events = [];
  sup.on('crash', (i) => events.push(['crash', i.intentional]));
  sup.on('restarted', (s) => events.push(['restarted', s.pid]));

  await sup.start();
  const firstPid = sup.status().pid;

  // 模拟内核崩溃（不是用户主动停）
  process.kill(firstPid, 'SIGKILL');

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && !events.some(([e]) => e === 'restarted')) {
    await new Promise((r) => setTimeout(r, 150));
  }

  assert.deepEqual(events[0], ['crash', false], '崩溃应被识别为非主动退出');
  const restarted = events.find(([e]) => e === 'restarted');
  assert.ok(restarted, '应自动重启');
  assert.notEqual(restarted[1], firstPid, '应是新进程');
  assert.equal(sup.status().running, true);

  await sup.stop();
  sup.closeLog();
});

test('内核守护：用户主动停止后不得再拉起', { skip: !CORE && '未找到 sing-box' }, async () => {
  const dir = tmp();
  const cfg = join(dir, 'c.json');
  writeFileSync(cfg, JSON.stringify(directConfig(13083, 19083)));
  const api = new ClashApi('http://127.0.0.1:19083');
  const sup = new CoreSupervisor({
    binaryPath: CORE,
    configPath: cfg,
    logFile: join(dir, 'core.log'),
    readyCheck: () => api.version(),
    restartDelayMs: 200,
  });
  const events = [];
  sup.on('crash', () => events.push('crash'));
  sup.on('restarted', () => events.push('restarted'));

  await sup.start();
  await sup.stop();
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(events, [], '主动停止不应触发崩溃重启');
  assert.equal(sup.status().running, false);
  sup.closeLog();
});

test('内核守护：配置错误导致起不来 → 限流后放弃并上报（不能让上层无限重启）', { skip: !CORE && '未找到 sing-box' }, async () => {
  const dir = tmp();
  const cfg = join(dir, 'bad.json');
  writeFileSync(cfg, '{ 这不是合法配置 }');
  const sup = new CoreSupervisor({
    binaryPath: CORE,
    configPath: cfg,
    logFile: join(dir, 'core.log'),
    readyCheck: async () => {
      throw new Error('never ready');
    },
    maxRestarts: 1,
    windowMs: 60_000,
    restartDelayMs: 150,
    readyTimeoutMs: 700,
  });
  const seen = [];
  sup.on('giveup', (i) => seen.push(i));
  sup.on('crash', () => seen.push('crash'));

  await assert.rejects(() => sup.start(), /未在|立即退出/);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !seen.some((x) => x !== 'crash')) {
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(seen.some((x) => x !== 'crash'), '应触发 giveup');
  sup.closeLog();
});

test('内核守护：未知二进制路径应报错而不是静默', async () => {
  const sup = new CoreSupervisor({
    binaryPath: '/nonexistent/sing-box',
    configPath: '/tmp/x.json',
    readyCheck: async () => true,
    readyTimeoutMs: 500,
  });
  await assert.rejects(() => sup.start());
  const stopped = await sup.stop();
  assert.equal(stopped.running, false);
  assert.equal(stopped.pid, null, '启动失败后的清理不能等待不存在的进程');
  sup.closeLog();
});

// ═══════════════════ 完整连接生命周期（端到端） ═══════════════════

test(
  '端到端：连接 → 状态 → 测速 → 切换节点 → 断开，且系统代理全程正确',
  { skip: !CORE && '未找到 sing-box' },
  async () => {
    const dir = tmp();
    const adapter = new MockAdapter({ mode: 'off' });
    const app = new AppService({ dir, coreBinary: CORE, adapter });
    try {
    // 用脱敏样本节点（地址是 TEST-NET，连不通 —— 这正是我们要的：链路要能起来）
    app.store.write({
      subscription: (() => {
        const { nodes } = parseSubscription(SAMPLE_PLAIN);
        return { url: 'https://demo.invalid/sub', nodes };
      })(),
      settings: { port: 13090, clashApi: '127.0.0.1:19090', mode: 'sysproxy' },
    });


    const warns = [];
    app.on('warn', (m) => warns.push(m));

    // ① 连接
    const meta = await app.connect();
    assert.equal(meta.mode, 'sysproxy');
    assert.ok(meta.pid > 0);
    assert.ok(existsSync(meta.configPath));
    const st = await app.status();
    assert.equal(st.connected, true);
    assert.equal(st.pointingAtUs, true, '系统代理应指向本机端口');
    assert.equal(st.pendingProxyJournal, true, '连接期间应有残留日志（用于崩溃自愈）');

    // ② 测速：节点是 TEST-NET 不可达，必须如实报"不可用"，而不是编一个数字
    const lat = await app.measureLatency({ all: true });
    const first = lat[app.nodeTags()[0]];
    assert.equal(first.ok, false);
    assert.ok(['不可用', '超时'].includes(first.error));

    // ③ 切换节点：走 Clash API 即时切换，不重连内核
    const pidBefore = app.supervisor.status().pid;
    const sel = await app.selectNode(2);
    assert.equal(sel.applied, true, `切换应即时生效，实际：${sel.reason || ''}`);
    assert.equal(pidBefore, app.supervisor.status().pid, '切换节点不应重启内核');
    assert.equal(await app.apiClient().currentSelection(SELECTOR_TAG), sel.tag);

    // ④ 断开：先还原系统代理，再停内核
    await app.disconnect();
    assert.equal(adapter.state.mode, 'off', '系统代理必须还原');
    assert.equal(app.journal.isPending(), false, '日志必须清除');
    const st2 = await app.status();
    assert.equal(st2.connected, false);
    assert.equal(st2.running, false);
    } finally {
      // 断言失败也必须停掉内核，否则守护进程会在后台不断重启它
      await app.disconnect().catch(() => {});
      await app.supervisor?.stop().catch(() => {});
      app.supervisor?.closeLog();
    }
  },
);

test(
  '端到端：连接失败（内核路径错误）必须清理干净，不留系统代理',
  { skip: !CORE && '未找到 sing-box' },
  async () => {
    const dir = tmp();
    const adapter = new MockAdapter({ mode: 'on', host: 'prev', port: 3128 });
    const app = new AppService({ dir, coreBinary: '/nonexistent/sing-box', adapter });
    app.store.write({
      subscription: (() => {
        const { nodes } = parseSubscription(SAMPLE_PLAIN);
        return { nodes };
      })(),
      settings: { port: 13091, clashApi: '127.0.0.1:19091' },
    });

    await assert.rejects(() => app.connect());
    assert.deepEqual(adapter.state, { mode: 'on', host: 'prev', port: 3128 }, '启动失败前未改代理，必须保留用户原有设置');
    assert.equal(app.journal.isPending(), false);
    assert.equal(app.store.state.runtime.connected, false, '不能留下"已连接"的脏状态');
  },
);

test('启动自愈：上次连接状态 + 残留代理日志 → 本次启动自动还原且不自动重连', async () => {
  const dir = tmp();
  const adapter = new MockAdapter({ mode: 'on', host: 'corp.proxy', port: 8080 });
  const j = new ProxyJournal(dir);

  // 制造"上次崩溃"的现场
  j.begin({ platform: 'linux', previous: { mode: 'on', host: 'corp.proxy', port: 8080 }, target: { mode: 'on', host: '127.0.0.1', port: 2080 } });
  adapter.state = { mode: 'on', host: '127.0.0.1', port: 2080, bypass: null };

  const app = new AppService({ dir, coreBinary: CORE || '/bin/true', adapter });
  app.store.markRuntime({ connected: true, pid: 12345 });

  const healed = await app.boot();
  assert.equal(healed.healed, true);
  assert.deepEqual(adapter.state, { mode: 'on', host: 'corp.proxy', port: 8080, bypass: null });
  assert.equal(app.store.state.runtime.connected, false, '不自动重连');
  assert.equal(app.journal.isPending(), false);
});

test('测速：没有节点时给出明确错误而不是返回假数据', async () => {
  const app = new AppService({ dir: tmp(), coreBinary: CORE || '/bin/true', adapter: new MockAdapter() });
  await assert.rejects(() => app.measureLatency({ all: true }), /没有可用节点/);
});

test('设置：端口与模式变更在运行中会提示需要重连', async () => {
  const app = new AppService({ dir: tmp(), coreBinary: CORE || '/bin/true', adapter: new MockAdapter() });
  app.store.markRuntime({ connected: true });
  const warns = [];
  app.on('warn', (m) => warns.push(m));
  await app.updateSettings({ port: 5555 });
  assert.ok(warns.some((w) => /重新连接/.test(w)));
  assert.equal(app.store.state.settings.port, 5555);
});

test('订阅：没有节点时连接应报错', async () => {
  const app = new AppService({ dir: tmp(), coreBinary: CORE || '/bin/true', adapter: new MockAdapter() });
  await assert.rejects(() => app.connect(), /没有可用节点/);
});

test('断开：接管设置改变后仍依据 journal 恢复代理', async () => {
  const adapter = new MockAdapter({ mode: 'on', host: 'company', port: 3128 });
  const app = new AppService({ dir: tmp(), adapter });
  await enableProxy({ adapter, journal: app.journal, port: 2080 });
  app.store.write({ settings: { mode: 'tun-per-app' } });
  await app.disconnect();
  assert.equal(adapter.state.host, 'company');
  assert.equal(adapter.state.port, 3128);
  assert.equal(app.journal.isPending(), false);
});

test('断开：没有恢复日志时不改动用户原有系统代理', async () => {
  const adapter = new MockAdapter({ mode: 'on', host: 'company', port: 3128 });
  const app = new AppService({ dir: tmp(), adapter });
  await app.disconnect();
  assert.equal(adapter.state.host, 'company');
  assert.equal(adapter.state.mode, 'on');
});
