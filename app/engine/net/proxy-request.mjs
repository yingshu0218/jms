// 经代理的连通性探测（零依赖）
//
// 为什么不用 fetch：Node 的 fetch 不支持 HTTP 代理，而这里**必须走代理**才有意义。
// 为什么不用 curl：Windows/macOS/Linux 虽然大多自带，但不能假设它一定在，而且要 spawn 进程。
// 所以自己实现最小可用的 HTTP 代理客户端：明文直发 + HTTPS 走 CONNECT 隧道。
//
// 语义约定：**拿到状态码就算"可达"**。403/404 也说明链路是通的 ——
// 判定"能不能上网"不该被目标站的 HTTP 语义干扰。

import { request as httpRequest } from 'node:http';
import { connect as tlsConnect } from 'node:tls';

const UA = 'jms-client-linkcheck/1.0';

/** 单次探测：返回 { ok, status, latencyMs } 或 { ok:false, error, latencyMs } */
export async function probe(urlStr, { proxy = null, timeoutMs = 8000 } = {}) {
  const t0 = Date.now();
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`不支持的协议: ${url.protocol}`);
    }
    const status = url.protocol === 'https:'
      ? await viaTls(url, proxy, timeoutMs)
      : await viaHttp(url, proxy, timeoutMs);
    return { ok: true, status, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: describeError(e), latencyMs: Date.now() - t0 };
  }
}

function describeError(e) {
  const m = String(e?.message || e);
  if (/timeout|timed out|ETIMEDOUT/i.test(m)) return '超时';
  if (/ECONNREFUSED/i.test(m)) return '连接被拒绝';
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return 'DNS 解析失败';
  if (/CONNECT 失败/.test(m)) return m; // 代理自己拒绝了隧道
  if (/ECONNRESET|socket hang up/i.test(m)) return '连接被重置（可能被阻断）';
  if (/certificate|self signed|unable to verify/i.test(m)) return 'TLS 证书错误';
  return m.slice(0, 60);
}

/** http:// —— 直接把完整 URL 作为请求目标发给代理；不走代理则直连 */
function viaHttp(url, proxy, timeoutMs) {
  return new Promise((resolve, reject) => {
    const options = proxy
      ? {
          host: proxy.host,
          port: proxy.port,
          method: 'GET',
          path: url.href,
          headers: { Host: url.host, 'User-Agent': UA, 'Proxy-Connection': 'close', Connection: 'close' },
        }
      : {
          host: url.hostname,
          port: Number(url.port) || 80,
          method: 'GET',
          path: `${url.pathname}${url.search}`,
          headers: { Host: url.host, 'User-Agent': UA, Connection: 'close' },
        };

    const req = httpRequest(options, (res) => {
      clearTimeout(timer);
      resolve(res.statusCode);
      res.destroy(); // 只要状态码，不下载响应体
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.once('error', error => { clearTimeout(timer); reject(error); });
    req.end();
  });
}

/**
 * https:// —— 先与代理建立 CONNECT 隧道，再在隧道上做 TLS 握手，最后发一个极小的 GET。
 *
 * 注意 rejectUnauthorized: false 是刻意的：本探测要回答的是"能不能连上"，
 * 而不是"证书是否可信"。某些出口会做 TLS 中间盒，开启校验会产生假失败。
 */
function viaTls(url, proxy, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const port = Number(url.port) || 443;

  return new Promise((resolve, reject) => {
    const resources = new Set();
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const resource of resources) resource.destroy();
      callback(value);
    };
    const fail = (error) => finish(reject, error);
    const success = (status) => finish(resolve, status);
    const timer = setTimeout(() => fail(new Error('timeout')), timeoutMs);

    const startTls = (socket) => {
      const tls = tlsConnect({ socket, servername: url.hostname, rejectUnauthorized: false });
      resources.add(tls);
      tls.once('error', fail);
      tls.once('secureConnect', () => sendOverTls(tls, url, success, fail, deadline));
    };

    if (!proxy) {
      const socket = tlsConnect({ host: url.hostname, port, servername: url.hostname, rejectUnauthorized: false });
      resources.add(socket);
      socket.once('error', fail);
      socket.once('secureConnect', () => sendOverTls(socket, url, success, fail, deadline));
      return;
    }

    const req = httpRequest({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${url.hostname}:${port}`,
      headers: { Host: `${url.hostname}:${port}`, 'Proxy-Connection': 'keep-alive' },
    });
    resources.add(req);
    req.once('error', fail);
    req.once('connect', (res, socket) => {
      resources.add(socket);
      if (res.statusCode !== 200) {
        socket.destroy();
        return fail(new Error(`代理 CONNECT 失败 HTTP ${res.statusCode}`));
      }
      startTls(socket);
    });
    req.end();
  });
}

/** 隧道建立后发一个极小请求，只解析状态行 */
function sendOverTls(socket, url, resolve, reject, deadline) {
  let buf = '';

  const done = (fn, arg) => {
    socket.removeListener('data', onData);
    socket.removeListener('error', onErr);
    socket.setTimeout(0);
    socket.destroy();
    fn(arg);
  };

  const onData = (chunk) => {
    buf += chunk.toString('latin1');
    const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(buf);
    if (m) done(resolve, Number(m[1]));
  };
  const onErr = (e) => done(reject, e);

  socket.on('data', onData);
  socket.once('error', onErr);
  socket.setTimeout(Math.max(800, deadline - Date.now()), () => done(reject, new Error('timeout')));
  socket.write(
    `GET ${url.pathname}${url.search || '/'} HTTP/1.1\r\n` +
      `Host: ${url.host}\r\n` +
      `User-Agent: ${UA}\r\n` +
      `Accept: */*\r\n` +
      `Connection: close\r\n\r\n`,
  );
}
