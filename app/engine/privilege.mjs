// 提权（特权检查与提权方案生成）
//
// 为什么需要这个模块：三种接管方式的权限需求**完全不同**，搞混了就是「看着连上了、
// 实际上没生效」或者「每次都弹 UAC」。
//
//   sysproxy     不需要提权。Windows 改 HKCU、macOS 用 networksetup、Linux 用 gsettings，
//                都是当前用户自己的设置。
//   tun-per-app  必须提权。创建虚拟网卡 + 改路由表 + 读进程表，全都要内核级权限：
//                Windows 要管理员，macOS 要 root，Linux 要 root 或 CAP_NET_ADMIN。
//
// 设计上同样把「判断」和「执行」分开：本模块只做纯判断、只生成方案，不真的去弹 UAC。
// 理由和系统代理适配器一样 —— 这样 Windows / macOS 的分支能在 Linux CI 上测。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

// 路径拼接要按**目标平台**的语义，不能用宿主机的。
// 本函数带 platform 参数，在 Linux 上被调用去算 Windows 路径时，
// 用宿主机的 path.join 会把 'C:\\app\\core' 算成当前目录。
function coreDirFor(platform, corePath) {
  return platform === 'win32' ? win32.dirname(corePath) : posix.dirname(corePath);
}

function joinFor(platform, dir, name) {
  return platform === 'win32' ? win32.join(dir, name) : posix.join(dir, name);
}

const run = promisify(execFile);

/** 各平台在 TUN 模式下的权限要求（用于生成提示文案，也用于判断是否需要提权） */
export const TUN_REQUIREMENT = {
  win32: {
    privileged: false,
    role: '管理员',
    why: '创建 wintun 虚拟网卡、修改路由表、读取进程表',
    how: 'UAC 提权后重启应用',
  },
  darwin: {
    privileged: false,
    role: 'root',
    why: '创建 utun 虚拟网卡、修改路由表',
    how: '以管理员身份重启业务引擎，原生界面保持普通用户权限',
  },
  linux: {
    privileged: false,
    role: 'root 或 CAP_NET_ADMIN',
    why: '创建 tun 虚拟网卡、修改路由表',
    how: 'sudo 运行，或给内核二进制加 cap_net_admin,cap_net_raw',
  },
};

/** 哪些接管方式需要提权 */
export function needsElevation(mode, platform = process.platform) {
  if (mode !== 'tun-per-app') return false;
  return Boolean(TUN_REQUIREMENT[platform]);
}

/**
 * 当前进程是否已有足够权限。
 *
 * `probe` 可注入，便于测试：Windows 的判定要靠外部命令，没法在 Linux CI 上实跑。
 */
export async function isElevated({ platform = process.platform, uid, probe } = {}) {
  if (platform === 'win32') {
    if (probe) return Boolean(await probe());
    // net session 需要管理员才能成功 —— 这是判断 Windows 是否提权最省事的可靠办法
    try {
      await run('net', ['session'], { windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }
  const id = uid ?? process.getuid?.();
  return id === 0;
}

/**
 * Linux 上更宽松的一条路：内核二进制带 cap_net_admin 就不必整个进程用 root。
 * 返回 true 表示已具备该能力。
 */
export async function hasCoreCapabilities(corePath) {
  if (!corePath || process.platform !== 'linux') return false;
  try {
    const { stdout } = await run('getcap', [corePath]);
    return /cap_net_admin/.test(stdout) && /cap_net_raw/.test(stdout);
  } catch {
    return false; // 没装 libcap 的发行版走 root 路线
  }
}

// ── 转义：这两个平台的命令要嵌进别的命令里，转义错了就执行不了 ──────────────

/** POSIX 单引号转义：' → '\'' */
export function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * AppleScript 字符串转义。
 *
 * osascript 的写法是 `do shell script "..."`，所以我们要在**已经是字符串**的
 * 命令里再嵌一层引号：反斜杠要先转，双引号也要转，顺序不能反。
 */
export function quoteForAppleScript(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Windows 上拼进 -ArgumentList 的参数转义（含空格的要用单引号包起来） */
export function quoteForWindows(s) {
  const t = String(s);
  return /[\s"]/.test(t) ? `'${t.replace(/'/g, "''")}'` : t;
}

/**
 * 生成提权重启方案。**纯函数**，返回要执行的命令，不去执行。
 *
 * @returns {{ cmd: string, args: string[], command: string, note: string }}
 *   `command` 是给用户看/复制的一行命令，`cmd`+`args` 是可直接 spawn 的形态。
 */
export function planElevation({ platform = process.platform, exe, args = [] }) {
  if (!exe) throw new Error('planElevation 需要可执行文件路径');

  if (platform === 'win32') {
    // Start-Process -Verb RunAs 会弹 UAC。参数用逗号分隔的列表传入。
    const argList = args.length
      ? ` -ArgumentList ${args.map(quoteForWindows).join(',')}`
      : '';
    const inner = `Start-Process -FilePath '${String(exe).replace(/'/g, "''")}'${argList} -Verb RunAs`;
    return {
      cmd: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', inner],
      command: `powershell -NoProfile -Command "${inner}"`,
      note: '将弹出 UAC 确认框；确认后以管理员身份重新启动。',
    };
  }

  if (platform === 'darwin') {
    // 逐段引用，避免路径里有空格时被拆断
    const shell = [exe, ...args].map(shQuote).join(' ');
    const script = `do shell script ${quoteForAppleScript(shell)} with administrator privileges`;
    return {
      cmd: 'osascript',
      args: ['-e', script],
      command: `osascript -e ${shQuote(script)}`,
      note: '将弹出系统授权对话框；确认后以 root 身份重新启动。',
    };
  }

  // Linux：pkexec 会弹图形化授权（桌面环境下可用）；没有桌面就退回 sudo 提示
  return {
    cmd: 'pkexec',
    args: [exe, ...args],
    command: `pkexec ${[exe, ...args].map(shQuote).join(' ')}`,
    note: '将弹出 polkit 授权框。若当前是纯终端环境，请改用：' +
      `sudo ${[exe, ...args].map(shQuote).join(' ')}`,
    fallback: `sudo ${[exe, ...args].map(shQuote).join(' ')}`,
  };
}

/**
 * Windows 特有的一步检查：TUN 模式必须有 wintun.dll。
 *
 * sing-box 在 Windows 上创建 TUN 依赖 wintun.dll，它要**放在内核二进制旁边**。
 * 缺了它内核会在启动时报「Cannot find wintun.dll」直接退出 ——
 * 这个错误对用户毫无指向性，所以在启动前就查出来，给出可操作的提示。
 */
export function checkCoreDependencies({ platform = process.platform, corePath } = {}) {
  if (platform !== 'win32') return { ok: true, missing: [] };
  if (!corePath) return { ok: true, missing: [] };
  const dll = joinFor('win32', coreDirFor('win32', corePath), 'wintun.dll');
  if (existsSync(dll)) return { ok: true, missing: [], wintun: dll };
  return {
    ok: false,
    missing: ['wintun.dll'],
    expectAt: dll,
    hint: `TUN 模式需要 wintun.dll，请把它放到内核同目录：${dll}（随包分发时放在 resources/core/ 下）`,
  };
}

/**
 * TUN 模式的完整准入检查。connect() 在启动内核之前调用它 —— 快速失败，
 * 不留下任何脏状态。
 *
 * @returns {{ ok, elevated, needsElevation, mode, platform, role, why, how, hint, elevation }}
 */
export async function checkTunPrivilege({
  mode,
  platform = process.platform,
  corePath,
  uid,
  probe,
  exe,
  args = [],
} = {}) {
  const reqd = needsElevation(mode, platform);
  const base = {
    mode: mode ?? null,
    platform,
    needsElevation: reqd,
    elevated: true,
    ok: true,
    canGrant: Boolean(exe),
  };
  if (!reqd) return base;

  const req = TUN_REQUIREMENT[platform];
  base.role = req.role;
  base.why = req.why;
  base.how = req.how;

  // Linux 的例外路径：内核二进制自带能力时不必整个进程提权
  if (platform === 'linux' && corePath && (await hasCoreCapabilities(corePath))) {
    return { ...base, elevated: false, ok: true, viaCapabilities: true };
  }

  const elevated = await isElevated({ platform, uid, probe });
  if (elevated) return { ...base, elevated: true };

  const deps = checkCoreDependencies({ platform, corePath });
  const hint =
    `TUN 模式需要${req.role}（${req.why}）。当前进程没有该权限。` +
    `解决办法：${req.how}。` +
    (deps.ok ? '' : ` 另外：${deps.hint}`);

  return {
    ...base,
    elevated: false,
    ok: false,
    missing: deps.missing,
    hint,
    message: `TUN 模式需要${req.role}，当前进程权限不足`,
    elevation: exe ? planElevation({ platform, exe, args }) : null,
  };
}

/** SEA 启动器可能在 argv[1] 重复放入可执行文件；开发态则须保留脚本。 */
export function relaunchArguments(argv = process.argv, exe = process.execPath) {
  return argv.slice(argv[1] === exe ? 2 : 1);
}
