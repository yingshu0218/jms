// 本地规则集管理
//
// 为什么必须自己做这件事：**远程规则集会让内核启动依赖网络**。
// 实测（sing-box 1.14.3）：配置里用 `type: "remote"` 的 rule-set 时，内核在 router 初始化阶段
// 就会去下载 .srs；下载失败直接 `FATAL start service: start router` 退出。
// 后果非常严重：内核死了、系统代理还指着它的死端口 —— 用户表现为"整机断网"。
//
// 做法：启动前把规则集下载到本地并缓存，配置里引用**本地文件**；
// 下载失败也不阻断连接，退回到内置的少量兜底规则（宁可分流失准，也不能连不上网）。

import { mkdirSync, existsSync, statSync, writeFileSync, renameSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
import bundledGeoIP from './bundled-geoip.json' with { type: 'json' };

export const RULE_SET_SOURCES = {
  // 路由用：按 IP 判定国内 → 直连
  'geoip-cn': 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs',
  // ★ DNS 用：按域名判定国内 → 用本地解析器（保证就近 CDN，避免"直连却连到远端节点"）
  'geosite-cn': 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs',
};

const MAX_RULE_SET_BYTES = 16 * 1024 * 1024;
const WEEK = 7 * 24 * 3600 * 1000;

export function ruleSetDir(dir) {
  return join(dir, 'rulesets');
}

export function ruleSetPath(dir, name = 'geoip-cn') {
  return join(ruleSetDir(dir), `${name}.srs`);
}

export function hasRuleSet(dir, name = 'geoip-cn', { maxAgeMs = WEEK } = {}) {
  const p = ruleSetPath(dir, name);
  try {
    if (!existsSync(p) || statSync(p).size > MAX_RULE_SET_BYTES) return false;
    if (maxAgeMs > 0 && Date.now() - statSync(p).mtimeMs > maxAgeMs) return false;
    return validRuleSetBytes(readFileSync(p));
  } catch {
    return false;
  }
}

/**
 * 确保规则集可用。返回本地路径；下载失败返回 null（调用方应退回内置兜底规则）。
 * 绝不抛错 —— 规则集只是优化，不能因为它让客户端连不上。
 */
export async function ensureRuleSet({
  dir,
  name = 'geoip-cn',
  fetchImpl = fetch,
  timeoutMs = 15000,
  maxAgeMs = WEEK,
  coreBinary,
  validateFile,
} = {}) {
  const ac = new AbortController();
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
  const deadline = performance.now() + duration;
  const timeoutError = new Error('规则集处理超时');
  let rejectDeadline;
  const expired = new Promise((_, reject) => { rejectDeadline = reject; });
  // Keep a rejection handler even when synchronous work consumes the budget.
  expired.catch(() => {});
  const timer = setTimeout(() => { ac.abort(timeoutError); rejectDeadline(timeoutError); }, duration);
  const checkDeadline = () => {
    if (ac.signal.aborted || performance.now() >= deadline) {
      ac.abort(timeoutError);
      throw timeoutError;
    }
  };
  const bounded = async operation => {
    checkDeadline();
    const result = await Promise.race([Promise.resolve().then(operation), expired]);
    checkDeadline();
    return result;
  };
  const verify = validateFile || (coreBinary ? async file => {
    const output = `${file}.${randomUUID()}.json`;
    try {
      await run(coreBinary, ['rule-set', 'decompile', '--output', output, file], {
        signal: ac.signal, timeout: Math.max(1, Math.ceil(deadline - performance.now())), maxBuffer: 64 * 1024,
      });
    } finally { rmSync(output, { force: true }); }
  } : null);
  let confirmedCache = false;
  const cached = async age => {
    checkDeadline();
    if (!hasRuleSet(dir, name, { maxAgeMs: age })) return false;
    if (confirmedCache) return true;
    try {
      if (verify) await bounded(() => verify(ruleSetPath(dir, name), { signal: ac.signal }));
      checkDeadline();
      confirmedCache = true;
      return true;
    } catch { return false; }
  };
  const tmp = `${ruleSetPath(dir, name)}.${randomUUID()}.tmp`;
  let reader;
  let cancelled = false;
  const cancelReader = () => {
    if (!reader || cancelled) return;
    cancelled = true;
    // A hostile reader.cancel() may never resolve. It must not delay cleanup.
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* best effort */ }
  };
  ac.signal.addEventListener('abort', cancelReader, { once: true });
  try {
    if (await cached(maxAgeMs)) return ruleSetPath(dir, name);
    checkDeadline();
    if (name === 'geoip-cn' && !hasRuleSet(dir, name, { maxAgeMs: 0 })) {
      const bytes = Buffer.from(bundledGeoIP.data, 'base64');
      if (createHash('sha256').update(bytes).digest('hex') === bundledGeoIP.sha256) {
        checkDeadline();
        mkdirSync(ruleSetDir(dir), { recursive: true, mode: 0o700 });
        writeFileSync(ruleSetPath(dir, name), bytes, { mode: 0o600 });
        return ruleSetPath(dir, name);
      }
    }
    const url = RULE_SET_SOURCES[name];
    if (!url) return null;
    const res = await bounded(async () => {
      const response = await fetchImpl(url, { signal: ac.signal, redirect: 'follow' });
      if (ac.signal.aborted) {
        try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch { /* best effort */ }
        throw timeoutError;
      }
      return response;
    });
    if (!res.ok) {
      try { Promise.resolve(res.body?.cancel()).catch(() => {}); } catch { /* best effort */ }
      throw new Error('规则集下载失败');
    }
    if (!res.body?.getReader) throw new Error('规则集缺少可读取的数据流');
    reader = res.body.getReader();
    const length = res.headers?.get('content-length');
    if (length !== null && length !== undefined &&
        (!/^\d+$/.test(length) || Number(length) > MAX_RULE_SET_BYTES)) {
      throw new Error('规则集下载超出大小限制');
    }
    let total = 0;
    // One bounded allocation avoids per-chunk overhead attacks (tiny/empty chunks).
    const storage = Buffer.allocUnsafe(MAX_RULE_SET_BYTES);
    for (;;) {
      const { done, value } = await bounded(() => reader.read());
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > MAX_RULE_SET_BYTES - total)
        throw new Error('规则集下载超出大小限制');
      // Fetch streams decoded bytes; never trust compressed Content-Length.
      storage.set(value, total);
      total += value.byteLength;
    }
    const buf = storage.subarray(0, total);
    if (!validRuleSetBytes(buf)) throw new Error('不是有效的二进制规则集');
    checkDeadline();
    if (!verify) throw new Error('缺少内核规则集校验器，保留已有缓存');
    mkdirSync(ruleSetDir(dir), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, buf, { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* Windows chmod semantics */ }
    await bounded(() => verify(tmp, { signal: ac.signal }));
    checkDeadline();
    renameSync(tmp, ruleSetPath(dir, name));
    return ruleSetPath(dir, name);
  } catch {
    cancelReader();
    if (confirmedCache) return ruleSetPath(dir, name);
    // Do not restart a budget or re-enter a hung validator during fallback.
    try { return await cached(0) ? ruleSetPath(dir, name) : null; } catch { return null; }
  } finally {
    clearTimeout(timer);
    cancelReader();
    try { reader?.releaseLock(); } catch { /* pending read after timeout */ }
    ac.signal.removeEventListener('abort', cancelReader);
    rmSync(tmp, { force: true });
  }
}

/** 批量准备，返回 { 'geoip-cn': path|null } */
export async function ensureRuleSets(opts = {}) {
  const out = {};
  for (const name of Object.keys(RULE_SET_SOURCES)) {
    out[name] = await ensureRuleSet({ ...opts, name });
  }
  return out;
}

// 格式头依据固定 v1.14.3 common/srs/binary.go；只做前置筛查，不冒充完整解析。
export function validRuleSetBytes(bytes) {
  try {
    return bytes.length >= 8 && bytes.length <= MAX_RULE_SET_BYTES &&
      bytes.subarray(0, 3).toString('ascii') === 'SRS' && bytes[3] >= 1 && bytes[3] <= 5 &&
      inflateSync(bytes.subarray(4), { maxOutputLength: 64 * 1024 * 1024 }).length > 0;
  } catch { return false; }
}
