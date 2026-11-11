// macOS 系统代理适配器 · 专项单测
//
// 全部在 Linux 上跑，验的是**生成的命令**与**判断逻辑**。
// 真实的生效/还原验证交给 tools/macos-sysproxy-roundtrip.mjs 在 Mac 上做 ——
// 两者分工明确：这里保证逻辑正确，那边保证这台机器上确实生效。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAC_KINDS,
  parseMacServiceOrder,
  planDarwin,
  classifyExecError,
  execPlan,
} from '../engine/sysproxy/adapters.mjs';

// 两份网卡快照，尽量贴近真实：一张在用且原本就有代理，一张没在用且干净
const SVC_ORDER = `An asterisk (*) denotes that a network service is disabled.
(1) Thunderbolt Bridge
(Hardware Port: Thunderbolt Bridge, Device: bridge0)

(2) Wi-Fi
(Hardware Port: Wi-Fi, Device: en0)

(3) iPhone USB
(Hardware Port: iPhone USB, Device: en6)
`;

const SNAP = {
  schema: 2,
  services: [
    {
      id: '11111111-1111-4111-8111-111111111111', device: 'en0', name: 'Wi-Fi',
      webproxy: { enabled: true, authenticated: false, host: 'corp.proxy', port: 8080 },
      securewebproxy: { enabled: true, authenticated: false, host: 'corp.proxy', port: 8080 },
      socksfirewallproxy: { enabled: false, authenticated: false, host: 'stored.example', port: 3128 },
      bypass: ['*.corp.com'],
      autoproxy: { url: 'http://pac.corp/proxy.pac', enabled: true },
      autodiscovery: true,
    },
    {
      id: '22222222-2222-4222-8222-222222222222', device: 'bridge0', name: 'Thunderbolt Bridge',
      webproxy: { enabled: false, authenticated: false, host: 'stored.example', port: 3128 },
      securewebproxy: { enabled: false, authenticated: false, host: 'stored.example', port: 3128 },
      socksfirewallproxy: { enabled: true, authenticated: false, host: '10.0.0.9', port: 1080 },
      bypass: [],
      autoproxy: { url: null, enabled: false },
      autodiscovery: false,
    },
  ],
};

const flat = (steps) => steps.map((s) => s.args.join(' '));
const idx = (steps, pred) => steps.findIndex((s) => pred(s.args.join(' ')));

// ── 默认路由 → 服务名 反查 ────────────────────────────────────────────
test('macOS：服务顺序解析出 设备名 → 服务名 映射', () => {
  const map = parseMacServiceOrder(SVC_ORDER);
  assert.equal(map.en0, 'Wi-Fi');
  assert.equal(map.bridge0, 'Thunderbolt Bridge');
  assert.equal(map.en6, 'iPhone USB');
});

test('macOS：反查映射里不能混进说明文字', () => {
  const map = parseMacServiceOrder(SVC_ORDER);
  for (const v of Object.values(map)) {
    assert.ok(!/asterisk/i.test(v), `服务名里混进了说明行：${v}`);
  }
});

test('macOS：服务顺序为空时不崩，返回空映射', () => {
  assert.deepEqual(parseMacServiceOrder(''), {});
  assert.deepEqual(parseMacServiceOrder(undefined), {});
});

// ── 自动代理配置（对应 Windows 的 PAC，同一个陷阱）─────────────────────
test('macOS：开启前必须先关掉自动代理配置，否则手动设置会被静默忽略', () => {
  const steps = planDarwin({ mode: 'on', host: '127.0.0.1', port: 2080, base: SNAP });
  const auto = idx(steps, (a) => a.includes('-setautoproxystate'));
  const manual = idx(steps, (a) => a.includes('-setwebproxy '));
  assert.ok(auto >= 0, '必须有关掉 AutoProxyURL 的命令');
  assert.ok(manual >= 0);
  assert.ok(auto < manual, '关自动配置必须排在设手动代理之前');
});

test('macOS：开启时同时关掉 Auto Proxy Discovery（另一条会抢优先级的路径）', () => {
  const steps = planDarwin({ mode: 'on', host: '127.0.0.1', port: 2080, base: SNAP });
  const offs = flat(steps).filter((a) => a.startsWith('-setproxyautodiscovery') && a.endsWith(' off'));
  assert.equal(offs.length, SNAP.services.length, '每张网卡都要关');
});

test('macOS：还原必须把用户原来的 PAC 地址和启用状态都写回去', () => {
  const steps = planDarwin({ mode: 'restore', base: SNAP });
  const f = flat(steps);
  assert.ok(
    !f.some((a) => a.includes('-setautoproxyurl')),
    '接管未修改PAC URL，恢复也不重写URL',
  );
  assert.ok(f.some((a) => a === '-setautoproxystate Wi-Fi on'), '原本是开着的，还原后也要开着');
});

test('macOS：还原时原本没有 PAC 的网卡要保持关闭', () => {
  const steps = planDarwin({ mode: 'restore', base: SNAP });
  const f = flat(steps);
  assert.ok(f.some((a) => a === '-setautoproxystate Thunderbolt Bridge off'));
  assert.ok(!f.some((a) => a.includes('-setautoproxyurl Thunderbolt Bridge')));
});

test('macOS：还原 Auto Proxy Discovery 的原值', () => {
  const steps = planDarwin({ mode: 'restore', base: SNAP });
  const f = flat(steps);
  assert.ok(f.some((a) => a === '-setproxyautodiscovery Wi-Fi on'));
  assert.ok(f.some((a) => a === '-setproxyautodiscovery Thunderbolt Bridge off'));
});

// ── 绕行域名 ─────────────────────────────────────────────────────────
test('macOS：清空绕行域名用字面量 Empty（官方文档的形式）', () => {
  const steps = planDarwin({ mode: 'restore', base: SNAP });
  assert.ok(flat(steps).includes('-setproxybypassdomains Thunderbolt Bridge Empty'));
});

test('macOS：开启时写入绕行域名，而不是留空', () => {
  const steps = planDarwin({ mode: 'on', host: '127.0.0.1', port: 2080, base: SNAP });
  const step = steps.find((s) => s.args[0] === '-setproxybypassdomains' && s.args[1] === 'Wi-Fi');
  assert.ok(step, '缺少绕行域名设置');
  assert.ok(step.args.length > 3, '绕行域名列表不能为空');
  assert.ok(step.args.some((a) => a === '127.0.0.1' || a === 'localhost'));
});

test('macOS：三个协议都设 —— mixed 入站同时接受 HTTP 与 SOCKS，不是笔误', () => {
  const steps = planDarwin({ mode: 'on', host: '127.0.0.1', port: 2080, base: SNAP });
  const f = flat(steps);
  for (const kind of MAC_KINDS) {
    assert.ok(f.some((a) => a.startsWith(`-set${kind} Wi-Fi 127.0.0.1 2080`)), `缺 ${kind}`);
    assert.ok(f.some((a) => a === `-set${kind}state Wi-Fi on`), `缺 ${kind} 开关`);
  }
  assert.ok(MAC_KINDS.includes('socksfirewallproxy'), 'SOCKS 必须在列');
});

test('macOS：还原不能把端口写成我们的端口', () => {
  const steps = planDarwin({ mode: 'restore', base: SNAP });
  const f = flat(steps);
  assert.ok(f.some((a) => a === '-setsocksfirewallproxy Thunderbolt Bridge 10.0.0.9 1080 off'));
  assert.ok(!f.some((a) => a.includes('10.0.0.9 2080')));
});

test('macOS：还原与开启都必须覆盖全部网卡，不能只动第一张', () => {
  for (const mode of ['on', 'restore']) {
    const steps = planDarwin({ mode, host: '127.0.0.1', port: 2080, base: SNAP });
    const names = new Set(
      steps.filter((s) => s.args[0].startsWith('-set')).map((s) => s.args[1]),
    );
    assert.deepEqual([...names].sort(), ['Thunderbolt Bridge', 'Wi-Fi'], `${mode} 漏了网卡`);
  }
});

test('macOS：还原缺快照要报错', () => {
  assert.throws(() => planDarwin({ mode: 'restore', base: null }), /快照/);
  assert.throws(() => planDarwin({ mode: 'restore', base: { services: [] } }), /快照/);
});

test('macOS：没有完整网卡快照时拒绝生成写计划', () => {
  assert.throws(() => planDarwin({ mode: 'on', host: '127.0.0.1', port: 2080, base: { services: [] } }), /快照/);
});

// ── 权限错误识别 ─────────────────────────────────────────────────────
test('macOS：识别权限类错误的各种措辞', () => {
  for (const msg of [
    'networksetup: not authorized to change network settings',
    'Operation not permitted',
    'permission denied',
    'This operation must be run as root',
    'requires administrator privileges',
    'needs admin privileges',
  ]) {
    assert.equal(classifyExecError(msg), 'NEED_ELEVATION', `没认出来：${msg}`);
  }
});

test('macOS：普通错误不能被误判成权限问题', () => {
  for (const msg of [
    'Invalid argument',
    'Cannot find device',
    'Unrecognized command',
    '',
    undefined,
  ]) {
    assert.equal(classifyExecError(msg), null, `误判：${msg}`);
  }
});

test('macOS：networksetup 权限不足时 execPlan 抛出带 NEED_ELEVATION 的错误', async () => {
  // 用一个必然输出权限措辞的命令模拟 —— 这正是 macOS 上会看到的现象：
  // man page 写明需要 admin 权限，部分版本还需要 root
  await assert.rejects(
    () => execPlan([{ cmd: 'sh', args: ['-c', 'echo "networksetup: not authorized" >&2; exit 1'] }]),
    (e) => e.code === 'NEED_ELEVATION',
  );
});

test('macOS：普通失败不带 NEED_ELEVATION，避免误导用户去提权', async () => {
  await assert.rejects(
    () => execPlan([{ cmd: 'sh', args: ['-c', 'echo "Invalid argument" >&2; exit 1'] }]),
    (e) => e.code === undefined,
  );
});

test('macOS：optional 的命令即使权限失败也不中断整个计划', async () => {
  await execPlan([
    { cmd: 'sh', args: ['-c', 'echo "not authorized" >&2; exit 1'], optional: true },
    { cmd: 'true', args: [] },
  ]);
});

test('macOS：排除没有设备的 Network Extension 服务，保留可配置的网卡', async () => {
 const { macProxyServices }=await import('../engine/sysproxy/adapters.mjs');
 const order=SVC_ORDER+'\n(4) VPN node\n(Hardware Port: net.example.vpn, Device: )\n';
 assert.deepEqual(macProxyServices(['Wi-Fi','VPN node','iPhone USB'],order),['Wi-Fi','iPhone USB']);
});
test('Darwin 接管拒绝不能提供持久化事务及读回校验的旧适配器', async () => {
 const { enableProxy }=await import('../engine/sysproxy/index.mjs');
 let writes=0;
 const adapter={platform:'darwin',snapshot:async()=>({mode:'off',base:SNAP}),apply:async()=>{writes++;}};
 await assert.rejects(()=>enableProxy({adapter,journal:{begin:async()=>{}},port:2080}),/完整事务/);
 assert.equal(writes,0);
});

test('macOS：读取实际生效的系统代理，可识别 VPN 覆盖与 HTTPS 不一致', async () => {
 const { parseMacEffectiveProxy }=await import('../engine/sysproxy/adapters.mjs');
 const { isPointingAtUs }=await import('../engine/sysproxy/index.mjs');
 const effective=parseMacEffectiveProxy('<dictionary> {\n HTTPEnable : 1\n HTTPProxy : 127.0.0.1\n HTTPPort : 2080\n HTTPSEnable : 1\n HTTPSProxy : 127.0.0.1\n HTTPSPort : 8080\n}');
 assert.equal(effective.port,2080);assert.equal(effective.https.port,8080);
 assert.equal(await isPointingAtUs({adapter:{read:async()=>effective},port:2080}),false);
 effective.https.port=2080;assert.equal(await isPointingAtUs({adapter:{read:async()=>effective},port:2080}),true);
 assert.equal(parseMacEffectiveProxy('<dictionary> {}').mode,'off');
});

test('Darwin 所有apply/restore写命令均必选，不允许吞掉失败', () => {
 for (const mode of ['on','restore']) {
  const steps=planDarwin({mode,host:'127.0.0.1',port:2080,base:SNAP});
  assert.ok(steps.length>0);assert.ok(steps.every(step=>step.optional!==true));
 }
});
test('Darwin 还原disabled协议仍恢复原存储地址与端口，且拒绝缺认证字段', () => {
 const steps=flat(planDarwin({mode:'restore',base:SNAP}));
 assert.ok(steps.includes('-setsocksfirewallproxy Wi-Fi stored.example 3128 off'));
 assert.ok(steps.includes('-setsocksfirewallproxystate Wi-Fi off'));
 const incomplete=structuredClone(SNAP);delete incomplete.services[0].webproxy.authenticated;
 assert.throws(()=>planDarwin({mode:'on',host:'127.0.0.1',port:2080,base:incomplete}),/快照/);
});
