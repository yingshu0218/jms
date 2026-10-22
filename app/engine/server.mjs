// HTTP 传输层 + 静态 UI
//
// 只监听回环地址：控制 API 能启停代理、改系统设置，绝不能暴露到局域网。
// （沙箱/远程预览时用 --host 0.0.0.0 显式打开，并自行承担风险。）

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';

import { AppService } from './app.mjs';
import { acquireLock } from './lock.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const UI_FILE = join(here, '..', 'ui', 'index.html');

// 打包成桌面应用后前端由 Tauri 自己的协议提供，与引擎不同源，必须显式放行。
// 只放行桌面壳这两个来源；服务本身也只监听回环地址，不是把 API 开给公网。
const ALLOWED_ORIGINS = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function body(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

export function createAppServer({ app, host = '127.0.0.1', port = 7788, uiFile = UI_FILE } = {}) {
  const clients = new Set();

  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) {
      try {
        c.write(payload);
      } catch {
        clients.delete(c);
      }
    }
  };

  for (const evt of ['connected', 'disconnected', 'warn', 'healed', 'restarted', 'gaveup', 'subscription']) {
    app.on(evt, (data) => broadcast(evt, data ?? null));
  }
  app.on('core-log', (line) => broadcast('core-log', line));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    // 跨源放行（打包后前端在 tauri:// 或 http://tauri.localhost 上）
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    try {
      // ── 静态 UI ──
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        if (!existsSync(uiFile)) return json(res, 500, { error: 'UI 文件缺失' });
        const html = readFileSync(uiFile);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': html.length,
        });
        return res.end(html);
      }

      // ── 事件流 ──
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        clients.add(res);
        const timer = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            /* ignore */
          }
        }, 25_000);
        timer.unref?.();
        req.on('close', () => {
          clearInterval(timer);
          clients.delete(res);
        });
        return;
      }

      if (req.method === 'GET' && path === '/api/profiles') {
        const s = app.store.redacted();
        return json(res, 200, { profiles: s.profiles, activeProfileId: s.activeProfileId });
      }
      // ── 只读 ──
      if (req.method === 'GET' && path === '/api/connections') {
        return json(res, 200, await app.connections());
      }
      if (req.method === 'GET' && path === '/api/rules') {
        return json(res, 200, app.exportRules());
      }
      if (req.method === 'GET' && path === '/api/state') {
        return json(res, 200, await app.snapshot());
      }
      if (req.method === 'GET' && path === '/api/logs') {
        const lines = Number(url.searchParams.get('lines') || 200);
        return json(res, 200, { lines: app.tailLogs({ lines }), files: app.logFiles() });
      }

      // ── 写操作 ──
      if (req.method !== 'POST') return json(res, 405, { error: '方法不允许' });
      const payload = await body(req);

      switch (path) {
        case '/api/connections/close': return json(res, 200, await app.closeConnections(payload));
        case '/api/profiles': return json(res, 200, await app.profiles.save(payload));
        case '/api/profiles/refresh-all': return json(res, 200, await app.profiles.refreshAll());
        case '/api/profiles/refresh': return json(res, 200, await app.profiles.refresh(payload.id, { force: Boolean(payload.force) }));
        case '/api/profiles/activate': return json(res, 200, await app.profiles.activate(payload.id));
        case '/api/profiles/delete': return json(res, 200, await app.profiles.remove(payload.id));
        case '/api/node': {
          return json(res, 200, await app.selectNode(payload.index));
        }
        case '/api/rules/import': {
          return json(res, 200, await app.importRules(payload));
        }
        case '/api/subscription': {
          const out = await app.refreshSubscription({ url: payload.url, force: true });
          return json(res, 200, out);
        }
        case '/api/refresh': {
          const out = await app.refreshSubscription({ force: Boolean(payload.force) });
          return json(res, 200, out);
        }
        case '/api/connect': {
          const out = await app.connect();
          return json(res, 200, { ok: true, ...out });
        }
        case '/api/disconnect': {
          const out = await app.disconnect();
          return json(res, 200, { ok: true, ...(out || {}) });
        }
        case '/api/latency': {
          const out = await app.measureLatency({ index: payload.index, all: Boolean(payload.all) });
          return json(res, 200, { ok: true, latency: out });
        }
        case '/api/linkcheck': {
          const out = await app.checkLinks({
            timeoutMs: payload.timeoutMs || 8000,
            diagnose: payload.diagnose !== false,
          });
          return json(res, 200, out);
        }
        case '/api/elevate': {
          return json(res, 200, await app.elevationPlan({ mode: payload.mode }));
        }
        case '/api/routing-mode': {
          const out = await app.setRoutingMode(payload.mode);
          return json(res, 200, out);
        }
        case '/api/settings': {
          const out = await app.updateSettings(payload.settings || {});
          return json(res, 200, { ok: true, settings: out });
        }
        default:
          return json(res, 404, { error: `未知接口: ${path}` });
      }
    } catch (e) {
      return json(res, 400, {
        error: e.message,
        // 结构化错误码要一路透到前端：前端凭 code 决定下一步（比如弹提权引导），
        // 而不是去匹配错误文案 —— 文案会改，code 不会。
        ...(e.code ? { code: e.code } : {}),
        ...(e.privilege ? { privilege: e.privilege } : {}),
      });
    }
  });

  server.listen(port, host);
  server.on('close', () => {
    for (const c of clients) {
      try {
        c.end();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
  });
  return server;
}

// ── CLI 入口 ────────────────────────────────────────────────────────────
const isMain = !isSea() && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  // 包成 async IIFE 而不是用顶层 await：esbuild 打 CJS 单文件时不接受顶层 await，
  // 而 Node SEA 只吃 CJS。包一层之后 CLI 行为完全不变（同一个进程、同一套信号处理）。
  (async () => {
  const argOf = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
  };
  const host = argOf('host', '127.0.0.1');
  const port = Number(argOf('port', '7788'));

  const app = new AppService({ dir: argOf('dir', undefined), coreBinary: argOf('core', undefined) });

  // 单实例：两个实例会互相覆盖系统代理，且抢同一端口 —— 必须拒绝第二个
  const lock = acquireLock(`${app.dir}/app.lock`);
  if (!lock.ok) {
    console.error(`已有实例在运行（PID ${lock.pid}）。请先关闭它，或直接使用那个窗口。`);
    process.exit(1);
  }
  if (lock.stalePid) console.log(`[锁] 接管了上次异常退出留下的锁（原 PID ${lock.stalePid}）`);

  const healed = await app.boot();
  // 订阅参数会轮换，后台按时刷新，避免"昨天能用今天连不上"
  app.startAutoRefresh();
  if (healed.healed) console.log(`[自愈] 已还原上次异常退出留下的系统代理设置 → ${JSON.stringify(healed.restoredTo)}`);

  app.on('warn', (m) => console.log(`[警告] ${m}`));
  app.on('connected', (m) => console.log(`[已连接] 节点=${m.node} pid=${m.pid}`));
  app.on('disconnected', () => console.log('[已断开]'));
  app.on('healed', (h) => console.log(`[自愈] ${JSON.stringify(h)}`));

  createAppServer({ app, host, port });
  console.log(`jms-client 引擎已启动 → http://${host}:${port}`);
  console.log(`内核: ${app.coreBinary || '未找到（设置 SING_BOX 环境变量）'}`);
  console.log(`模式: ${app.store.state.settings.mode}  端口: ${app.store.state.settings.port}`);

  const shutdown = async (sig) => {
    console.log(`\n收到 ${sig}，正在清理…`);
    try {
      if (app.store.state.runtime.connected) await app.disconnect();
      else if (app.journal.isPending()) await app.boot();
    } catch (e) {
      console.error('清理失败：', e.message);
    }
    lock.release();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  })().catch((e) => {
    console.error(`引擎启动失败：${e?.stack || e}`);
    process.exit(1);
  });
}
