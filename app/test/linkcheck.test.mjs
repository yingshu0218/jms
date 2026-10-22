import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probe } from '../engine/net/proxy-request.mjs';
import { checkTargets, summarize, runLinkCheck, DEFAULT_TARGETS } from '../engine/linkcheck.mjs';
import { CoreSupervisor, resolveCoreBinary } from '../engine/supervisor.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'jms-lk-'));
const CORE = process.env.SING_BOX || resolveCoreBinary();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个本地 HTTP 服务，用于确定性验证探测实现 */
async function withLocalServer(fn) {
  const server = createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(204).end();
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ══════════════════════ 结论判定（纯函数） ══════════════════════

test('判定：全部可达 → ok', () => {
  const s = summarize([
    { id: 'a', label: 'Google', group: 'blocked', ok: true, latencyMs: 40 },
    { id: 'c', label: 'Cloudflare', group: 'control', ok: true, latencyMs: 30 },
  ]);
  assert.equal(s.level, 'ok');
  assert.equal(s.ok, 2);
  assert.match(s.verdict, /全部可达/);
});

test('★ 判定：对照组也不通 → 判为隧道问题（这是最有价值的一条结论）', () => {
  const s = summarize([
    { id: 'a', label: 'Google', group: 'blocked', ok: false, error: '超时' },
    { id: 'c', label: 'Cloudflare', group: 'control', ok: false, error: '超时' },
  ]);
  assert.equal(s.level, 'bad');
  assert.equal(s.controlOk, false);
  assert.match(s.verdict, /隧道/);
});

test('判定：对照组通、目标站全不通 → 指向出口 IP 被识别', () => {
  const s = summarize([
    { id: 'a', label: 'Google', group: 'blocked', ok: false, error: '超时' },
    { id: 'b', label: 'YouTube', group: 'blocked', ok: false, error: '超时' },
    { id: 'c', label: 'Cloudflare', group: 'control', ok: true, latencyMs: 30 },
  ]);
  assert.equal(s.level, 'warn');
  assert.deepEqual(s.failedLabels, ['Google', 'YouTube']);
  assert.match(s.verdict, /出口 IP/);
});

test('判定：空目标列表不应崩', () => {
  const s = summarize([]);
  assert.equal(s.total, 0);
  assert.equal(s.avgLatencyMs, null);
});

// ══════════════════════ 探测实现（真跑） ══════════════════════

test('探测：直连本地 HTTP 服务拿到状态码', async () => {
  await withLocalServer(async (port) => {
    const r = await probe(`http://127.0.0.1:${port}/ok`);
    assert.equal(r.ok, true);
    assert.equal(r.status, 204);
    assert.ok(typeof r.latencyMs === 'number' && r.latencyMs >= 0);
  });
});

test('探测：404 也算可达 —— 判定的是"能不能连上"，不是 HTTP 语义', async () => {
  await withLocalServer(async (port) => {
    const r = await probe(`http://127.0.0.1:${port}/nope`);
    assert.equal(r.ok, true);
    assert.equal(r.status, 404);
  });
});

test('探测：端口没人监听 → 报"连接被拒绝"而不是静默成功', async () => {
  const r = await probe('http://127.0.0.1:1/');
  assert.equal(r.ok, false);
  assert.equal(r.error, '连接被拒绝');
});

test('探测：连不上的代理端口 → 同样如实报错', async () => {
  const r = await probe('http://example.com/', { proxy: { host: '127.0.0.1', port: 1 } });
  assert.equal(r.ok, false);
  assert.ok(['连接被拒绝', '超时'].includes(r.error), r.error);
});

test('探测：不支持的协议要报错', async () => {
  const r = await probe('ftp://example.com/');
  assert.equal(r.ok, false);
  assert.match(r.error, /不支持的协议/);
});

test(
  '★ 探测：经真实内核的代理端口访问本地服务（验证 HTTP 代理实现正确）',
  { skip: !CORE && '未找到 sing-box' },
  async () => {
    const dir = tmp();
    const proxyPort = 13550;
    const apiPort = 19550;
    writeFileSync(
      join(dir, 'c.json'),
      JSON.stringify({
        log: { level: 'warn' },
        experimental: { clash_api: { external_controller: `127.0.0.1:${apiPort}` } },
        inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: proxyPort }],
        outbounds: [{ type: 'direct', tag: 'direct' }],
        route: { final: 'direct' },
      }),
    );
    const sup = new CoreSupervisor({
      binaryPath: CORE,
      configPath: join(dir, 'c.json'),
      logFile: join(dir, 'core.log'),
      readyCheck: async () => {
        const r = await probe(`http://127.0.0.1:${proxyPort}/`, { timeoutMs: 1000 });
        // 只要代理端口有响应（哪怕是错误）就算起来了
        if (!r.ok && r.error === '连接被拒绝') throw new Error('not ready');
        return true;
      },
    });

    try {
      await sup.start();
      await withLocalServer(async (port) => {
        const viaProxy = await probe(`http://127.0.0.1:${port}/ok`, {
          proxy: { host: '127.0.0.1', port: proxyPort },
        });
        assert.equal(viaProxy.ok, true, `经代理探测应成功，实际：${viaProxy.error || ''}`);
        assert.equal(viaProxy.status, 204);

        // 代理端口写错时不能误报成功
        const bad = await probe(`http://127.0.0.1:${port}/ok`, { proxy: { host: '127.0.0.1', port: proxyPort + 1 } });
        assert.equal(bad.ok, false);
      });
    } finally {
      await sup.stop();
      sup.closeLog();
    }
  },
);

// ══════════════════════ 并发与诊断 ══════════════════════

test('检测：并发执行且保持输入顺序', async () => {
  const order = [];
  const fakeProbe = async (url) => {
    order.push(url);
    await sleep(20);
    return { ok: true, status: 200, latencyMs: 20 };
  };
  const res = await checkTargets(DEFAULT_TARGETS, { probeImpl: fakeProbe, concurrency: 4 });
  assert.equal(res.length, DEFAULT_TARGETS.length);
  assert.deepEqual(res.map((r) => r.id), DEFAULT_TARGETS.map((t) => t.id), '输出应保持输入顺序');
  assert.ok(order.length === DEFAULT_TARGETS.length);
});

test('★ 诊断：代理失败但直连可达 → 指向隧道/出口问题', async () => {
  const fakeProbe = async (url, { proxy }) => {
    if (proxy) return { ok: false, error: '超时', latencyMs: 8000 };
    return { ok: true, status: 200, latencyMs: 30 };
  };
  const out = await runLinkCheck({
    proxy: { host: '127.0.0.1', port: 2080 },
    targets: [{ id: 'g', label: 'Google', url: 'https://www.google.com/', group: 'blocked' }],
    probeImpl: fakeProbe,
  });
  const r = out.results[0];
  assert.equal(r.ok, false);
  assert.equal(r.direct.ok, true);
  assert.match(r.diagnosis, /隧道或出口节点/);
});

test('诊断：代理和直连都失败 → 明确"与代理无关"', async () => {
  const fakeProbe = async () => ({ ok: false, error: '超时', latencyMs: 8000 });
  const out = await runLinkCheck({
    proxy: { host: '127.0.0.1', port: 2080 },
    targets: [{ id: 'x', label: 'X', url: 'https://x.com/', group: 'blocked' }],
    probeImpl: fakeProbe,
  });
  assert.match(out.results[0].diagnosis, /与代理无关/);
  assert.equal(out.summary.level, 'bad'); // 没有对照组 → 全失败判为 bad
});

test('诊断：只为失败项补直连对照，成功项不重复请求', async () => {
  const calls = [];
  const fakeProbe = async (url, { proxy }) => {
    calls.push({ url, viaProxy: Boolean(proxy) });
    if (url.includes('ok')) return { ok: true, status: 200, latencyMs: 10 };
    return { ok: false, error: '超时', latencyMs: 8000 };
  };
  await runLinkCheck({
    proxy: { host: '127.0.0.1', port: 2080 },
    targets: [
      { id: 'a', label: 'A', url: 'https://a/ok', group: 'blocked' },
      { id: 'b', label: 'B', url: 'https://b/fail', group: 'blocked' },
    ],
    probeImpl: fakeProbe,
  });
  assert.equal(calls.filter((c) => c.url.includes('ok')).length, 1, '成功项只探测一次');
  assert.equal(calls.filter((c) => c.url.includes('fail')).length, 2, '失败项应有代理 + 直连两次');
});

test('未连接时不补直连对照（diagnose=false 的路径）', async () => {
  const calls = [];
  const fakeProbe = async (url, { proxy }) => {
    calls.push(Boolean(proxy));
    return { ok: false, error: '超时', latencyMs: 8000 };
  };
  const out = await runLinkCheck({
    proxy: null,
    targets: [{ id: 'a', label: 'A', url: 'https://a/', group: 'blocked' }],
    probeImpl: fakeProbe,
  });
  assert.equal(out.results[0].via, 'direct');
  assert.equal(calls.length, 1, '直连模式下不应再做对照');
  assert.equal(out.results[0].diagnosis, undefined);
});

test('HTTPS 探测：TLS 握手卡住也必须在总超时内结束', async (t) => {
  const { createServer } = await import('node:net');
  const sockets = new Set();
  const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const result = await probe(`https://localhost:${server.address().port}/`, { timeoutMs: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.error, '超时');
  assert.ok(result.latencyMs < 2000, '握手阶段也必须执行超时');
});
