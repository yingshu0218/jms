// 提权模块单测
//
// 全部跑在 Linux 上：验证的是**判断逻辑**和**生成的提权命令**，
// 不真的弹 UAC / polkit。Windows 的分支通过注入 probe 来测。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TUN_REQUIREMENT,
  needsElevation,
  isElevated,
  planElevation,
  quoteForAppleScript,
  quoteForWindows,
  shQuote,
  checkCoreDependencies,
  checkTunPrivilege,
} from '../engine/privilege.mjs';

// ─────────────────────────── 权限需求判断 ───────────────────────────
test('系统代理模式不需要提权', () => {
  for (const p of ['win32', 'darwin', 'linux']) {
    assert.equal(needsElevation('sysproxy', p), false, `${p} 的系统代理不该要权限`);
  }
});

test('TUN 模式在三个平台都需要提权', () => {
  for (const p of ['win32', 'darwin', 'linux']) {
    assert.equal(needsElevation('tun-per-app', p), true);
  }
});

test('未知接管方式不误判为需要提权', () => {
  assert.equal(needsElevation(undefined), false);
  assert.equal(needsElevation(''), false);
});

test('每个平台的权限要求都有可操作的说法，不能只有「需要权限」', () => {
  for (const [p, req] of Object.entries(TUN_REQUIREMENT)) {
    assert.ok(req.role, `${p} 缺 role`);
    assert.ok(req.why, `${p} 缺 why`);
    assert.ok(req.how, `${p} 缺 how`);
  }
});

// ─────────────────────────── 已提权判断 ───────────────────────────
test('非 Windows：uid 为 0 即已提权', async () => {
  assert.equal(await isElevated({ platform: 'linux', uid: 0 }), true);
  assert.equal(await isElevated({ platform: 'darwin', uid: 501 }), false);
  assert.equal(await isElevated({ platform: 'linux', uid: 1000 }), false);
});

test('Windows：通过注入的探测函数判断，不真的去跑 net session', async () => {
  assert.equal(await isElevated({ platform: 'win32', probe: async () => true }), true);
  assert.equal(await isElevated({ platform: 'win32', probe: async () => false }), false);
});

// ─────────────────────────── 转义 ───────────────────────────
test('shQuote 把单引号正确闭合再转义，路径里有空格也不会被拆断', () => {
  assert.equal(shQuote('/a b/c'), "'/a b/c'");
  assert.equal(shQuote("it's"), "'it'\\''s'");
});

test('AppleScript 转义先处理反斜杠再处理引号', () => {
  // 顺序反了会把 \" 的引号又转一遍，生成非法脚本
  assert.equal(quoteForAppleScript('a"b'), '"a\\"b"');
  assert.equal(quoteForAppleScript('a\\b'), '"a\\\\b"');
  assert.equal(quoteForAppleScript('a\\"b'), '"a\\\\\\"b"');
});

test('Windows 参数只在含空格或引号时才加引号', () => {
  assert.equal(quoteForWindows('--port'), '--port');
  assert.equal(quoteForWindows('127.0.0.1:2080'), '127.0.0.1:2080');
  assert.equal(quoteForWindows('C:\\Program Files\\x'), "'C:\\Program Files\\x'");
});

// ─────────────────────────── 提权方案生成 ───────────────────────────
test('Windows 方案用 Start-Process -Verb RunAs，这是弹 UAC 的唯一方式', () => {
  const plan = planElevation({
    platform: 'win32',
    exe: 'C:\\Program Files\\JMS Client\\jms-client.exe',
    args: ['--elevated'],
  });
  assert.equal(plan.cmd, 'powershell');
  const inner = plan.args.at(-1);
  assert.match(inner, /Start-Process/);
  assert.match(inner, /-Verb RunAs/);
  assert.match(inner, /--elevated/);
  // 带空格的路径必须被引起来，否则 PowerShell 会把 "Program" 当成第二个参数
  assert.match(inner, /'C:\\Program Files\\JMS Client\\jms-client\.exe'/);
});

test('Windows 无参数时不生成空的 -ArgumentList', () => {
  const plan = planElevation({ platform: 'win32', exe: 'C:\\x.exe' });
  assert.ok(!plan.args.at(-1).includes('-ArgumentList'));
});

test('macOS 方案用 osascript + administrator privileges', () => {
  const plan = planElevation({
    platform: 'darwin',
    exe: '/Applications/JMS Client.app/Contents/MacOS/jms-client',
    args: ['--elevated'],
  });
  assert.equal(plan.cmd, 'osascript');
  assert.equal(plan.args[0], '-e');
  const script = plan.args[1];
  assert.match(script, /^do shell script /);
  assert.match(script, /with administrator privileges$/);
  // 应用路径含空格，必须引用
  assert.match(script, /'\/Applications\/JMS Client\.app/);
});

test('macOS 生成的 AppleScript 能通过 osascript 的解析（本地实跑）', async () => {
  // 不真正执行提权，只把脚本交给 osascript 做语法解析：
  // 故意让它去跑一个不存在的命令 + 不给 administrator privileges，
  // 若脚本本身语法有误会报 syntax error，而不是 exec 失败。
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const runp = promisify(execFile);
  const cmd = 'definitely-not-a-real-command-jms 2>/dev/null';
  const script = `do shell script ${quoteForAppleScript(cmd)}`;
  if (process.platform !== 'darwin') {
    // Linux 上 osascript 不存在 —— 只能验证脚本形态，不能真的解析
    assert.match(script, /^do shell script "definitely-not-a-real-command-jms/);
    return;
  }
  try {
    await runp('osascript', ['-e', script]);
    assert.fail('不该成功');
  } catch (e) {
    assert.ok(!/syntax error/i.test(e.message), `AppleScript 存在语法错误：${e.message}`);
  }
});

test('Linux 方案首选 pkexec，并给出 sudo 兜底', () => {
  const plan = planElevation({
    platform: 'linux',
    exe: '/opt/jms/engine',
    args: ['--dir', '/home/u/.jms'],
  });
  assert.equal(plan.cmd, 'pkexec');
  assert.deepEqual(plan.args, ['/opt/jms/engine', '--dir', '/home/u/.jms']);
  assert.match(plan.fallback, /^sudo /);
  // 每个参数都被单独引用，路径里的空格不会拆断参数
  assert.match(plan.fallback, /'\/home\/u\/\.jms'/);
});

test('提权方案缺可执行文件路径要报错，而不是生成一条跑不通的命令', () => {
  assert.throws(() => planElevation({ platform: 'win32' }), /需要可执行文件路径/);
});

// ─────────────────────────── Windows wintun 依赖 ───────────────────────────
test('非 Windows 平台不做 wintun 检查', () => {
  assert.deepEqual(checkCoreDependencies({ platform: 'linux', corePath: '/x/sing-box' }), {
    ok: true, missing: [],
  });
  assert.deepEqual(checkCoreDependencies({ platform: 'darwin', corePath: '/x/sing-box' }), {
    ok: true, missing: [],
  });
});

test('Windows 缺 wintun.dll 时报出具体期望路径（这个错误对用户才有指向性）', () => {
  const r = checkCoreDependencies({ platform: 'win32', corePath: 'C:\\app\\resources\\core\\sing-box.exe' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['wintun.dll']);
  assert.equal(r.expectAt, 'C:\\app\\resources\\core\\wintun.dll');
  assert.match(r.hint, /wintun\.dll/);
});

test('Windows 没有内核路径时不误报缺 dll', () => {
  assert.equal(checkCoreDependencies({ platform: 'win32', corePath: null }).ok, true);
});

// ─────────────────────────── 准入检查汇总 ───────────────────────────
test('系统代理模式：准入检查直接放行，不触发任何提权判断', async () => {
  const r = await checkTunPrivilege({ mode: 'sysproxy', platform: 'win32', probe: async () => false });
  assert.equal(r.ok, true);
  assert.equal(r.needsElevation, false);
});

test('TUN 模式 + 已是管理员：放行', async () => {
  const r = await checkTunPrivilege({ mode: 'tun-per-app', platform: 'win32', probe: async () => true });
  assert.equal(r.ok, true);
  assert.equal(r.elevated, true);
  assert.equal(r.role, '管理员');
});

test('TUN 模式 + 未提权：拒绝，并带上可操作提示与提权方案', async () => {
  const r = await checkTunPrivilege({
    mode: 'tun-per-app',
    platform: 'win32',
    probe: async () => false,
    exe: 'C:\\app\\jms.exe',
    args: ['--elevated'],
  });
  assert.equal(r.ok, false);
  assert.equal(r.elevated, false);
  assert.equal(r.canGrant, true);
  // 提示必须包含「为什么」和「怎么办」，不能只说权限不足
  assert.match(r.hint, /管理员/);
  assert.match(r.hint, /UAC/);
  assert.equal(r.elevation.cmd, 'powershell');
  assert.match(r.elevation.command, /RunAs/);
});

test('TUN 模式 + 未提权 + 未提供自身路径：仍拒绝，但 canGrant 为 false', async () => {
  const r = await checkTunPrivilege({
    mode: 'tun-per-app', platform: 'darwin', uid: 501,
  });
  assert.equal(r.ok, false);
  assert.equal(r.canGrant, false);
  assert.equal(r.elevation, null);
  assert.match(r.hint, /root/);
});

test('macOS 未提权时提示 root，而不是笼统的「权限不足」', async () => {
  const r = await checkTunPrivilege({ mode: 'tun-per-app', platform: 'darwin', uid: 0 });
  assert.equal(r.ok, true, 'root 应当放行');
  const bad = await checkTunPrivilege({ mode: 'tun-per-app', platform: 'darwin', uid: 501 });
  assert.match(bad.hint, /root/);
  assert.match(bad.hint, /utun/);
});

test('Linux 未提权时提示 root 或 CAP_NET_ADMIN 两条路', async () => {
  const r = await checkTunPrivilege({ mode: 'tun-per-app', platform: 'linux', uid: 1000, corePath: '/nonexistent' });
  assert.equal(r.ok, false);
  assert.match(r.hint, /root|CAP_NET_ADMIN/);
});

test('Linux：内核带 cap_net_admin 时无需 root（走能力路线放行）', {
  skip: (process.platform !== 'linux' || process.env.JMS_TEST_LINUX_CAPABILITIES !== '1') && '真实文件 capability 验证需 Linux 且显式 JMS_TEST_LINUX_CAPABILITIES=1',
}, async (t) => {
  // 真实探测依赖 getcap 与真实文件；用一个临时文件造出「有 capability」的情形
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const runp = promisify(execFile);
  const { copyFileSync, chmodSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'jms-cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'fake-core');
  copyFileSync('/bin/true', bin);
  chmodSync(bin, 0o755);
  try {
    await runp('setcap', ['cap_net_admin,cap_net_raw+ep', bin]);
  } catch {
    t.skip('本环境没有 setcap，跳过能力路线验证');
    return;
  }
  const r = await checkTunPrivilege({
    mode: 'tun-per-app', platform: 'linux', uid: 1000, corePath: bin,
  });
  assert.equal(r.ok, true, '带 cap_net_admin 的内核应当直接放行');
  assert.equal(r.viaCapabilities, true);
});

test('macOS 可复制命令经 shell 后保留参数，路径中的命令替换不会执行', async t => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const dir = mkdtempSync(join(tmpdir(), 'jms-quote-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'unexpected');
  const plan = planElevation({ platform: 'darwin', exe: `/tmp/a ' $(touch ${marker})`, args: ['--dir', 'folder `echo nope` $HOME'] });
  const fake = join(dir, 'osascript');
  writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$2"\n'); chmodSync(fake, 0o700);
  const { stdout } = await promisify(execFile)('/bin/sh', ['-c', plan.command], { env: { ...process.env, PATH: dir } });
  assert.equal(stdout.trimEnd(), plan.args[1]);
  assert.equal(existsSync(marker), false);
});

test('TUN 专用权限检查不修改当前接管方式，也拒绝未知模式', async t => {
  const { AppService } = await import('../engine/app.mjs');
  const { MockAdapter } = await import('../engine/sysproxy/adapters.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'jms-tun-plan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = new AppService({ dir, adapter: new MockAdapter({ mode: 'off' }) });
  const mode = app.store.state.settings.mode;
  const result = await app.elevationPlan({ mode: 'tun-per-app' });
  assert.equal(result.mode, 'tun-per-app'); assert.equal(result.needsElevation, true);
  assert.equal(app.store.state.settings.mode, mode); assert.equal(app.supervisor, null);
  await assert.rejects(() => app.elevationPlan({ mode: 'unknown' }), /无效/);
});

test('提权参数：SEA 去除重复可执行文件，开发态保留脚本与所有选项', async () => {
  const { relaunchArguments } = await import('../engine/privilege.mjs');
  assert.deepEqual(relaunchArguments(['/app/engine','/app/engine','--dir','/user/data'], '/app/engine'), ['--dir','/user/data']);
  assert.deepEqual(relaunchArguments(['/app/engine','--dir','/user/data'], '/app/engine'), ['--dir','/user/data']);
  assert.deepEqual(relaunchArguments(['/usr/bin/node','/app/server.mjs','--dir','/user/data'], '/usr/bin/node'), ['/app/server.mjs','--dir','/user/data']);
});
