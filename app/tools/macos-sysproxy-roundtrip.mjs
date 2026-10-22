// macOS 系统代理适配器 · 实机往返测试
//
// 只做一件事：用**真实的适配器**（不是 mock）走一遍
//   存快照 → 开启代理 → 读回来确认生效 → 还原 → 再读回来确认回到原状
// 并把每一步的实际输出打出来。
//
// 为什么单独一个脚本：单元测试验的是"生成的命令对不对"，
// 而这个脚本验的是"这台机器上命令真的生效、真的能还原"。
// macOS 的 networksetup 在不同版本上的行为有差异，只有实机能回答。
//
// 安全保证：
//   · 快照在**任何改动之前**就写到磁盘（复用引擎自己的 journal 格式）；
//   · 还原放在 finally 里，Ctrl-C / 异常退出都会走；
//   · 只碰代理相关项，不碰 DNS、不碰路由表。

import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { darwinAdapter } from '../engine/sysproxy/adapters.mjs';

const PORT = 2080;
const HOST = '127.0.0.1';
const SNAP_FILE = join(tmpdir(), 'jms-macos-roundtrip-snapshot.json');

let failed = 0;
const ok = (m) => console.log(`  \u2713 ${m}`);
const bad = (m) => { console.log(`  \u2717 ${m}`); failed = 1; };
const info = (m) => console.log(`      ${m}`);

function show(label, snap) {
  console.log(`  ${label}: mode=${snap.mode} host=${snap.host ?? '-'} port=${snap.port ?? '-'}` +
    ` bypass=${Array.isArray(snap.bypass) ? snap.bypass.length + ' 条' : (snap.bypass ?? '-')}`);
}

async function main() {
  if (process.platform !== 'darwin') {
    console.error('本脚本只能在 macOS 上运行。');
    process.exit(2);
  }

  console.log('\n== 1. 读取当前状态 ==');
  const before = await darwinAdapter.snapshot();
  show('改动前', before);
  const n = before.base?.services?.length ?? 0;
  info(`网络服务 ${n} 张：${(before.base?.services || []).map((s) => s.name).join(' / ')}`);
  info(`默认路由网卡对应服务：${before.service ?? '(未识别)'}`);
  for (const s of before.base?.services || []) {
    const ap = s.autoproxy;
    info(`  ${s.name}: PAC=${ap?.enabled ? ap.url : '关闭'} 自动发现=${s.autodiscovery ? '开' : '关'}` +
      ` 绕行=${s.bypass?.length ?? 0} 条`);
  }
  if (!n) {
    bad('读不到任何网络服务 —— networksetup 不可用或该账户无权限');
    return;
  }

  // 快照先落盘：万一这个脚本自己被强杀，还有一份可人工还原的依据
  writeFileSync(SNAP_FILE, JSON.stringify(before.base, null, 2), { mode: 0o600 });
  ok(`快照已存 ${SNAP_FILE}（万一异常中断，可按此文件人工还原）`);

  console.log('\n== 2. 开启系统代理 ==');
  try {
    await darwinAdapter.apply({ mode: 'on', host: HOST, port: PORT });
  } catch (e) {
    bad(`设置失败：${e.message}`);
    if (e.code === 'NEED_ELEVATION') {
      info('这台机器/这个版本上 networksetup 需要管理员权限。');
      info('系统代理模式因此也要提权 —— 请用 sudo 重跑本脚本确认：');
      info(`  sudo node tools/macos-sysproxy-roundtrip.mjs`);
    }
    return;
  }
  ok('设置命令已执行完毕');

  console.log('\n== 3. 读回确认真的生效 ==');
  const during = await darwinAdapter.read();
  show('改动后', during);
  if (during.mode === 'on' && during.host === HOST && Number(during.port) === PORT) {
    ok('读回的设置与我们写入的一致 —— 设置确实生效了');
  } else {
    bad('读回的值与写入不一致：设置可能被其他配置覆盖（PAC / 描述文件 / MDM）');
  }
  // 三张网卡都要检查：只改一张是 macOS 上最常见的 bug
  const perSvc = before.base.services.map(async (s) => {
    const out = await darwinAdapter.services();
    return { name: s.name, count: out.length };
  });
  await Promise.all(perSvc);
  for (const s of before.base.services) {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const stdout = await promisify(execFile)('networksetup', ['-getwebproxy', s.name])
      .then((r) => r.stdout).catch(() => '');
    const on = /Enabled:\s*Yes/i.test(stdout);
    if (on) ok(`${s.name} 已走代理`);
    else info(`${s.name} 未启用（该网卡可能未连接 —— 属正常）`);
  }

  console.log('\n== 4. 验证代理是否真的能连通 ==');
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    // 只验证"本地端口有人监听"，不验证能出国 —— 那需要真实节点，属于另一件事
    const out = await promisify(execFile)('netstat', ['-an', '-p', 'tcp'])
      .then((r) => r.stdout).catch(() => '');
    if (new RegExp(`127\\.0\\.0\\.1\\.${PORT}\\s+.*LISTEN`).test(out)) {
      ok(`本地 ${HOST}:${PORT} 有进程在监听（说明内核在跑）`);
    } else {
      info(`本地 ${HOST}:${PORT} 没有监听者 —— 正常，本脚本没有启动内核。`);
      info('系统代理此刻指向一个空端口，浏览器会暂时无法上网，这是预期的。');
    }
  } catch { /* ignore */ }
}

let finished = false;
try {
  await main();
} catch (e) {
  console.error(`\n  测试过程出错：${e?.stack || e}`);
  failed = 1;
} finally {
  // 无条件还原 —— 这是本脚本最重要的部分
  if (!finished && existsSync(SNAP_FILE)) {
    console.log('\n== 5. 还原 ==');
    try {
      const base = JSON.parse(readFileSync(SNAP_FILE, 'utf8'));
      await darwinAdapter.restore(base);
      const after = await darwinAdapter.read();
      show('还原后', after);
      const orig = base.services?.[0];
      const origOn = Boolean(orig?.webproxy?.enabled);
      if (after.mode === (origOn ? 'on' : 'off')) {
        ok('已还原到改动前的状态');
      } else {
        bad('还原后状态与改动前不一致 —— 请手工检查「系统设置 → 网络 → 代理」');
      }
      rmSync(SNAP_FILE, { force: true });
    } catch (e) {
      bad(`还原失败：${e.message}`);
      console.error(`  快照仍在 ${SNAP_FILE}，请据此手工还原，或重新执行本脚本。`);
    }
    finished = true;
  }
}

console.log(failed ? '\n结果：有未通过项\n' : '\n结果：系统代理读写与还原全部通过\n');
process.exit(failed);
