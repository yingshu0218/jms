// 本地规则集管理
//
// 为什么必须自己做这件事：**远程规则集会让内核启动依赖网络**。
// 实测（sing-box 1.14.3）：配置里用 `type: "remote"` 的 rule-set 时，内核在 router 初始化阶段
// 就会去下载 .srs；下载失败直接 `FATAL start service: start router` 退出。
// 后果非常严重：内核死了、系统代理还指着它的死端口 —— 用户表现为"整机断网"。
//
// 做法：启动前把规则集下载到本地并缓存，配置里引用**本地文件**；
// 下载失败也不阻断连接，退回到内置的少量兜底规则（宁可分流失准，也不能连不上网）。

import { mkdirSync, existsSync, statSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import bundledGeoIP from './bundled-geoip.json' with { type: 'json' };

export const RULE_SET_SOURCES = {
  // 路由用：按 IP 判定国内 → 直连
  'geoip-cn': 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs',
  // ★ DNS 用：按域名判定国内 → 用本地解析器（保证就近 CDN，避免"直连却连到远端节点"）
  'geosite-cn': 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs',
};

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
    if (!existsSync(p)) return false;
    if (maxAgeMs > 0 && Date.now() - statSync(p).mtimeMs > maxAgeMs) return false;
    return statSync(p).size > 1024;
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
} = {}) {
  if (hasRuleSet(dir, name, { maxAgeMs })) return ruleSetPath(dir, name);
  if (name === 'geoip-cn' && !hasRuleSet(dir, name, { maxAgeMs: 0 })) {
    const bytes = Buffer.from(bundledGeoIP.data, 'base64');
    if (createHash('sha256').update(bytes).digest('hex') === bundledGeoIP.sha256) {
      mkdirSync(ruleSetDir(dir), { recursive: true, mode: 0o700 });
      writeFileSync(ruleSetPath(dir, name), bytes, { mode: 0o600 });
      return ruleSetPath(dir, name);
    }
  }
  const url = RULE_SET_SOURCES[name];
  if (!url) return null;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('规则集下载超时')), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // .srs 是二进制格式，过小的响应体一定是错误页而不是规则集
    if (buf.length < 1024) throw new Error(`响应体过小（${buf.length} 字节），可能不是规则集`);
    mkdirSync(ruleSetDir(dir), { recursive: true, mode: 0o700 });
    const tmp = `${ruleSetPath(dir, name)}.tmp`;
    writeFileSync(tmp, buf, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* Windows 上 chmod 语义不同 */
    }
    renameSync(tmp, ruleSetPath(dir, name));
    return ruleSetPath(dir, name);
  } catch {
    return hasRuleSet(dir, name, { maxAgeMs: 0 }) ? ruleSetPath(dir, name) : null;
  } finally {
    clearTimeout(t);
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
