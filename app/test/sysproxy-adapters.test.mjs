// 系统代理适配器 · 命令生成级单测
//
// 这些测试全部跑在 Linux 上，验证的是 Windows / macOS 适配器**生成的命令**，
// 不真的去改系统设置。这正是把「生成计划」和「执行计划」拆开的价值：
// 没有 Mac 也能验证 macOS 的三网卡还原逻辑对不对。
//
// 另外覆盖一条最容易出错、也最难靠肉眼发现的性质：**往返一致**
// —— 快照 → 开启 → 还原，生成的命令必须把快照里的每一项原值写回去。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BYPASS,
  DEFAULT_BYPASS_MACOS,
  parseWinServer,
  parseRegQuery,
  planWin32,
  WIN_KEY,
  parseMacProxy,
  parseMacServices,
  planDarwin,
  parseGVariant,
  planLinux,
  execPlan,
} from '../engine/sysproxy/adapters.mjs';

// ───────────────────────────── Windows ─────────────────────────────
test('Windows：ProxyServer 裸形态按最后一个冒号切分', () => {
  assert.deepEqual(parseWinServer('127.0.0.1:2080'), { host: '127.0.0.1', port: 2080, perProtocol: false });
  assert.deepEqual(parseWinServer(''), { host: null, port: null, perProtocol: false });
});

test('Windows：按协议形态不能把 "http=h" 当成主机名', () => {
  const r = parseWinServer('http=10.0.0.5:8888;https=10.0.0.5:8888;socks=10.0.0.5:1080');
  assert.equal(r.perProtocol, true);
  assert.equal(r.host, '10.0.0.5');
  assert.equal(r.port, 8888);
});

test('Windows：按协议形态缺 https 时依次退回 http / socks', () => {
  assert.equal(parseWinServer('http=1.2.3.4:1111').port, 1111);
  assert.equal(parseWinServer('socks=5.6.7.8:1080').host, '5.6.7.8');
});

test('Windows：reg query 输出解析出值，空值返回空串而不是 null', () => {
  assert.equal(parseRegQuery('    ProxyServer    REG_SZ    127.0.0.1:2080\r\n'), '127.0.0.1:2080');
  assert.equal(parseRegQuery('    ProxyOverride    REG_SZ    \r\n'), '');
  assert.equal(parseRegQuery('错误: 系统找不到指定的注册表项或值。'), null);
});

test('Windows：开启时写入三件事，并且必须清掉 PAC', () => {
  const steps = planWin32({ mode: 'on', host: '127.0.0.1', port: 2080, bypass: 'localhost;<local>' });
  const flat = steps.map((s) => s.args.join(' '));
  assert.ok(flat.some((a) => a.includes('ProxyServer') && a.includes('127.0.0.1:2080')));
  assert.ok(flat.some((a) => a.includes('ProxyOverride') && a.includes('localhost;<local>')));
  // PAC 优先级高于手动代理：不清掉等于白设
  assert.ok(
    flat.some((a) => a.startsWith('delete') && a.includes('AutoConfigURL')),
    '开启时必须删除 AutoConfigURL',
  );
  assert.ok(flat.some((a) => /ProxyEnable.*\/d 1(\s|$)/.test(a)));
  // 最后一步必须是刷新，否则要等用户手动进设置页
  assert.match(steps.at(-1).args.join(' '), /InternetSetOption/);
});

test('Windows：关闭只翻 ProxyEnable，不动用户原有的 ProxyServer', () => {
  const steps = planWin32({ mode: 'off' });
  const flat = steps.map((s) => s.args.join(' '));
  assert.ok(flat.some((a) => /ProxyEnable.*\/d 0(\s|$)/.test(a)));
  assert.ok(!flat.some((a) => a.includes('ProxyServer')), '关闭时不该改写 ProxyServer');
});

test('Windows：还原把每一项原值写回，原本没有的要删掉', () => {
  const steps = planWin32({
    mode: 'restore',
    base: { enable: true, server: 'corp.proxy:8080', override: '*.corp.com', autoconfig: null },
  });
  const flat = steps.map((s) => s.args.join(' '));
  assert.ok(flat.some((a) => a.includes('ProxyServer') && a.includes('corp.proxy:8080')));
  assert.ok(flat.some((a) => a.includes('ProxyOverride') && a.includes('*.corp.com')));
  assert.ok(flat.some((a) => a.startsWith('delete') && a.includes('AutoConfigURL')));
  assert.ok(flat.some((a) => /ProxyEnable.*\/d 1(\s|$)/.test(a)));
});

test('Windows：还原必须恢复用户原来的 PAC 地址', () => {
  const steps = planWin32({
    mode: 'restore',
    base: { enable: true, server: 'a:1', override: null, autoconfig: 'http://pac.corp/proxy.pac' },
  });
  const flat = steps.map((s) => s.args.join(' '));
  assert.ok(
    flat.some((a) => a.includes('AutoConfigURL') && a.includes('http://pac.corp/proxy.pac')),
    '用户原来的 PAC 不能被我们弄丢',
  );
});

test('Windows：还原时原本无 ProxyServer 应删除该项，而不是写空串', () => {
  const steps = planWin32({ mode: 'restore', base: { enable: false, server: null, override: null } });
  const flat = steps.map((s) => s.args.join(' '));
  assert.ok(flat.some((a) => a.startsWith('delete') && a.includes('ProxyServer')));
  assert.ok(flat.some((a) => /ProxyEnable.*\/d 0(\s|$)/.test(a)));
});

test('Windows：还原缺快照要报错，不能静默什么都不做', () => {
  assert.throws(() => planWin32({ mode: 'restore', base: null }), /快照/);
});

test('Windows：默认绕行列表覆盖本机与私有网段', () => {
  const s = DEFAULT_BYPASS.join(';');
  for (const must of ['localhost', '127.*', '192.168.*', '10.*', '<local>']) {
    assert.ok(s.includes(must), `默认绕行缺少 ${must}`);
  }
});

test('Windows：所有写入都打到 HKCU 下的 Internet Settings', () => {
  const steps = planWin32({ mode: 'on', host: '127.0.0.1', port: 2080, bypass: 'x' });
  for (const s of steps.filter((x) => x.cmd === 'reg')) {
    assert.equal(s.args[1], WIN_KEY);
  }
});

// ───────────────────────────── macOS ─────────────────────────────
test('macOS：解析 -getwebproxy 输出', () => {
  const on = 'Enabled: Yes\nServer: 127.0.0.1\nPort: 2080\nAuthenticated Proxy Enabled: 1\n';
  assert.deepEqual(parseMacProxy(on), { enabled: true, host: '127.0.0.1', port: 2080, authenticated: true });
  // 端口 0 视为「没有端口」，对外统一成 null —— 上层不用区分 0 和 null
  assert.deepEqual(parseMacProxy('Enabled: No\nServer: \nPort: 0\nAuthenticated Proxy Enabled: 0\n'), {
    enabled: false, host: null, port: null, authenticated: false,
  });
});

test('macOS：网络服务列表要跳过说明行和已停用的服务', () => {
  const out = 'An asterisk (*) denotes that a network service is disabled.\nWi-Fi\n*Thunderbolt Bridge\nEthernet\n';
  assert.deepEqual(parseMacServices(out), ['Wi-Fi', 'Ethernet']);
});

const twoServices = {
  schema: 2,
  services: [
    {
      id: '11111111-1111-4111-8111-111111111111', device: 'en0', name: 'Wi-Fi',
      webproxy: { enabled: true, authenticated: false, host: 'corp.proxy', port: 8080 },
      securewebproxy: { enabled: true, authenticated: false, host: 'corp.proxy', port: 8080 },
      socksfirewallproxy: { enabled: false, authenticated: false, host: 'stored.example', port: 3128 },
      bypass: ['*.corp.com'], autoproxy: {url:null,enabled:false}, autodiscovery:false,
    },
    {
      id: '22222222-2222-4222-8222-222222222222', device: 'en1', name: 'Ethernet',
      webproxy: { enabled: false, authenticated: false, host: 'stored.example', port: 3128 },
      securewebproxy: { enabled: false, authenticated: false, host: 'stored.example', port: 3128 },
      socksfirewallproxy: { enabled: true, authenticated: false, host: '10.0.0.9', port: 1080 },
      bypass: [], autoproxy: {url:null,enabled:false}, autodiscovery:false,
    },
  ],
};

test('macOS：开启要覆盖每一张网卡的三个协议，而不是只改第一张', () => {
  const steps = planDarwin({ mode: 'on', host: '127.0.0.1', port: 2080, base: twoServices });
  const set = steps.filter((s) => s.args[0].startsWith('-set') && !s.args[0].endsWith('state'));
  const names = new Set(set.map((s) => s.args[1]));
  assert.deepEqual([...names].sort(), ['Ethernet', 'Wi-Fi']);
  // 2 张网卡 × (3 个协议 × 2 条命令) = 12 条设代理的命令。
  // 另有 2 条/网卡 的「关掉自动代理配置」命令，单独在 macos-sysproxy.test.mjs 里验。
  const proxySteps = steps.filter((s) =>
    s.args[0] !== '-setproxybypassdomains' &&
    !s.args[0].includes('autoproxy') &&
    !s.args[0].includes('autodiscovery'));
  assert.equal(proxySteps.length, 12);
});

test('macOS：还原保持逐项原值 —— 原本关着的协议必须仍然是关着的', () => {
  const steps = planDarwin({ mode: 'restore', base: twoServices });
  const flat = steps.map((s) => s.args.join(' '));
  // Wi-Fi 的 socks 原本关闭
  assert.ok(flat.includes('-setsocksfirewallproxystate Wi-Fi off'));
  // Ethernet 的 web/secure 原本关闭
  assert.ok(flat.includes('-setwebproxystate Ethernet off'));
  assert.ok(flat.includes('-setsecurewebproxystate Ethernet off'));
  // Ethernet 的 socks 原本开着，端口必须写回 1080 而不是我们用的 2080
  assert.ok(flat.some((a) => a === '-setsocksfirewallproxy Ethernet 10.0.0.9 1080 off'));
  // Wi-Fi 原本的代理要写回 corp.proxy:8080
  assert.ok(flat.some((a) => a.includes('corp.proxy 8080')));
});

test('macOS：还原要把用户的绕行域名列表写回去', () => {
  const steps = planDarwin({ mode: 'restore', base: twoServices });
  const flat = steps.map((s) => s.args.join(' '));
  assert.ok(flat.some((a) => a.startsWith('-setproxybypassdomains Wi-Fi') && a.includes('*.corp.com')));
  // 原本没有绕行域名的那张网卡，要写成 Empty 清干净
  assert.ok(flat.some((a) => a === '-setproxybypassdomains Ethernet Empty'));
});

test('macOS：关闭只针对快照里的网卡，且逐项关状态', () => {
  const steps = planDarwin({ mode: 'off', base: twoServices });
  const flat = steps.map((s) => s.args.join(' '));
  assert.equal(steps.length, 6, '2 张网卡 × 3 个协议');
  assert.ok(flat.every((a) => a.includes('state')));
});

test('macOS：默认绕行是 CIDR 风格，不能用 Windows 的通配写法', () => {
  assert.ok(DEFAULT_BYPASS_MACOS.includes('192.168.0.0/16'));
  assert.ok(!DEFAULT_BYPASS_MACOS.some((x) => x.includes('*.*')), 'macOS 不认 192.168.*');
});

test('macOS：还原缺快照要报错', () => {
  assert.throws(() => planDarwin({ mode: 'restore', base: {} }), /快照/);
});

// ───────────────────────────── Linux ─────────────────────────────
test('Linux：开启设置三套协议并切到 manual', () => {
  const steps = planLinux({ mode: 'on', host: '127.0.0.1', port: 2080, bypass: ['localhost'] });
  const flat = steps.map((s) => s.args.join(' '));
  for (const must of ['http host', 'https host', 'socks host', 'ignore-hosts', 'mode manual']) {
    assert.ok(flat.some((a) => a.includes(must)), `缺少 ${must}`);
  }
});

test('Linux：ignore-hosts 必须是 GVariant 数组字面量', () => {
  const steps = planLinux({ mode: 'on', host: '127.0.0.1', port: 2080, bypass: ['localhost', '10.0.0.0/8'] });
  const v = steps.find((s) => s.args[2] === 'ignore-hosts').args[3];
  assert.equal(v, "['localhost', '10.0.0.0/8']");
  assert.deepEqual(parseGVariant(v), ['localhost', '10.0.0.0/8']);
});

test('Linux：解析 GVariant 的几种实际输出', () => {
  assert.deepEqual(parseGVariant('[]'), []);
  assert.deepEqual(parseGVariant('@as []'), []);
  assert.deepEqual(parseGVariant("['localhost']"), ['localhost']);
  assert.deepEqual(parseGVariant("['a', 'b']"), ['a', 'b']);
});

test('Linux：还原把快照里的每个键写回，最后恢复 mode', () => {
  const base = {
    mode: 'manual',
    values: {
      'http host': "'old.proxy'", 'http port': '3128',
      'https host': "'old.proxy'", 'https port': '3128',
      'socks host': "''", 'socks port': '0',
      'ignore-hosts': "['*.corp.com']", 'autoconfig-url': "''",
    },
  };
  const steps = planLinux({ mode: 'restore', base });
  const flat = steps.map((s) => s.args.join(' '));
  assert.ok(flat.some((a) => a.includes("http host 'old.proxy'")));
  assert.ok(flat.some((a) => a === 'set org.gnome.system.proxy mode manual'));
  // mode 必须是最后一步：先改地址再切模式，中途不会出现「manual 指向空地址」的瞬间
  assert.equal(steps.at(-1).args[2], 'mode');
});

// ───────────────────────── 执行层 ─────────────────────────
test('execPlan：optional 的命令失败不中断，必选命令失败要抛错', async () => {
  // 用一个必然不存在的命令模拟失败
  await execPlan([
    { cmd: 'definitely-not-a-real-command-jms', args: [], optional: true },
    { cmd: 'true', args: [] },
  ]);
  await assert.rejects(
    () => execPlan([{ cmd: 'definitely-not-a-real-command-jms', args: [] }]),
    /失败/,
  );
});

test('execPlan：错误信息里带上命令，便于用户报障时定位', async () => {
  await assert.rejects(
    () => execPlan([{ cmd: 'definitely-not-a-real-command-jms', args: ['--x'] }]),
    (e) => e.message.includes('definitely-not-a-real-command-jms') && e.message.includes('--x'),
  );
});
