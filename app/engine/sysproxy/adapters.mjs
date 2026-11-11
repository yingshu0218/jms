import { createDarwinPreferencesAdapter } from './preferences.mjs';
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
import { promisify, isDeepStrictEqual } from 'node:util';

const run = promisify(execFile);

async function sh(cmd, args, opts = {}) {
  const { input, ...options } = opts;
  const pending = run(cmd, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 10000, ...options });
  if (input !== undefined) pending.child.stdin.end(input);
  const { stdout } = await pending;
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
  const field = (name) => {
    const values = [...String(out || '').matchAll(new RegExp('^' + name + ':[ \t]*(.*)$', 'gm'))];
    if (values.length !== 1) throw darwinError('系统代理快照字段缺失或无法解析');
    return values[0][1].trim();
  };
  const enabled = field('Enabled'), host = field('Server'), rawPort = field('Port');
  const authenticated = field('Authenticated Proxy Enabled');
  if (!['Yes', 'No'].includes(enabled) || !/^(0|[1-9]\d*)$/.test(rawPort) ||
      Number(rawPort) > 65535 || !['0', '1'].includes(authenticated)) throw darwinError('系统代理快照无法解析');
  return { enabled: enabled === 'Yes', host: host || null, port: Number(rawPort) || null, authenticated: authenticated === '1' };
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
export function darwinError(message = '系统代理恢复状态无法确认，未覆盖现有网络设置') {
  return Object.assign(new Error(message), { code: 'RECOVERY_REQUIRED' });
}
const textValue = value => typeof value === 'string' && value.length > 0 && !/[\r\n\0]/.test(value);
export function validateDarwinBase(base, { restorable = false } = {}) {
  if (base?.schema !== 2 || !Array.isArray(base.services) || !base.services.length) throw darwinError('需要完整版本2系统代理快照');
  const ids = new Set(), names = new Set();
  for (const svc of base.services) {
    if (!/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(svc.id || '') || !textValue(svc.name) || !textValue(svc.device) || ids.has(svc.id) || names.has(svc.name)) throw darwinError('网络服务身份无效或重复');
    ids.add(svc.id); names.add(svc.name);
    for (const kind of MAC_KINDS) {
      const p = svc[kind];
      if (!p || typeof p.enabled !== 'boolean' || typeof p.authenticated !== 'boolean' ||
          !(p.host === null || (textValue(p.host) && !/\s/.test(p.host))) || !(p.port === null || (Number.isInteger(p.port) && p.port > 0 && p.port <= 65535)) ||
          (p.enabled && (!p.host || !p.port))) throw darwinError('系统代理快照不完整');
      // networksetup cannot reveal passwords or reliably restore an unset stored
      // endpoint. Refuse takeover rather than claiming a lossy rollback is safe.
      if (restorable && (p.authenticated || !p.host || !p.port)) throw darwinError('认证代理或未设置的代理地址无法无损还原，已拒绝接管');
    }
    if (!Array.isArray(svc.bypass) || svc.bypass.some(v => !textValue(v) || /\s/.test(v) || v === 'Empty') ||
        typeof svc.autodiscovery !== 'boolean' || !svc.autoproxy || typeof svc.autoproxy.enabled !== 'boolean' ||
        !(svc.autoproxy.url === null || textValue(svc.autoproxy.url)) || (svc.autoproxy.enabled && !svc.autoproxy.url)) throw darwinError('自动代理或绕行快照不完整');
  }
  return base;
}
const canonicalBase = base => ({ schema: 2, services: [...base.services].sort((a, b) => a.id.localeCompare(b.id)) });
const equalBase = (a, b) => isDeepStrictEqual(canonicalBase(a), canonicalBase(b));
const clone = value => structuredClone(value);

export function planDarwin({ host, port, bypass, base, mode }) {
  validateDarwinBase(base, { restorable: mode !== 'off' });
  if (!['on', 'off', 'restore'].includes(mode)) throw darwinError('无效系统代理操作');
  const steps = [];
  const push = args => steps.push({ cmd: 'networksetup', args });
  if (mode === 'restore') {
    for (const svc of base.services) {
      for (const kind of MAC_KINDS) {
        const p = svc[kind];
        // Stored addresses matter even while a proxy is disabled.
        push([`-set${kind}`, svc.name, p.host, String(p.port), 'off']);
        push([`-set${kind}state`, svc.name, p.enabled ? 'on' : 'off']);
      }
      push(['-setproxybypassdomains', svc.name, ...(svc.bypass.length ? svc.bypass : ['Empty'])]);
      // Takeover never changes the stored PAC URL, only its enabled flag.
      push(['-setautoproxystate', svc.name, svc.autoproxy.enabled ? 'on' : 'off']);
      push(['-setproxyautodiscovery', svc.name, svc.autodiscovery ? 'on' : 'off']);
    }
  } else if (mode === 'off') {
    for (const svc of base.services) for (const kind of MAC_KINDS) push([`-set${kind}state`, svc.name, 'off']);
  } else {
    if (!textValue(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw darwinError('代理目标无效');
    const domains = bypass ?? DEFAULT_BYPASS_MACOS;
    if (!Array.isArray(domains) || domains.some(v => !textValue(v) || /\s/.test(v) || v === 'Empty')) throw darwinError('绕行列表无效');
    for (const svc of base.services) {
      push(['-setautoproxystate', svc.name, 'off']);
      push(['-setproxyautodiscovery', svc.name, 'off']);
      for (const kind of MAC_KINDS) {
        push([`-set${kind}`, svc.name, host, String(port), 'off']);
        push([`-set${kind}state`, svc.name, 'on']);
      }
      push(['-setproxybypassdomains', svc.name, ...(domains.length ? domains : ['Empty'])]);
    }
  }
  return steps;
}

// Expected complete states for one command, including networksetup versions that
// enable a proxy while assigning an endpoint versus retaining its previous flag.
function afterCommand(base, step) {
  const next = clone(base), [command, name, value, port] = step.args;
  const svc = next.services.find(s => s.name === name);
  if (!svc) throw darwinError('网络服务身份已改变');
  for (const kind of MAC_KINDS) {
    if (command === `-set${kind}`) {
      svc[kind] = { ...svc[kind], host: value, port: Number(port), authenticated: false };
      const enabled = clone(next); enabled.services.find(s => s.name === name)[kind].enabled = true;
      return [next, enabled];
    }
    if (command === `-set${kind}state`) { svc[kind].enabled = value === 'on'; return [next]; }
  }
  if (command === '-setautoproxystate') svc.autoproxy.enabled = value === 'on';
  else if (command === '-setproxyautodiscovery') svc.autodiscovery = value === 'on';
  else if (command === '-setproxybypassdomains') svc.bypass = value === 'Empty' ? [] : step.args.slice(2);
  else throw darwinError('未知系统代理写入命令');
  return [next];
}

export function createDarwinAdapter({ execute = sh } = {}) {
  const command = (cmd, args, options = {}) => execute(cmd, args, { ...options, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
  const ns = args => command('networksetup', args);
  const sc = input => command('scutil', [], { input: input + '\nquit\n' });
  const scalar = (out, key) => {
    const found = [...String(out).matchAll(new RegExp('^\\s*' + key + '\\s*:\\s*(.*?)\\s*$', 'gm'))];
    if (found.length !== 1 || !found[0][1]) throw darwinError('网络服务身份无法解析');
    return found[0][1];
  };
  async function identities() {
    const listed = await ns(['-listallnetworkservices']);
    if (!String(listed).startsWith('An asterisk (*) denotes')) throw darwinError('网络服务列表无法解析');
    const names = parseMacServices(listed);
    const order = await ns(['-listnetworkserviceorder']);
    const entries = [...String(order).matchAll(/^\((\d+)\)[ \t]*(.+)\r?\n\(Hardware Port:[ \t]*([^,\r\n]+),[ \t]*Device:[ \t]*([^)\r\n]*)\)[ \t]*$/gm)]
      .map(m => ({ name: m[2].trim(), device: m[4].trim() }));
    const mapping = {};
    for (const name of names) {
      const matches = entries.filter(e => e.name === name);
      if (matches.length !== 1) throw darwinError('网络服务顺序不完整或无法解析');
      const device = matches[0].device;
      if (device) {
        if (mapping[device]) throw darwinError('网络设备身份不唯一');
        mapping[device] = name;
      }
    }
    const selected = names.filter(name => Object.values(mapping).includes(name));
    if (!selected.length) throw darwinError('没有可配置系统代理的网络服务');
    const listing = await sc('list Setup:/Network/Service/.*/Interface');
    const ids = [...String(listing).matchAll(/Setup:\/Network\/Service\/([a-fA-F0-9-]+)\/Interface/g)].map(m => m[1]);
    if (!ids.length || new Set(ids).size !== ids.length) throw darwinError('网络服务UUID无法解析');
    const result = [];
    for (const id of ids) {
      const description = await sc(`show Setup:/Network/Service/${id}`);
      const name = scalar(description, 'UserDefinedName');
      if (!selected.includes(name)) continue;
      const device = scalar(await sc(`show Setup:/Network/Service/${id}/Interface`), 'DeviceName');
      if (mapping[device] !== name) throw darwinError('网络服务名称与设备身份不一致');
      result.push({ id, name, device });
    }
    if (result.length !== selected.length || new Set(result.map(s => s.name)).size !== result.length) throw darwinError('网络服务UUID身份不完整');
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }
  async function snapshot() {
    const services = [];
    const initialIdentities = await identities();
    for (const identity of initialIdentities) {
      const svc = { ...identity };
      for (const kind of MAC_KINDS) svc[kind] = parseMacProxy(await ns([`-get${kind}`, svc.name]));
      const bypass = String(await ns(['-getproxybypassdomains', svc.name])).trim();
      if (!bypass) throw darwinError('绕行列表读取为空，无法确认原状态');
      svc.bypass = /^There aren't any bypass domains(?: set on .+)?\.?$/i.test(bypass) ? [] : bypass.split('\n').map(v => v.trim());
      const pac = String(await ns(['-getautoproxyurl', svc.name]));
      const urls = [...pac.matchAll(/^URL:[ \t]*(.*)$/gm)], enabled = [...pac.matchAll(/^Enabled:[ \t]*(.*)$/gm)];
      if (urls.length !== 1 || enabled.length !== 1 || !['Yes', 'No'].includes(enabled[0][1].trim())) throw darwinError('PAC快照无法解析');
      const url = urls[0][1].trim();
      svc.autoproxy = { url: !url || url === '(null)' ? null : url, enabled: enabled[0][1].trim() === 'Yes' };
      const discovery = String(await ns(['-getproxyautodiscovery', svc.name])).trim();
      const match = /^(?:Auto Proxy Discovery|Enabled):[ \t]*(On|Off)$/i.exec(discovery);
      if (!match) throw darwinError('自动发现快照无法解析');
      svc.autodiscovery = match[1].toLowerCase() === 'on';
      services.push(svc);
    }
    if (!isDeepStrictEqual(initialIdentities, await identities())) throw darwinError('读取期间网络服务身份发生变化，未修改设置');
    const base = validateDarwinBase({ schema: 2, services });
    const active = services[0], proxy = active.webproxy;
    return { mode: proxy.enabled ? 'on' : 'off', host: proxy.enabled ? proxy.host : null,
      port: proxy.enabled ? proxy.port : null, bypass: active.bypass.length ? active.bypass : null,
      service: active.name, base };
  }
  function validateEntry(entry) {
    if (entry?.version !== 2 || entry.platform !== 'darwin' || entry.darwin?.schema !== 1 || !Array.isArray(entry.darwin.states) || !entry.darwin.states.length) throw darwinError('恢复日志版本或平台不匹配，未修改设置');
    validateDarwinBase(entry.previousBase, { restorable: true });
    validateDarwinBase(entry.darwin.targetBase, { restorable: true });
    for (const state of entry.darwin.states) validateDarwinBase(state, { restorable: true });
    const identity = b => b.services.map(({ id, name, device }) => ({ id, name, device })).sort((a, b) => a.id.localeCompare(b.id));
    for (const state of [entry.darwin.targetBase, ...entry.darwin.states]) if (!isDeepStrictEqual(identity(state), identity(entry.previousBase))) throw darwinError('恢复日志服务身份不一致');
    if (!entry.darwin.states.some(s => equalBase(s, entry.previousBase))) throw darwinError('恢复日志缺少原始状态');
  }
  async function checkedCurrent(entry) {
    validateEntry(entry);
    const current = (await snapshot()).base;
    if (!entry.darwin.states.some(state => equalBase(state, current))) throw darwinError('系统代理存在外部改动或网络服务变化，已保留恢复日志且未覆盖');
    return current;
  }
  async function transact(steps, desired, journal) {
    if (!journal?.updateDarwin) throw darwinError('写系统代理前必须具有可持久化事务日志');
    let entry = journal.read(), current = await checkedCurrent(entry);
    if (equalBase(current, desired)) return;
    for (const step of steps) {
      // Check all services before every write, not merely the one being changed.
      entry = journal.read(); current = await checkedCurrent(entry);
      const expected = afterCommand(current, step);
      if (expected.every(state => equalBase(state, current))) continue;
      const states = [...entry.darwin.states];
      for (const state of expected) if (!states.some(s => equalBase(s, state))) states.push(state);
      // Intent precedes the write, so a crash after partial execution is provable.
      journal.updateDarwin({ ...entry.darwin, states });
      try { await command(step.cmd, step.args); }
      catch (error) { throw Object.assign(new Error('系统代理写入失败，恢复日志已保留'), { code: classifyExecError(error.message) || 'RECOVERY_REQUIRED' }); }
      const actual = (await snapshot()).base;
      if (!expected.some(state => equalBase(state, actual))) throw darwinError('系统代理命令读回不一致，恢复日志已保留');
    }
    if (!equalBase((await snapshot()).base, desired)) throw darwinError('系统代理最终读回不一致，恢复日志已保留');
  }
  return {
    platform: 'darwin', transactionVersion: 2, defaultBypass: DEFAULT_BYPASS_MACOS,
    services: async () => (await identities()).map(s => s.name),
    activeServiceName: async () => {
      const route = await command('route', ['-n', 'get', 'default']);
      const device = /interface:\s*(\S+)/.exec(route)?.[1];
      return (await identities()).find(s => s.device === device)?.name ?? null;
    },
    thread: snapshot, snapshot,
    read: async () => parseMacEffectiveProxy(await command('scutil', ['--proxy'])),
    plan: target => planDarwin({ ...target, bypass: target.bypass ?? DEFAULT_BYPASS_MACOS }),
    prepareTransaction(snap, target) {
      validateDarwinBase(snap.base, { restorable: true });
      const steps = planDarwin({ ...target, base: snap.base });
      let targetBase = clone(snap.base);
      for (const step of steps) targetBase = afterCommand(targetBase, step).at(-1);
      return { schema: 1, states: [clone(snap.base)], targetBase };
    },
    async apply(target, { journal } = {}) {
      const entry = journal?.read(); validateEntry(entry);
      await transact(planDarwin({ ...target, base: entry.previousBase }), entry.darwin.targetBase, journal);
    },
    async restore(base, { journal } = {}) {
      const entry = journal?.read(); validateEntry(entry);
      if (!equalBase(base, entry.previousBase)) throw darwinError('恢复目标与日志不符');
      await transact(planDarwin({ mode: 'restore', base }), base, journal);
    },
    async verifyRestored(entry) { return equalBase(await checkedCurrent(entry), entry.previousBase); },
  };
}
export const darwinAdapter = createDarwinAdapter();

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
      return process.env.JMS_PROXY_HELPER ? createDarwinPreferencesAdapter({readPublic: () => darwinAdapter.read()}) : darwinAdapter;
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
