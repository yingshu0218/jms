// 设置是控制边界，不把任意 HTTP 字段或旧状态中的路径片段交给文件系统/内核。
// 纯校验可同时用于更新和连接前检查，不产生副作用。
import { isIP } from 'node:net';
import { APP_PROFILES } from './per-app.mjs';
import { ROUTING_MODES } from './to-singbox.mjs';
import { rulesDocument } from './custom-rules.mjs';

const KEYS = new Set(['selected', 'mode', 'port', 'clashApi', 'autoRefreshMinutes', 'routingMode',
  'localDns', 'remoteDns', 'directRules', 'customRules', 'apps', 'reverseApps']);
export const CONFIG_FILENAMES = Object.freeze({ sysproxy: 'config-sysproxy.json', 'tun-per-app': 'config-tun-per-app.json' });

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}必须是 ${min}–${max} 的整数`);
}

export function validateSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置必须是对象');
  const next = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!KEYS.has(key)) throw new Error('设置包含不支持的字段');
    next[key] = value;
  }
  if (Object.hasOwn(next, 'mode') && (typeof next.mode !== 'string' || !Object.hasOwn(CONFIG_FILENAMES, next.mode))) throw new Error('无效的接管方式');
  if (Object.hasOwn(next, 'routingMode') && !ROUTING_MODES.includes(next.routingMode)) throw new Error('无效的路由模式');
  if (Object.hasOwn(next, 'selected')) integer(next.selected, 0, Number.MAX_SAFE_INTEGER, '节点索引');
  if (Object.hasOwn(next, 'port')) integer(next.port, 1, 65535, '代理端口');
  if (Object.hasOwn(next, 'autoRefreshMinutes')) integer(next.autoRefreshMinutes, 0, 10080, '自动刷新间隔');
  for (const key of ['reverseApps', 'directRules']) {
    if (Object.hasOwn(next, key) && typeof next[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
  }
  if (Object.hasOwn(next, 'apps') && (!Array.isArray(next.apps) || next.apps.some(key => typeof key !== 'string' || !Object.hasOwn(APP_PROFILES, key)))) {
    throw new Error('应用名单包含不支持的应用');
  }
  if (Object.hasOwn(next, 'customRules')) rulesDocument(next.customRules);
  if (Object.hasOwn(next, 'clashApi')) {
    // 这也是内核监听地址：只许 IPv4 回环字面量，拒绝 URL/路径/用户信息及远端监听。
    const match = typeof next.clashApi === 'string' && /^127\.0\.0\.1:([0-9]{1,5})$/.exec(next.clashApi);
    if (!match) throw new Error('内核 API 必须使用 127.0.0.1:端口');
    integer(Number(match[1]), 1, 65535, '内核 API 端口');
  }
  if (Object.hasOwn(next, 'localDns')) {
    if (typeof next.localDns !== 'string' || (next.localDns !== 'system' && !isIP(next.localDns)) || next.localDns.length > 253) throw new Error('本地 DNS 需要 system 或服务器 IP');
  }
  if (Object.hasOwn(next, 'remoteDns')) {
    if (typeof next.remoteDns !== 'string' || !next.remoteDns || next.remoteDns.length > 2048) throw new Error('远端 DNS 需要有效的 HTTPS 地址');
    let url;
    try { url = new URL(next.remoteDns.includes('://') ? next.remoteDns : `https://${next.remoteDns}/dns-query`); }
    catch { throw new Error('远端 DNS 需要有效的 HTTPS 地址'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname) throw new Error('远端 DNS 需要有效的 HTTPS 地址');
  }
  return next;
}
