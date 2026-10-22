// 系统代理的平台适配器
//
// 设计要点：**命令生成与命令执行分离**。
// 每个平台都导出一组纯函数 `plan*()`，输入「当前快照 + 目标」，输出要执行的命令数组；
// 适配器对象只负责把命令跑起来。好处是：Windows / macOS 的具体命令可以在 Linux 上
// 做完整的单测（本仓库的 CI 就跑在 Linux 上），不必真有一台 Mac 才能验证逻辑。
//
// 三个平台的坑各不相同，都踩过之后写死在这里：
//
//   Windows
//     · ProxyServer 有两种形态：裸 `host:port`，或按协议 `http=h:p;https=h:p;socks=h:p`。
//       只按 ':' 切会把第二种解析成 host="http=h" —— 必须先判断是不是带协议前缀。
//     · 用户可能开着 PAC（AutoConfigURL）。PAC 优先级高于手动代理，不关掉它，
//       我们写的设置根本不生效 —— 必须关掉，且记下来以便还原。
//     · WinHTTP 是另一套代理设置（服务、安装器在用），与 WinINET 互不相通。
//     · 改完注册表不广播 InternetSetOption 的话，要等用户手动进设置页才生效。
//
//   macOS
//     · 一个系统有多张网络服务（Wi-Fi / 以太网 / Thunderbolt），每张各有
//       web / secure web / socks 三套独立开关。只改第一张是 bug。
//     · networksetup 没有事务：改 3 张网卡 × 3 个协议 = 9 次调用，
//       中途失败会留下半改状态 —— 所以还原必须按「快照」逐项写回，而不是笼统地关掉。
//
//   Linux
//     · gsettings 是 GNOME 的；KDE 用的是另一套（kwriteconfig5），本适配器不碰。
//     · ignore-hosts 是 GVariant 数组字面量，写成 "['localhost']" 这种形式。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function sh(cmd, args, opts = {}) {
  const { stdout } = await run(cmd, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 10000, ...opts });
  return stdout;
}

/** 执行一组计划；`optional` 的命令失败不致命（比如删除一个本来就不存在的值） */
/**
 * 权限类错误的识别。
 *
 * 为什么要认：macOS 的 networksetup 在不同版本上对权限的要求不一致，
 * 报错措辞也不统一（有的是 "not authorized"，有的是 "Operation not permitted"）。
 * 认出来就打上 NEED_ELEVATION，上层可以走和 TUN 模式**完全相同**的提权引导，
 * 而不是丢给用户一句看不懂的原始报错。
 */
const PERMISSION_PATTERNS = [
  /not authorized/i,
  /authorization denied/i,
  /permission denied/i,
  /operation not permitted/i,
  /must be run as root/i,
  /you must be root/i,
  /needs? (?:admin|administrator)/i,
  /requires? (?:admin|administrator|root)/i,
];

export function classifyExecError(message) {
  const msg = String(message || '');
  return PERMISSION_PATTERNS.some((re) => re.test(msg)) ? 'NEED_ELEVATION' : null;
}

/** 执行一组计划；`optional` 的命令失败不致命（比如清一个本来就不存在的项） */
export async function execPlan(steps) {
  for (const s of steps) {
    try {
      await sh(s.cmd, s.args);
    } catch (e) {
      if (s.optional) continue;
      const err = new Error(`${s.cmd} ${s.args.join(' ')} 失败：${e.message}`);
      const code = classifyExecError(`${e.message} ${e.stderr || ''}`);
      if (code) err.code = code;
      throw err;
    }
  }
}

/** 默认绕行列表：本机、私有网段、内网域名 —— 这些走代理只会变慢或直接失败 */
export const DEFAULT_BYPASS = [
  'localhost', '127.*', '10.*', '172.16.*', '172.17.*', '172.18.*', '172.19.*',
  '172.2?.*', '172.30.*', '172.31.*', '192.168.*', '*.local', '<local>',
];

export const DEFAULT_BYPASS_MACOS = [
  '*.local', '169.254/16', '127.0.0.1', '192.168.0.0/16', '10.0.0.0/8',
  '172.16.0.0/12', 'localhost',
];

// ═══════════════════════════════ Windows ═══════════════════════════════
export const WIN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** 解析 ProxyServer 的两种形态 → { host, port, perProtocol } */
export function parseWinServer(raw) {
  const s = String(raw || '').trim();
  if (!s) return { host: null, port: null, perProtocol: false };
  if (s.includes('=')) {
    // 按协议形态：优先取 https，再 http，最后 socks
    const map = {};
    for (const part of s.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) map[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    }
    const picked = map.https || map.http || map.socks || null;
    if (!picked) return { host: null, port: null, perProtocol: true, map };
    const [host, port] = splitHostPort(picked);
    return { host, port, perProtocol: true, map };
  }
  const [host, port] = splitHostPort(s);
  return { host, port, perProtocol: false };
}

function splitHostPort(s) {
  const t = String(s || '');
  const i = t.lastIndexOf(':');
  if (i < 0) return [t || null, null];
  const port = Number(t.slice(i + 1));
  return [t.slice(0, i) || null, Number.isFinite(port) && port > 0 ? port : null];
}

/** reg query 输出 → 值 */
export function parseRegQuery(out) {
  if (!out) return null;
  const m = /REG_(?:SZ|DWORD|EXPAND_SZ|MULTI_SZ)\s+(.*)$/m.exec(out);
  if (!m) return null;
  const v = m[1].trim();
  return v === '' ? '' : v;
}

/**
 * 生成 Windows 的写入计划。
 * @param base 当前快照的 base（用于还原），enable 时为 null
 */
export function planWin32({ host, port, bypass, base, mode }) {
  const steps = [];
  const add = (name, type, value) =>
    steps.push({ cmd: 'reg', args: ['add', WIN_KEY, '/v', name, '/t', type, '/d', value, '/f'] });
  const del = (name) =>
    steps.push({ cmd: 'reg', args: ['delete', WIN_KEY, '/v', name, '/f'], optional: true });

  if (mode === 'restore') {
    if (!base) throw new Error('还原需要快照');
    // 按快照逐项写回，包括「原本没有这一项」的情况
    if (base.server == null || base.server === '') del('ProxyServer');
    else add('ProxyServer', 'REG_SZ', base.server);
    if (base.override == null || base.override === '') del('ProxyOverride');
    else add('ProxyOverride', 'REG_SZ', base.override);
    if (base.autoconfig) add('AutoConfigURL', 'REG_SZ', base.autoconfig);
    else del('AutoConfigURL');
    add('ProxyEnable', 'REG_DWORD', base.enable ? '1' : '0');
  } else if (mode === 'off') {
    add('ProxyEnable', 'REG_DWORD', '0');
  } else {
    add('ProxyServer', 'REG_SZ', `${host}:${port}`);
    add('ProxyOverride', 'REG_SZ', bypass);
    // PAC 优先级高于手动代理：不清掉它，下面的 ProxyEnable 等于白设
    del('AutoConfigURL');
    add('ProxyEnable', 'REG_DWORD', '1');
  }

  // 通知系统重读（39 = SETTINGS_CHANGED，37 = REFRESH）
  steps.push({
    cmd: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-Command',
      '$s=\'[DllImport("wininet.dll",SetLastError=true)]public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);\';'
      + 'Add-Type -MemberDefinition $s -Name W -Namespace Jms -PassThru|Out-Null;'
      + '[Jms.W]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)|Out-Null;'
      + '[Jms.W]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)|Out-Null'],
    optional: true,
  });
  return steps;
}

export const win32Adapter = {
  platform: 'win32',
  defaultBypass: DEFAULT_BYPASS.join(';'),

  async thread() {
    const q = async (name) => {
      try {
        return parseRegQuery(await sh('reg', ['query', WIN_KEY, '/v', name]));
      } catch {
        return null;
      }
    };
    const [enable, server, override, autoconfig] = await Promise.all([
      q('ProxyEnable'), q('ProxyServer'), q('ProxyOverride'), q('AutoConfigURL'),
    ]);
    // WinHTTP 是独立的一套，读失败不影响主流程
    let winhttp = null;
    try {
      const out = await sh('netsh', ['winhttp', 'show', 'proxy']);
      if (/Proxy Server\(s\)\s*:\s*(\S+)/i.test(out)) winhttp = /Proxy Server\(s\)\s*:\s*(\S+)/i.exec(out)[1];
    } catch {
      /* ignore */
    }
    const on = String(enable) === '0x1' || String(enable) === '1';
    const { host, port, perProtocol } = parseWinServer(server);
    return {
      mode: on ? 'on' : 'off',
      host, port,
      bypass: override || null,
      base: {
        enable: on, server: server ?? null, override: override ?? null,
        autoconfig: autoconfig || null, winhttp, perProtocol,
      },
    };
  },

  async read() {
    const t = await win32Adapter.thread();
    const { base, ...pub } = t;
    return pub;
  },

  plan(target) {
    return planWin32({ ...target, bypass: target.bypass ?? win32Adapter.defaultBypass });
  },

  async apply(target) {
    await execPlan(win32Adapter.plan(target));
  },

  async restore(base) {
    await execPlan(planWin32({ mode: 'restore', base }));
  },

  async snapshot() {
    return win32Adapter.thread();
  },
};

// ═══════════════════════════════ macOS ═══════════════════════════════
//
// macOS 的坑比另外两个平台加起来还多，逐条记在这里：
//
//   ① 一台机器有多张网络服务（Wi-Fi / Ethernet / Thunderbolt Bridge），每张各有
//      web / secure web / socks 三套独立开关。只改第一张、或只改 web，结果就是
//      "有的应用走了代理、有的没走"。
//   ② 与 Windows 的 PAC 是同一个陷阱：**Automatic Proxy Configuration 的优先级
//      高于手动代理**。用户装过 PAC（公司网络、加速器、描述文件）时，我们写的
//      manual 设置会被静默忽略 —— 表现为"显示已连接但流量没走代理"。
//      必须关掉 AutoProxyURL 与 AutoProxyDiscovery，并记下原值以便还原。
//   ③ 清空绕行域名要传字面量 'Empty'，传空字符串是非法调用。
//   ④ "当前网卡"不能取服务列表第一项：Thunderbolt Bridge / 虚拟网卡常常排在
//      Wi-Fi 前面，取第一项会读到一张根本没有流量的网卡。
//   ⑤ networksetup 的 man page 写着需要 admin 权限，但实测多数改动普通管理员
//      账户的进程即可完成；不同 macOS 版本行为有差异。所以这里不猜：
//      统一捕获权限类错误并标记 NEED_ELEVATION，让上层走同一套提权引导。

export const MAC_KINDS = ['webproxy', 'securewebproxy', 'socksfirewallproxy'];

/** 解析 `networksetup -getwebproxy "Wi-Fi"` 的输出 */
export function parseMacProxy(out) {
  const enabled = /Enabled:\s*Yes/i.test(out || '');
  // 用 [ \t]* 而不是 \s*：未设置主机时输出是 "Server: " 加换行，
  // \s* 会跨行把下一行的 "Port:" 当成主机名读进来。
  const host = /Server:[ \t]*(\S+)/i.exec(out || '')?.[1] || null;
  const port = Number(/Port:[ \t]*(\d+)/i.exec(out || '')?.[1] || 0) || null;
  return { enabled, host, port };
}

export function parseMacServices(out) {
  return String(out || '')
    .split('\n')
    .slice(1) // 首行是指令说明
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('*')); // * = 该服务已停用，不碰
}

/**
 * 解析 `networksetup -listnetworkserviceorder`，得到 设备名 → 服务名 的映射。
 *
 * 输出形如：
 *   (1) Wi-Fi
 *   (Hardware Port: Wi-Fi, Device: en0)
 * 有了它才能把 `route get default` 给出的 en0 反查成 "Wi-Fi"。
 */
export function parseMacServiceOrder(out) {
  const map = {};
  const re = /^\((\d+)\)\s*(.+)$/gm;
  let m;
  const names = [];
  while ((m = re.exec(String(out || '')))) names.push({ idx: Number(m[1]), name: m[2].trim() });
  for (const { idx, name } of names) {
    const block = String(out).split(/^\(\d+\)\s/m)[idx];
    if (!block) continue;
    const dev = /Device:\s*([^,)\s]+)/i.exec(block)?.[1];
    if (dev) map[dev] = name;
  }
  return map;
}

export const MAC_KINDS_FOR_PLAN = MAC_KINDS;

/** VPN / Network Extension services without a device do not support these proxy settings. */
export function macProxyServices(names, order) {
  const supported = new Set(Object.values(parseMacServiceOrder(order)));
  return names.filter(name => supported.has(name));
}

export function parseMacEffectiveProxy(out) {
  const value = key => new RegExp('^\\s*' + key + '\\s*:\\s*(.*?)\\s*$', 'm').exec(String(out))?.[1];
  const enabled = value('HTTPEnable') === '1';
  return {
    mode: enabled ? 'on' : 'off', host: enabled ? value('HTTPProxy') ?? null : null,
    port: enabled ? Number(value('HTTPPort')) || null : null,
    https: { enabled: value('HTTPSEnable') === '1', host: value('HTTPSProxy') ?? null, port: Number(value('HTTPSPort')) || null },
  };
}

/**
 * 生成 macOS 的写入计划：逐网卡、逐协议，绝不笼统地「全关」。
 *
 * @param mode 'on' | 'off' | 'restore'
 * @param base 快照（含 services 数组），restore / off 必需
 */
export function planDarwin({ host, port, bypass, base, mode }) {
  const steps = [];
  const push = (args, optional) => steps.push({ cmd: 'networksetup', args, optional });

  if (mode === 'restore') {
    if (!base?.services?.length) throw new Error('还原需要快照');
    for (const svc of base.services) {
      for (const kind of MAC_KINDS) {
        const cur = svc[kind];
        if (!cur) continue;
        if (cur.enabled && cur.host && cur.port) {
          push([`-set${kind}`, svc.name, cur.host, String(cur.port)]);
          push([`-set${kind}state`, svc.name, 'on']);
        } else {
          push([`-set${kind}state`, svc.name, 'off'], true);
        }
      }
      // 绕行域名：原本没有就必须清空，否则会留下我们写进去的那一份
      if (svc.bypass && svc.bypass.length) {
        push(['-setproxybypassdomains', svc.name, ...svc.bypass]);
      } else {
        push(['-setproxybypassdomains', svc.name, 'Empty'], true);
      }
      // 用户原来的自动代理配置必须被恢复，否则等于我们替他关掉了公司 PAC
      const ap = svc.autoproxy;
      if (ap?.url) {
        push(['-setautoproxyurl', svc.name, ap.url]);
        push(['-setautoproxystate', svc.name, ap.enabled ? 'on' : 'off']);
      } else {
        push(['-setautoproxystate', svc.name, 'off'], true);
      }
      push(['-setproxyautodiscovery', svc.name, svc.autodiscovery ? 'on' : 'off'], true);
    }
    return steps;
  }

  if (mode === 'off') {
    for (const svc of base?.services || []) {
      for (const kind of MAC_KINDS) push([`-set${kind}state`, svc.name, 'off'], true);
    }
    return steps;
  }

  for (const svc of base?.services || []) {
    // 自动代理配置的优先级高于手动代理：必须先关，否则下面的设置会被静默忽略
    push(['-setautoproxystate', svc.name, 'off'], true);
    push(['-setproxyautodiscovery', svc.name, 'off'], true);
    // 三个协议都设：sing-box 的 mixed 入站同时接受 HTTP 与 SOCKS，
    // 所以 SOCKS 也指向同一个端口是正确的，不是笔误。
    for (const kind of MAC_KINDS) {
      push([`-set${kind}`, svc.name, host, String(port)]);
      push([`-set${kind}state`, svc.name, 'on']);
    }
    const list = bypass?.length ? bypass : DEFAULT_BYPASS_MACOS;
    push(['-setproxybypassdomains', svc.name, ...list]);
  }
  return steps;
}

export const darwinAdapter = {
  platform: 'darwin',
  defaultBypass: DEFAULT_BYPASS_MACOS,

  async services() {
    const names = parseMacServices(await sh('networksetup', ['-listallnetworkservices']));
    const order = await sh('networksetup', ['-listnetworkserviceorder']);
    return macProxyServices(names, order);
  },

  /** 默认路由走的是哪张网卡 → 反查服务名。比"取列表第一项"可靠得多。 */
  async activeServiceName() {
    try {
      const route = await sh('route', ['-n', 'get', 'default']);
      const dev = /interface:\s*(\S+)/.exec(route)?.[1];
      if (!dev) return null;
      const order = await sh('networksetup', ['-listnetworkserviceorder']);
      return parseMacServiceOrder(order)[dev] ?? null;
    } catch {
      return null;
    }
  },

  async thread() {
    const names = await darwinAdapter.services();
    const services = [];
    for (const name of names) {
      const entry = { name, bypass: [] };
      for (const kind of MAC_KINDS) {
        try {
          entry[kind] = parseMacProxy(await sh('networksetup', [`-get${kind}`, name]));
        } catch {
          entry[kind] = { enabled: false, host: null, port: null };
        }
      }
      try {
        const out = await sh('networksetup', ['-getproxybypassdomains', name]);
        // 两种"没有绕行域名"的表述都要认
        entry.bypass = /There aren't any bypass domains/i.test(out)
          ? []
          : out.split('\n').map((s) => s.trim()).filter(Boolean);
      } catch {
        entry.bypass = [];
      }
      try {
        const out = await sh('networksetup', ['-getautoproxyurl', name]);
        entry.autoproxy = {
          url: /URL:[ \t]*(\S+)/i.exec(out)?.[1] || null,
          enabled: /Enabled:\s*Yes/i.test(out),
        };
      } catch {
        entry.autoproxy = { url: null, enabled: false };
      }
      try {
        const out = await sh('networksetup', ['-getproxyautodiscovery', name]);
        entry.autodiscovery = /Enabled:\s*On/i.test(out);
      } catch {
        entry.autodiscovery = false;
      }
      services.push(entry);
    }

    // 对外视图取**实际承载默认路由**的那张网卡；识别不出来才退回第一张。
    // 只影响展示与"是否指向我们"的判断，完整快照始终是全量的。
    const activeName = await darwinAdapter.activeServiceName();
    const active = services.find((s) => s.name === activeName) || services[0];
    const web = active?.webproxy;
    const on = Boolean(web?.enabled);
    return {
      mode: on ? 'on' : 'off',
      host: on ? web.host : null,
      port: on ? web.port : null,
      bypass: active?.bypass?.length ? active.bypass : null,
      service: active?.name ?? null,
      base: { services },
    };
  },

  async read() {
    return parseMacEffectiveProxy(await sh('scutil', ['--proxy']));
  },

  plan(target) {
    return planDarwin({ ...target, bypass: target.bypass ?? DEFAULT_BYPASS_MACOS });
  },

  async apply(target) {
    const base = target.base ?? (await darwinAdapter.snapshot()).base;
    if (!base?.services?.length) throw new Error('没有可配置系统代理的网络服务');
    await execPlan(darwinAdapter.plan({ ...target, base }));
  },

  async restore(base) {
    await execPlan(planDarwin({ mode: 'restore', base }));
  },

  async snapshot() {
    return darwinAdapter.thread();
  },
};

// ═══════════════════════════════ Linux (GNOME) ═══════════════════════════════
const G = 'org.gnome.system.proxy';

/** 解析 `gsettings get ...` 输出的 GVariant 字面量 */
export function parseGVariant(raw) {
  const s = String(raw ?? '').trim();
  if (s === '' || s === '@as []' || s === '[]') return [];
  const body = s.replace(/^@as\s*/, '');
  const out = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(body))) out.push(m[1] ?? m[2] ?? '');
  return out;
}

export function planLinux({ host, port, bypass, base, mode }) {
  const steps = [];
  const set = (k, v) => steps.push({ cmd: 'gsettings', args: ['set', G, k, v] });

  if (mode === 'restore') {
    if (!base) throw new Error('还原需要快照');
    for (const [k, v] of Object.entries(base.values || {})) set(k, v);
    set('mode', base.mode === 'none' ? 'none' : base.mode);
    return steps;
  }
  if (mode === 'off') {
    set('mode', 'none');
    return steps;
  }
  for (const scheme of ['http', 'https', 'socks']) {
    set(`${scheme} host`, host);
    set(`${scheme} port`, String(port));
  }
  const list = (bypass?.length ? bypass : ['localhost', '127.0.0.0/8', '::1'])
    .map((h) => `'${h}'`).join(', ');
  set('ignore-hosts', `[${list}]`);
  set('mode', 'manual');
  return steps;
}

export const linuxAdapter = {
  platform: 'linux',
  defaultBypass: ['localhost', '127.0.0.0/8', '::1'],

  async thread() {
    const get = (k) =>
      sh('gsettings', ['get', G, k]).then((s) => s.trim()).catch(() => null);
    const mode = (await get('mode'))?.replace(/^'|'$/g, '') || 'none';
    const [hHost, hPort, sHost, sPort, socksHost, socksPort, ignore, auto] = await Promise.all([
      get('http host'), get('http port'), get('https host'), get('https port'),
      get('socks host'), get('socks port'), get('ignore-hosts'), get('autoconfig-url'),
    ]);
    const strip = (v) => (v == null ? null : v.replace(/^'|'$/g, ''));
    return {
      mode: mode === 'none' ? 'off' : 'on',
      host: strip(hHost) || null,
      port: Number(hPort) || null,
      bypass: parseGVariant(ignore),
      base: {
        mode,
        values: {
          'http host': hHost ?? "''", 'http port': hPort ?? '0',
          'https host': sHost ?? "''", 'https port': sPort ?? '0',
          'socks host': socksHost ?? "''", 'socks port': socksPort ?? '0',
          'ignore-hosts': ignore ?? '[]',
          'autoconfig-url': auto ?? "''",
        },
      },
    };
  },

  async read() {
    const { base, ...pub } = await linuxAdapter.thread();
    return pub;
  },

  plan(target) {
    return planLinux({ ...target, bypass: target.bypass ?? linuxAdapter.defaultBypass });
  },

  async apply(target) {
    await execPlan(linuxAdapter.plan(target));
  },

  async restore(base) {
    await execPlan(planLinux({ mode: 'restore', base }));
  },

  async snapshot() {
    return linuxAdapter.thread();
  },
};

export function getAdapter(platform = process.platform) {
  switch (platform) {
    case 'win32':
      return win32Adapter;
    case 'darwin':
      return darwinAdapter;
    case 'linux':
      return linuxAdapter;
    default:
      throw new Error(`不支持的系统代理平台: ${platform}`);
  }
}

/** 测试与演示用的内存适配器 —— 不碰真实系统设置 */
export class MockAdapter {
  constructor(initial = { mode: 'off', host: null, port: null, bypass: null }, platform = 'linux') {
    this.platform = platform;
    this.state = { ...initial };
    this.calls = [];
    this.failNext = false;
    this.lastBase = null;
  }

  async read() {
    this.calls.push({ op: 'read' });
    const { base, ...pub } = this.state;
    this.lastBase = base ?? this.lastBase;
    return pub;
  }

  async apply(next) {
    this.calls.push({ op: 'apply', next: { ...next } });
    if (this.failNext) {
      this.failNext = false;
      throw new Error('模拟系统代理设置失败');
    }
    this.state = { ...this.state, ...next };
  }

  async restore(base) {
    this.calls.push({ op: 'restore', base });
    this.state = { ...this.state, ...(base?.state || { mode: 'off' }) };
  }
}
