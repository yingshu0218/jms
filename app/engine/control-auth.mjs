// API 的随机秘密只通过请求头传递，不进入 URL、状态或日志。
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const API_PROTOCOL_VERSION = 1;
export const newApiToken = () => randomBytes(32).toString('hex');
export function checkApiToken(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('API 认证信息缺失或无效');
  return token;
}

export function requestAuthorized(req, token) {
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function requestSourceAllowed(req, address) {
  const port = address.port;
  // 不依赖攻击者提供的 Host 构造 URL，防止 DNS rebinding 与畸形 Host。
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!hosts.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  // Origin 缺失是原生客户端/CLI；浏览器只接受当前引擎自身的精确 origin。
  return origin === undefined || new Set([...hosts].map(host => `http://${host}`)).has(origin);
}
