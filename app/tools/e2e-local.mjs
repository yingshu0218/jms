#!/usr/bin/env node
// 本地端到端自证（不需要真实订阅）
//
// 思路：在本地搭一条**完整的真实链路**，让应用跑一遍它自己的全部流程：
//
//   ① 生成本地 VLESS + Reality 服务端（用 sing-box 自己的 vless inbound + reality）
//      —— 这正是 Just My Socks 使用的协议，所以它测的是真实协议路径，不是模拟
//   ② 用本地 HTTP 服务器发布一份「订阅」（内容指向 ①）
//   ③ 让应用去拉取订阅 → 解析 → 生成配置 → 启动真实内核 → 设置系统代理
//   ④ 通过应用的本地代理端口真的请求一个网站，验证**流量确实穿过了 Reality**
//   ⑤ 验证测速、selector 切换（不重启内核）、系统代理还原
//
// 这样连「pbk/sid/sni/flow 是否被正确映射」都被真实验证了 —— 这是模拟测试做不到的。
//
//   SING_BOX=/path/to/sing-box node tools/e2e-local.mjs

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

import { AppService } from '../engine/app.mjs';
import { MockAdapter } from '../engine/sysproxy/adapters.mjs';
import { ClashApi } from '../engine/clash-api.mjs';
import { SELECTOR_TAG } from '../core/to-singbox.mjs';
import { DEFAULT_TARGETS } from '../engine/linkcheck.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const CORE = process.env.SING_BOX || process.env.SING_BOX_PATH || '';
if (!CORE || !existsSync(CORE)) {
  console.error('请用 SING_BOX=/path/to/sing-box 指定内核二进制');
  process.exit(2);
}

// ── 小工具 ────────────────────────────────────────────────────────────────
const ok = (s) => console.log(`\x1b[32mPASS\x1b[0m  ${s}`);
const bad = (s) => console.log(`\x1b[31mFAIL\x1b[0m  ${s}`);
const info = (s) => console.log(`\x1b[36m----\x1b[0m  ${s}`);
let failures = 0;
function assert(cond, label, detail = '') {
  if (cond) ok(label);
  else {
    failures++;
    bad(`${label}${detail ? ' → ' + detail : ''}`);
  }
  return cond;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort(base) {
  // 用进程号错开，避免与上一次运行残留的端口冲突
  return base + (process.pid % 500);
}

async function waitPort(port, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = await new Promise((res) => {
      const s = createConnection({ host: '127.0.0.1', port });
      s.once('connect', () => (s.destroy(), res(true)));
      s.once('error', () => res(false));
      setTimeout(() => (s.destroy(), res(false)), 300);
    });
    if (alive) return true;
    await sleep(120);
  }
  return false;
}

function curlThroughProxy(proxyPort, url, { timeoutMs = 15000 } = {}) {
  try {
    const out = execFileSync(
      'curl',
      ['-x', `http://127.0.0.1:${proxyPort}`, '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', String(timeoutMs / 1000), url],
      { encoding: 'utf8', timeout: timeoutMs + 3000 },
    );
    return { code: out.trim() };
  } catch (e) {
    return { code: null, error: (e.stderr || e.message || '').trim().slice(0, 160) };
  }
}

const children = [];
function track(child, name) {
  children.push({ child, name });
  return child;
}
function cleanupChildren() {
  for (const { child } of children) {
    try {
      if (child.pid && child.exitCode === null) child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'jms-e2e-'));
const UUID = 'e2e00000-1111-2222-3333-444444444444';
const SS_METHOD = 'aes-256-gcm';

const PORT_REALITY = freePort(18443); // 本地 Reality 服务端（模拟 JMS 的节点）
const PORT_SS = freePort(18388); // 本地 Shadowsocks 服务端（第二个节点，用于验证切换）
const PORT_SUB = freePort(18080); // 本地订阅服务器
const SS_PASSWORD = 'e2e-local-password';

process.on('exit', cleanupChildren);
process.on('SIGINT', () => {
  cleanupChildren();
  process.exit(130);
});

try {
  console.log(`\n\x1b[1m本地端到端自证\x1b[0m  (工作目录 ${work})\n`);

  // ── ① 生成本地 Reality 服务端 ──────────────────────────────────────────
  info('生成 Reality 密钥对（用内核自己的生成器，保证结构合法）');
  const kp = execFileSync(CORE, ['generate', 'reality-keypair'], { encoding: 'utf8' });
  const privateKey = /PrivateKey:\s*(\S+)/.exec(kp)?.[1];
  const publicKey = /PublicKey:\s*(\S+)/.exec(kp)?.[1];
  const shortId = '0123456789abcdef';
  assert(Boolean(privateKey && publicKey), '密钥对生成成功', `${privateKey?.length}/${publicKey?.length} 字符`);

  const HANDSHAKE_HOST = 'www.microsoft.com';

  const upstreamCfg = {
    log: { level: 'warn' },
    inbounds: [
      {
        type: 'vless',
        tag: 'reality-in',
        listen: '127.0.0.1',
        listen_port: PORT_REALITY,
        users: [{ uuid: UUID, flow: 'xtls-rprx-vision' }],
        tls: {
          enabled: true,
          server_name: HANDSHAKE_HOST,
          reality: {
            enabled: true,
            handshake: { server: HANDSHAKE_HOST, server_port: 443 },
            private_key: privateKey,
            short_id: [shortId],
          },
        },
      },
      {
        // 第二个节点：普通 Shadowsocks，用来验证「切换节点」真的换了出口
        type: 'shadowsocks',
        tag: 'ss-in',
        listen: '127.0.0.1',
        listen_port: PORT_SS,
        method: SS_METHOD,
        password: SS_PASSWORD,
      },
    ],
    outbounds: [{ type: 'direct', tag: 'direct' }],
  };
  const upstreamFile = join(work, 'upstream.json');
  writeFileSync(upstreamFile, JSON.stringify(upstreamCfg, null, 2));

  info('启动本地上游服务端（VLESS+Reality + Shadowsocks）');
  const upstream = track(spawn(CORE, ['run', '-c', upstreamFile], { stdio: ['ignore', 'pipe', 'pipe'] }), 'upstream');
  let upstreamLog = '';
  upstream.stdout.on('data', (d) => (upstreamLog += d));
  upstream.stderr.on('data', (d) => (upstreamLog += d));

  const realityUp = await waitPort(PORT_REALITY);
  const ssUp = await waitPort(PORT_SS);
  assert(realityUp, `Reality 服务端已监听 :${PORT_REALITY}`);
  assert(ssUp, `Shadowsocks 服务端已监听 :${PORT_SS}`);
  if (!realityUp || !ssUp) {
    console.log(upstreamLog.slice(-800));
    throw new Error('上游服务端未能启动');
  }

  // ── ② 发布一份本地「订阅」 ─────────────────────────────────────────────
  // 内容格式与真实机场订阅一致：base64 包裹的多行分享链接
  const realityLink =
    `vless://${UUID}@127.0.0.1:${PORT_REALITY}` +
    `?encryption=none&security=reality&sni=${HANDSHAKE_HOST}&fp=chrome` +
    `&pbk=${encodeURIComponent(publicKey)}&sid=${shortId}` +
    `&type=tcp&flow=xtls-rprx-vision#Local-Reality`;
  const ssLink =
    `ss://${Buffer.from(`${SS_METHOD}:${SS_PASSWORD}`, 'utf8').toString('base64')}` +
    `@127.0.0.1:${PORT_SS}#Local-Shadowsocks`;
  const subBody = Buffer.from([realityLink, ssLink].join('\n'), 'utf8').toString('base64');

  const subServer = createServer((req, res) => {
    if (req.url.startsWith('/sub')) {
      res.writeHead(200, { 'Content-Type': 'text/plain', ETag: '"e2e-v1"' });
      res.end(subBody);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => subServer.listen(PORT_SUB, '127.0.0.1', r));
  const SUB_URL = `http://127.0.0.1:${PORT_SUB}/sub`;
  ok(`本地订阅已发布 → ${SUB_URL}`);

  // ── ③ 让应用跑完整流程 ─────────────────────────────────────────────────
  const APP_PROXY_PORT = freePort(17800);
  const APP_API_PORT = freePort(18800);

  const adapter = new MockAdapter({ mode: 'on', host: 'corp.proxy', port: 3128, bypass: '*.internal' });
  const app = new AppService({ dir: join(work, 'state'), coreBinary: CORE, adapter });
  app.apiClient = () => new ClashApi(`http://127.0.0.1:${APP_API_PORT}`);
  const warnings = [];
  app.on('warn', (m) => warnings.push(m));

  await app.boot();
  await app.updateSettings({ port: APP_PROXY_PORT, clashApi: `127.0.0.1:${APP_API_PORT}`, mode: 'sysproxy' });

  info('① 拉取订阅');
  const sub = await app.refreshSubscription({ url: SUB_URL });
  assert(sub.nodes === 2, '订阅解析出 2 个节点', `实际 ${sub.nodes}`);
  const names = app.store.state.subscription.nodes.map((n) => n.name);
  assert(names.includes('Local-Reality') && names.includes('Local-Shadowsocks'), '节点名正确解析', names.join(', '));

  info('② 连接（生成配置 → 启动真实内核 → 设置系统代理）');
  const meta = await app.connect();
  assert(meta.pid > 0, `内核已启动 (pid ${meta.pid})`);
  assert(meta.node === 'Local-Reality', '默认选中 Reality 节点', meta.node);
  const st = await app.status();
  assert(st.connected === true, '状态为已连接');
  assert(st.pointingAtUs === true, '系统代理已指向本机端口');

  info('③ 验证流量真的穿过 Reality —— 这是核心结论');
  // 直连基线
  const base = curlThroughProxy(0, 'http://example.com'); // 不存在的代理端口，仅取直连失败信息
  const direct = execFileSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '12', 'http://example.com'], {
    encoding: 'utf8',
  }).trim();

  const viaReality = curlThroughProxy(APP_PROXY_PORT, 'http://example.com');
  assert(viaReality.code === '200', `通过代理端口请求成功（HTTP ${viaReality.code}）`, viaReality.error || '');
  assert(direct === '200', '直连基线同样可达（证明沙箱网络本身正常）');

  // 再用 HTTPS 验一次，覆盖 TLS-in-TLS / Reality 的真实场景
  const https = curlThroughProxy(APP_PROXY_PORT, 'https://example.com');
  assert(https.code === '200', `HTTPS 经 Reality 请求成功（HTTP ${https.code}）`, https.error || '');

  info('④ 验证测速返回真实数值');
  const lat = await app.measureLatency({ all: true });
  const rLat = lat[app.nodeTags()[0]];
  assert(rLat?.ok === true && typeof rLat.delay === 'number', `Reality 节点测速返回真实延迟 ${rLat?.delay}ms`, JSON.stringify(rLat));

  info('⑤ 验证切换节点：即时生效且不重启内核');
  const pidBefore = app.supervisor.status().pid;
  const sel = await app.selectNode(1);
  assert(sel.applied === true, '切换已即时生效', sel.reason || '');
  assert(app.supervisor.status().pid === pidBefore, '切换节点没有重启内核', `${pidBefore} → ${app.supervisor.status().pid}`);
  assert((await app.apiClient().currentSelection(SELECTOR_TAG)) === sel.tag, 'selector 已指向新节点');

  const viaSS = curlThroughProxy(APP_PROXY_PORT, 'http://example.com');
  assert(viaSS.code === '200', `切到 Shadowsocks 出口后依然通（HTTP ${viaSS.code}）`, viaSS.error || '');

  info('⑥ 验证断开：还原用户原有代理');
  await app.disconnect();
  assert(adapter.state.mode === 'on' && adapter.state.host === 'corp.proxy' && adapter.state.port === 3128, '精确还原到用户原有的公司代理');
  assert(app.journal.isPending() === false, '自愈日志已清除');
  const st2 = await app.status();
  assert(st2.running === false, '内核已停止');
  assert(st2.connected === false, '状态已复位');

  const afterDisconnect = curlThroughProxy(APP_PROXY_PORT, 'http://example.com');
  assert(afterDisconnect.code === null, '断开后该端口不再提供服务（符合预期）');

  info('⑦ 验证崩溃自愈：模拟上次异常退出');
  // 手动制造「已改代理 + 残留日志」的现场，再让应用启动
  const adapter2 = new MockAdapter({ mode: 'on', host: 'corp.proxy', port: 3128 });
  const app2 = new AppService({ dir: join(work, 'state'), coreBinary: CORE, adapter: adapter2 });
  app2.store.markRuntime({ connected: true, pid: 99999 });
  await app2.store.write({});
  // 写入残留日志（等价于上次崩溃前留下的状态）
  const { ProxyJournal } = await import('../engine/sysproxy/index.mjs');
  const j = new ProxyJournal(app2.dir);
  j.begin({ platform: 'linux', previous: { mode: 'on', host: 'corp.proxy', port: 3128 }, target: { mode: 'on', host: '127.0.0.1', port: APP_PROXY_PORT } });
  adapter2.state = { mode: 'on', host: '127.0.0.1', port: APP_PROXY_PORT, bypass: null };

  const healed = await app2.boot();
  assert(healed.healed === true, '检测到残留并自愈');
  assert(adapter2.state.host === 'corp.proxy' && adapter2.state.port === 3128, '自愈后回到用户原有代理');
  assert(app2.store.state.runtime.connected === false, '不会自动重连（避免用户不知情就走代理）');

  info('⑧ 验证第二次连接仍然可用（内核可重复启停）');
  // 切回 Reality 节点再连一次
  await app.updateSettings({ selected: 0, clashApi: `127.0.0.1:${APP_API_PORT}` });
  const meta2 = await app.connect();
  assert(meta2.pid > 0, `第二次连接成功 (pid ${meta2.pid})`);
  const again = curlThroughProxy(APP_PROXY_PORT, 'http://example.com');
  assert(again.code === '200', `第二次连接后流量依然通（HTTP ${again.code}）`, again.error || '');

  info('⑨ 常用链接检测（经代理端口，并做直连对照）');
  // 加一个确定性目标（本地订阅服务），这样"探测经代理可用"是可断言的
  const lk = await app.checkLinks({
    targets: [{ id: 'local', label: '本地目标', url: SUB_URL, group: 'local' }, ...DEFAULT_TARGETS],
    timeoutMs: 8000,
  });
  assert(lk.via === 'proxy', '检测是经代理端口进行的（不是直连）', lk.via);
  const localRes = lk.results.find((r) => r.id === 'local');
  assert(localRes?.ok === true, '确定性目标可达 —— 证明探测链路正确', localRes?.error || '');
  assert(lk.summary.total === DEFAULT_TARGETS.length + 1, '结果条数与目标数一致', String(lk.summary.total));
  console.log('    外部站点实测（真实网络）：');
  for (const r of lk.results.filter((x) => x.id !== 'local')) {
    const detail = r.ok
      ? `可达  HTTP ${r.status}  ${r.latencyMs}ms`
      : `不可达  ${r.error}${r.diagnosis ? '  | ' + r.diagnosis : ''}`;
    console.log(`      ${r.label.padEnd(10)} ${detail}`);
  }
  console.log(`    结论：${lk.summary.verdict}`);

  await app.disconnect();

  if (warnings.length) {
    console.log('\n\x1b[33m过程中的警告（属预期或已提示）：\x1b[0m');
    for (const w of [...new Set(warnings)]) console.log('  · ' + w);
  }

  // ── 收尾 ────────────────────────────────────────────────────────────────
  subServer.close();
  cleanupChildren();
  await sleep(200);

  console.log('');
  if (failures === 0) {
    console.log('\x1b[32m\x1b[1m全部通过：流量确实穿过 VLESS+Reality，应用的完整生命周期可用。\x1b[0m');
    console.log('（本测试在本地搭了真实服务端，因此验证了 pbk/sid/sni/flow 的映射与真正可用性）');
  } else {
    console.log(`\x1b[31m\x1b[1m有 ${failures} 项未通过。\x1b[0m`);
    process.exit(1);
  }
} catch (e) {
  failures++;
  console.error(`\n\x1b[31m运行中断：${e.stack || e.message}\x1b[0m`);
  cleanupChildren();
  process.exit(1);
}
