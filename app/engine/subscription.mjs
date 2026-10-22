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
export async function fetchSubscription(url, { etag, timeoutMs = 20000, fetchImpl = fetch, ua = UA } = {}) {
  if (!url) throw new Error('订阅链接为空');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('订阅拉取超时')), timeoutMs);
  try {
    const headers = { 'User-Agent': ua, Accept: '*/*' };
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetchImpl(url, { headers, redirect: 'follow', signal: ac.signal });
    if (res.status === 304) return { notModified: true, etag };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { body: await res.text(), etag: res.headers.get('etag') || null };
  } finally {
    clearTimeout(timer);
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
