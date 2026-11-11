// HTTP 传输层 + 静态 UI
//
// 只监听回环地址：控制 API 能启停代理、改系统设置，绝不能暴露到局域网。
// 不提供对外网卡监听选项；原生/CLI均需本实例随机秘密。

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';

import { checkApiToken, requestAuthorized, requestSourceAllowed, API_PROTOCOL_VERSION } from './control-auth.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const UI_FILE = join(here, '..', 'ui', 'index.html');

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

export function createAppServer({ app, host = '127.0.0.1', port = 7788, uiFile = UI_FILE, authToken, instanceId } = {}) {
  checkApiToken(authToken);
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('引擎仅允许监听回环地址');
  if (typeof instanceId !== 'string' || !instanceId || instanceId.length > 128) throw new Error('引擎实例标识缺失');
  const clients = new Set();
  const activeOperations = new Set();
  let drainingRequest;
  const drain = () => {
    if (drainingRequest) return drainingRequest;
    app.draining = true;
    clearInterval(app.refreshTimer);
    drainingRequest = (async () => {
      try { await Promise.allSettled([...activeOperations]); return await app.shutdown(); }
      finally { drainingRequest = null; }
    })();
    return drainingRequest;
  };

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

  for (const evt of ['connected', 'disconnected', 'warn', 'healed', 'restarted', 'gaveup', 'subscription', 'operation-progress', 'routing-mode', 'selected']) {
    app.on(evt, (data) => broadcast(evt, data ?? null));
  }
  app.on('core-log', (line) => broadcast('core-log', line));

  const handle = async (req, res) => {
    try {
      if (!requestSourceAllowed(req, server.address())) return json(res, 403, { error: '请求来源无效' });
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname;
      // 所有控制数据（也包括只读状态、日志和 SSE）必须验证本次实例秘密。
      if (path.startsWith('/api/') && !requestAuthorized(req, authToken)) return json(res, 401, { error: '需要本实例认证', code: 'UNAUTHORIZED' });
      if (req.method === 'OPTIONS') return json(res, 405, { error: '不允许跨源控制' });
      if (app.ready === false) return json(res, 503, { error: '引擎正在启动', code: 'STARTING' });
      if (req.method === 'GET' && path === '/api/identity') {
        return json(res, 200, { name: 'jms-engine', protocolVersion: API_PROTOCOL_VERSION, instanceId, isolated: app.isolated });
      }

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
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: '需要 application/json' });
      const payload = await body(req);
      if (path === '/api/shutdown') {
        return json(res, 200, await drain());
      }
      if (path === '/api/resume') {
        if (drainingRequest) throw new Error('引擎仍在等待已开始的操作完成');
        return json(res, 200, app.resume());
      }
      if (path !== '/api/disconnect') app.assertMutable();

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
          const out = await app.updateSettings(payload.settings === undefined ? {} : payload.settings);
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
  };
  const server = createServer((req, res) => {
    const work = handle(req, res);
    // 不把 shutdown 自己放进等待集合，否则会等待自身。URI 无法绕过内部的精确路由。
    let path;
    try { path = new URL(req.url, 'http://127.0.0.1').pathname; } catch {}
    const mutation = req.method === 'POST' && !['/api/shutdown', '/api/resume'].includes(path);
    if (mutation) activeOperations.add(work);
    work.catch(() => { if (!res.headersSent) json(res, 400, { error: '请求无效' }); else res.destroy(); })
      .finally(() => activeOperations.delete(work));
  });
  server.drain = drain;
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
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
  import('./entry.mjs').then(({ runEngine }) => runEngine()).catch(error => {
    console.error(`引擎启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
