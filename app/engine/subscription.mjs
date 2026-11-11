// 订阅管理：拉取 / 条件请求 / 变更检测
//
// 为什么需要「变更检测」：服务端节点参数会轮换（换 IP、换端口、换协议）。
// 用户遇到的表现是「昨天还能用，今天突然连不上」。
// 把轮换识别出来并主动提示，是这类客户端最实用的一个功能。

import { nodeFingerprint, nodeKey } from './store.mjs';

const UA = 'jms-client/0.2 (sing-box)';

/**
 * 拉取订阅。支持 ETag 条件请求（304 时不重复解析）。
 * 注意：超时用 AbortController 实现，不要依赖 fetch 的 socket 默认行为。
 */
export const MAX_SUBSCRIPTION_BYTES = 5 * 1024 * 1024;
const failure = (message, code) => Object.assign(new Error(message), {code});
export async function fetchSubscription(url, { etag, timeoutMs = 20000, fetchImpl = fetch, ua = UA, maxBytes = MAX_SUBSCRIPTION_BYTES, maxRedirects = 5 } = {}) {
  const ac = new AbortController();
  let reader;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = failure('订阅拉取超时', 'SUBSCRIPTION_TIMEOUT');
      reject(error);
      ac.abort(error);
      reader?.cancel().catch(() => {});
    }, timeoutMs);
  });
  const bounded = promise => Promise.race([promise, deadline]);
  try {
    let target;
    try { target = new URL(url); } catch { throw failure('Invalid subscription URL','SUBSCRIPTION_URL'); }
    const headers = { 'User-Agent': ua, Accept: '*/*' };
    if (etag) headers['If-None-Match'] = etag;
    for (let redirects = 0; ; redirects++) {
      if (!['https:','http:'].includes(target.protocol) || target.username || target.password) throw failure('Invalid subscription URL','SUBSCRIPTION_URL');
      const res = await bounded(fetchImpl(target.href, { headers, redirect: 'manual', signal: ac.signal }));
      if ([301,302,303,307,308].includes(res.status)) {
        res.body?.cancel().catch(() => {});
        if (redirects >= maxRedirects) throw failure('Subscription redirect limit exceeded','SUBSCRIPTION_REDIRECT');
        let next;
        try { const location = res.headers.get('location'); if (!location) throw new Error(); next = new URL(location,target); } catch { throw failure('Invalid subscription redirect','SUBSCRIPTION_REDIRECT'); }
        if (target.protocol === 'https:' && next.protocol !== 'https:') throw failure('Subscription HTTPS downgrade rejected','SUBSCRIPTION_REDIRECT');
        if (target.origin !== next.origin) delete headers['If-None-Match'];
        target = next;
        continue;
      }
      if (res.status === 304) {
        if (!headers['If-None-Match']) throw failure('Unexpected subscription cache response', 'SUBSCRIPTION_HTTP');
        return { notModified: true, etag };
      }
      if (!res.ok) { res.body?.cancel().catch(() => {}); throw failure(`HTTP ${res.status}`,'SUBSCRIPTION_HTTP'); }
      if (Number(res.headers.get('content-length')) > maxBytes) { res.body?.cancel().catch(() => {}); throw failure('Subscription byte limit exceeded','SUBSCRIPTION_SIZE'); }
      let body;
      if (res.body?.getReader) {
        reader = res.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
          const { value, done } = await bounded(reader.read());
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw failure('Subscription byte limit exceeded','SUBSCRIPTION_SIZE');
          chunks.push(Buffer.from(value));
        }
        try { body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
        catch { throw failure('Subscription text encoding is invalid', 'SUBSCRIPTION_ENCODING'); }
      } else {
        // Compatibility for injected test transports; real fetch always streams.
        body = await bounded(res.text());
        if (Buffer.byteLength(body) > maxBytes) throw failure('Subscription byte limit exceeded','SUBSCRIPTION_SIZE');
      }
      return { body, etag: res.headers.get('etag') || null };
    }
  } catch (error) {
    ac.abort();
    if (typeof error.code === 'string' && error.code.startsWith('SUBSCRIPTION_')) throw error;
    throw failure('订阅拉取失败', 'SUBSCRIPTION_FETCH');
  } finally {
    clearTimeout(timer);
    if (reader) { reader.cancel().catch(() => {}); }
  }
}

/**
 * 节点集合变更检测。
 * - added / removed：节点增删
 * - changed：**同名节点但连接参数变了** —— 这就是"参数轮换"，最需要提醒用户
 */
export function diffNodes(prev = [], next = []) {
  const pool = new Map();
  for (const n of prev) pool.set(n.name, n);

  const added = [];
  const changed = [];
  for (const n of next) {
    const old = pool.get(n.name);
    if (!old) {
      added.push(n.name);
    } else if (nodeFingerprint(old) !== nodeFingerprint(n)) {
      changed.push({
        name: n.name,
        from: `${old.server}:${old.server_port}`,
        to: `${n.server}:${n.server_port}`,
      });
    }
    pool.delete(n.name);
  }
  return { added, removed: [...pool.keys()], changed };
}

export function summarizeChange(c) {
  if (!c) return null;
  const parts = [];
  if (c.changed.length) parts.push(`${c.changed.length} 个节点参数已轮换`);
  if (c.added.length) parts.push(`新增 ${c.added.length}`);
  if (c.removed.length) parts.push(`移除 ${c.removed.length}`);
  return parts.length ? parts.join(' · ') : null;
}

/** 节点唯一性：去重后再交给配置生成，避免同名重复导致选择错乱 */
export function dedupeNodes(nodes) {
  const seen = new Map();
  for (const n of nodes) {
    const k = nodeKey(n);
    if (!seen.has(k)) seen.set(k, n);
  }
  return [...seen.values()];
}
