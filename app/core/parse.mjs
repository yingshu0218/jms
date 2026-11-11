import { validateNode } from './node-schema.mjs';
export const MAX_SUBSCRIPTION_NODES = 5000;
// 订阅解析层
// 输入：订阅响应体（字符串）→ 输出：统一节点对象数组
// 支持三种订阅形态：① base64 编码的分享链接列表 ② 明文分享链接列表 ③ Clash YAML（flow 风格 proxies）
// 设计原则：这一层是纯函数，不碰网络、不碰文件、不碰系统 API —— 所以能被 AI 快速写对，也最好测。

const SHARE_SCHEMES = ['vless', 'vmess', 'trojan', 'ss', 'ssr'];

function b64decode(s) {
  if (typeof s !== 'string') throw new Error('Invalid base64 content');
  const t = s.replace(/-/g, '+').replace(/_/g, '/').replace(/[\t\n\r ]+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t) || t.replace(/=+$/, '').length % 4 === 1 || (t.includes('=') && t.length % 4 !== 0)) throw new Error('Invalid base64 content');
  const bytes = Buffer.from(t, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== t.replace(/=+$/, '')) throw new Error('Invalid base64 content');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Invalid UTF-8 subscription content'); }
}

export function looksLikeShareList(text) {
  return SHARE_SCHEMES.some((s) => text.includes(`${s}://`));
}

export function looksLikeClashYaml(text) {
  return /^\s*proxies\s*:/m.test(text);
}

/** 判定订阅形态并解码，返回 { format, body } */
export function decodeSubscription(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('订阅内容为空');

  if (looksLikeClashYaml(text) && !looksLikeShareList(text)) {
    return { format: 'clash-yaml', body: text };
  }
  if (looksLikeShareList(text)) {
    return { format: 'links', body: text };
  }
  const decoded = b64decode(text);
  if (looksLikeShareList(decoded)) {
    return { format: 'base64-links', body: decoded };
  }
  throw new Error('无法识别的订阅格式（不是分享链接、不是可解码的 base64、也不是 Clash YAML）');
}

/** 把一条分享链接拆成 scheme / userinfo / server / port / name / params */
function splitLink(link) {
  const i = link.indexOf('://');
  if (i < 0) throw new Error(`不是合法的分享链接: ${link.slice(0, 24)}…`);
  const scheme = link.slice(0, i).toLowerCase();
  let rest = link.slice(i + 3);

  let name = '';
  const h = rest.indexOf('#');
  if (h >= 0) {
    name = safeDecode(rest.slice(h + 1));
    rest = rest.slice(0, h);
  }

  let query = '';
  const q = rest.indexOf('?');
  if (q >= 0) {
    query = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }

  const at = rest.lastIndexOf('@');
  let userinfo = '';
  let hostport = rest;
  if (at >= 0) {
    userinfo = rest.slice(0, at);
    hostport = rest.slice(at + 1);
  }

  if (scheme === 'ss') hostport = hostport.replace(/\/$/, '');
  let server = hostport;
  let port = '';
  if (hostport.startsWith('[')) {
    const e = hostport.indexOf(']');
    if (e < 0 || hostport[e + 1] !== ':') throw new Error('Invalid endpoint');
    server = hostport.slice(1, e);
    port = hostport.slice(e + 2);
  } else {
    const c = hostport.lastIndexOf(':');
    if (c >= 0) {
      server = hostport.slice(0, c);
      port = hostport.slice(c + 1);
    }
  }

  return { scheme, userinfo, server, port: scheme === 'ss' && !userinfo ? NaN : numericPort(port), name, params: new URLSearchParams(query) };
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 一条分享链接 → 节点对象 */
function parseShareLinkUnchecked(link) {
  const raw = String(link).trim();
  if (!raw) throw new Error('空的分享链接');
  if (raw.toLowerCase().startsWith('vmess://')) return parseVmess(raw);
  const p = splitLink(raw);
  switch (p.scheme) {
    case 'vless':
      return parseVless(p);
    case 'trojan':
      return parseTrojan(p);
    case 'ss':
      return parseSs(p, raw);
    default:
      throw new Error(`暂不支持的协议: ${p.scheme}（当前支持 vless / vmess / trojan / ss）`);
  }
}

export function parseShareLink(link) {
  try { return validateNode(parseShareLinkUnchecked(link)); }
  catch (error) { throw Object.assign(new Error(error.code === 'INVALID_NODE' ? error.message : error.message.startsWith('ss:// 缺少 method:password') ? 'ss:// 缺少 method:password' : 'Invalid or unsupported share link'), {code: 'INVALID_NODE'}); }
}

// ---- VLESS ---------------------------------------------------------------

function parseVless(p) {
  const q = p.params;
  const security = (q.get('security') || 'none').toLowerCase();
  const network = (q.get('type') || 'tcp').toLowerCase();

  if (!p.userinfo) throw new Error(`VLESS 节点缺少 uuid: ${p.name || p.server}`);
  if (!p.server || !p.port) throw new Error(`VLESS 节点缺少服务器或端口: ${p.name || p.userinfo}`);

  const node = {
    name: p.name || `${p.server}:${p.port}`,
    type: 'vless',
    server: p.server,
    server_port: p.port,
    uuid: p.userinfo,
    flow: q.get('flow') || '',
    network,
    security,
    tls: { enabled: security !== 'none' },
  };

  if (security === 'reality') {
    // ★ 最容易出错的一项：没有 pbk 就绝对连不上，这里直接报错而不是静默生成坏配置
    const pbk = q.get('pbk');
    if (!pbk) throw new Error(`Reality 节点缺少 pbk(公钥)，无法生成配置: ${node.name}`);
    node.tls.server_name = q.get('sni') || q.get('host') || '';
    node.tls.utls = { enabled: true, fingerprint: q.get('fp') || 'chrome' };
    node.tls.reality = {
      enabled: true,
      public_key: pbk,
      short_id: q.get('sid') || '', // 空字符串是合法值：表示服务端未配置 shortId
    };
    const spx = q.get('spx');
    if (spx) node.tls.reality.spider_x = safeDecode(spx);
  } else if (security === 'tls') {
    node.tls.server_name = q.get('sni') || q.get('host') || '';
    if (q.get('fp')) node.tls.utls = { enabled: true, fingerprint: q.get('fp') };
    if (q.get('alpn')) node.tls.alpn = q.get('alpn').split(',').map((s) => s.trim()).filter(Boolean);
    if (q.get('allowInsecure') === '1') node.tls.insecure = true;
  }

  if (network === 'ws') {
    node.ws = { path: q.get('path') || '/', host: q.get('host') || '' };
  } else if (network === 'grpc') {
    node.grpc = { service_name: q.get('serviceName') || '' };
  } else if (network !== 'tcp') {
    node.extra_network = network; // 例如 h2 / httpupgrade，M1 先记录、不生成
  }

  return node;
}

// ---- VMess ---------------------------------------------------------------

function parseVmess(link) {
  const payload = link.slice('vmess://'.length);
  let j;
  try {
    j = JSON.parse(b64decode(payload));
  } catch {
    throw new Error('vmess:// 内容不是合法的 base64 JSON');
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('Invalid VMess object');
  for (const key of ['alpn','sni','host','path','fp']) if (j[key] !== undefined && typeof j[key] !== 'string') throw new Error('Invalid VMess string field');
  if (j.ps !== undefined && typeof j.ps !== 'string') throw new Error('Invalid node name');
  if (!j.add || !j.port || !j.id) throw new Error(`VMess 节点缺少必要字段: ${j.ps || j.add || '(未命名)'}`);

  if (j.tls !== undefined && !['', 'none', 'tls'].includes(j.tls)) throw new Error('Invalid TLS');
  const net = typeof j.net === 'string' ? j.net.toLowerCase() : j.net === undefined ? 'tcp' : null;
  const node = {
    name: j.ps || `${j.add}:${j.port}`,
    type: 'vmess',
    server: j.add,
    server_port: numericPort(j.port),
    uuid: j.id,
    alter_id: numericPort(j.aid === undefined ? 0 : j.aid),
    cipher: j.scy === undefined ? 'auto' : j.scy,
    network: net,
    security: j.tls === 'tls' ? 'tls' : 'none',
    tls: { enabled: j.tls === 'tls' },
  };
  if (node.tls.enabled) {
    node.tls.server_name = j.sni || j.host || '';
    if (j.fp) node.tls.utls = { enabled: true, fingerprint: j.fp };
    if (j.alpn) node.tls.alpn = j.alpn.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (net === 'ws') node.ws = { path: j.path || '/', host: j.host || '' };
  if (net === 'grpc') node.grpc = { service_name: j.path || '' };
  return node;
}

// ---- Shadowsocks ---------------------------------------------------------

/**
 * 解出 ss:// 的 `method:password`。
 *
 * 这里踩过一个真实的坑：曾经用「base64 结果里是否含 '='」来判断该不该解码，
 * 但 **base64 常常没有 '=' 填充**（尤其 base64url 风格），于是明文被当成编码、解码被跳过，
 * 结果整条 ss 节点解析失败。真实机场订阅里这种形态很常见。
 *
 * 正确做法：逐个形态尝试，看**解码结果**是否长得像 `method:password`，而不是猜输入。
 */
function decodeSsUserinfo(userinfo) {
  const candidates = [safeDecode(userinfo)];
  try {
    candidates.push(b64decode(userinfo));
  } catch {
    /* 不是合法 base64，忽略 */
  }
  try {
    candidates.push(b64decode(safeDecode(userinfo))); // percent-encoded 的 base64
  } catch {
    /* ignore */
  }
  // 取第一个含冒号、且冒号两侧都非空的结果（密文口令里可能本身带冒号，所以用首个冒号切分）
  for (const c of candidates) {
    const i = c.indexOf(':');
    if (i > 0 && i < c.length - 1) return c;
  }
  return null;
}

function parseSs(p, raw) {
  if (p.params.has('plugin')) throw new Error('Unsupported plugin');
  // 形态 A: ss://BASE64(method:pass)@host:port#name
  // 形态 B: ss://BASE64(method:pass@host:port)#name
  let method = '';
  let password = '';
  let server = p.server;
  let port = p.port;
  let userinfo = p.userinfo;

  if (!userinfo) {
    const i = raw.indexOf('://') + 3;
    let rest = raw.slice(i);
    const h = rest.indexOf('#');
    if (h >= 0) rest = rest.slice(0, h);
    const decoded = b64decode(rest);
    const at = decoded.lastIndexOf('@');
    if (at < 0) throw new Error('ss:// 链接格式无法识别');
    userinfo = decoded.slice(0, at);
    const hp = decoded.slice(at + 1);
    const parsed = splitLink(`ss://unused@${hp}`);
    server = parsed.server;
    port = parsed.port;
  }

  const dec = decodeSsUserinfo(userinfo);
  if (dec === null) throw new Error('ss:// 缺少 method:password（无法识别 userinfo 编码形式）');
  const c = dec.indexOf(':');
  method = dec.slice(0, c);
  password = dec.slice(c + 1);

  return {
    name: p.name || `${server}:${port}`,
    type: 'shadowsocks',
    server,
    server_port: port,
    method,
    password,
  };
}

// ---- Trojan --------------------------------------------------------------

function parseTrojan(p) {
  if (!p.userinfo) throw new Error(`Trojan 节点缺少密码: ${p.name || p.server}`);
  const q = p.params;
  const network = (q.get('type') || 'tcp').toLowerCase();
  const node = {
    name: p.name || `${p.server}:${p.port}`,
    type: 'trojan',
    server: p.server,
    server_port: p.port,
    password: decodeURIComponent(p.userinfo),
    network,
    tls: { enabled: true, server_name: q.get('sni') || q.get('peer') || '' },
  };
  if (q.get('fp')) node.tls.utls = { enabled: true, fingerprint: q.get('fp') };
  if (q.get('allowInsecure') === '1') node.tls.insecure = true;
  if (network === 'ws') node.ws = { path: q.get('path') || '/', host: q.get('host') || '' };
  if (network === 'grpc') node.grpc = { service_name: q.get('serviceName') || '' };
  return node;
}

// ---- Clash YAML（仅 flow 风格） ------------------------------------------

// Clash flow 风格的解析必须处理**嵌套对象**，例如：
//   reality-opts: {public-key: "...", short-id: "..."}
// 纯正则做不到 —— 正则遇到 `{` 就断掉，结果是 Reality 公钥丢失、生成一份静默连不上的配置。
// 所以这里改用手写的花括号配对扫描。
function parseFlowMap(body) {
  // Deliberately small, strict flow-map subset. Unsupported YAML is not repaired.
  let i = 0;
  const invalid = () => { throw new Error('Invalid or unsupported YAML flow syntax'); };
  const space = () => { while (/\s/.test(body[i] ?? '') && i < body.length) i++; };
  function quoted() {
    const quote = body[i++];
    let value = '';
    while (i < body.length) {
      const ch = body[i++];
      if (ch === quote) {
        if (quote === "'" && body[i] === "'") { value += "'"; i++; continue; }
        return value;
      }
      if (ch === '\\' && quote === '"') {
        const escape = body[i++];
        const escapes = { '0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029' };
        if (Object.hasOwn(escapes, escape)) value += escapes[escape];
        else if (['x','u','U'].includes(escape)) {
          const size = {x:2,u:4,U:8}[escape];
          const hex = body.slice(i, i + size);
          if (hex.length !== size || !/^[a-f0-9]+$/i.test(hex)) invalid();
          const code = Number.parseInt(hex, 16);
          if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) invalid();
          value += String.fromCodePoint(code); i += size;
        } else invalid();
      } else { if (/[\x00-\x1f\x7f]/.test(ch)) invalid(); value += ch; }
    }
    invalid();
  }
  function value(depth) {
    space();
    if (body[i] === '{') return map(depth + 1);
    if (body[i] === '"' || body[i] === "'") return quoted();
    const start = i;
    while (i < body.length && body[i] !== ',' && body[i] !== '}') i++;
    const scalar = body.slice(start, i).trim();
    if (!scalar || /[\[\]{}'"#\x00-\x1f\x7f]/.test(scalar) || /^[&*!|>@%`]/.test(scalar) || /:\s/.test(scalar)) invalid();
    if (scalar === 'true') return true;
    if (scalar === 'false') return false;
    if (scalar === 'null' || scalar === '~') return null;
    if (/^-?\d+(?:\.\d+)?$/.test(scalar)) return Number(scalar);
    return scalar;
  }
  function map(depth) {
    if (depth > 16 || body[i++] !== '{') invalid();
    const out = Object.create(null);
    space();
    if (body[i] === '}') { i++; return out; }
    for (;;) {
      space();
      let key;
      if (body[i] === '"' || body[i] === "'") key = quoted();
      else {
        const match = /^[A-Za-z0-9_.-]+/.exec(body.slice(i));
        if (!match) invalid();
        key = match[0]; i += key.length;
      }
      space();
      if (body[i++] !== ':' || Object.hasOwn(out,key) || ['__proto__','prototype','constructor'].includes(key)) invalid();
      out[key] = value(depth);
      space();
      if (body[i] === '}') { i++; return out; }
      if (body[i++] !== ',') invalid();
      space();
      if (body[i] === '}') { i++; return out; }
    }
  }
  space();
  const result = map(0);
  space();
  if (i !== body.length) invalid();
  return result;
}

function numericPort(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) throw new Error('Invalid port');
  return Number(value);
}

function networkValue(value) { return value === undefined ? 'tcp' : value; }

function validateClashFields(o) {
  const has = (object, key) => Object.hasOwn(object, key);
  const invalid = () => { throw new Error('Invalid or unsupported YAML node fields'); };
  const map = object => { if (!object || typeof object !== 'object' || Array.isArray(object)) invalid(); };
  const strings = (object, keys) => { for (const key of keys) if (has(object, key) && typeof object[key] !== 'string') invalid(); };
  strings(o, ['type','name','server','uuid','password','cipher','network','flow','servername','sni','client-fingerprint']);
  if (typeof o.type !== 'string') invalid();
  for (const key of ['tls','skip-cert-verify']) if (has(o,key) && typeof o[key] !== 'boolean') invalid();
  for (const key of ['plugin','plugin-opts','h2-opts','http-opts','httpupgrade-opts','xhttp-opts']) if (has(o,key)) invalid();
  const network = networkValue(o.network);
  if (!['tcp','ws','grpc'].includes(network)) invalid();
  for (const [key, expected, fields] of [['ws-opts','ws',['path','headers']],['grpc-opts','grpc',['grpc-service-name']]]) {
    if (!has(o,key)) continue;
    if (network !== expected) invalid();
    const opts = o[key]; map(opts);
    if (Object.keys(opts).some(field => !fields.includes(field))) invalid();
    strings(opts, expected === 'ws' ? ['path'] : ['grpc-service-name']);
    if (has(opts,'headers')) {
      map(opts.headers);
      if (Object.keys(opts.headers).some(field => !['Host','host'].includes(field)) || (has(opts.headers,'Host') && has(opts.headers,'host'))) invalid();
      strings(opts.headers,['Host','host']);
    }
  }
  if (has(o,'reality-opts')) {
    const reality = o['reality-opts']; map(reality);
    if (o.type.toLowerCase() !== 'vless' || o.tls !== true || Object.keys(reality).some(key => !['public-key','short-id'].includes(key))) invalid();
    strings(reality,['public-key','short-id']);
    if (!has(reality,'public-key') || !reality['public-key']) invalid();
  }
}

function clashProxyToNode(o) {
  validateClashFields(o);
  const type = o.type.toLowerCase();
  const base = {
    name: o.name || `${o.server}:${o.port}`,
    server: o.server,
    server_port: numericPort(o.port),
  };
  switch (type) {
    case 'vless': {
      const node = {
        ...base,
        type: 'vless',
        uuid: o.uuid,
        flow: o.flow || '',
        network: networkValue(o.network),
        security: o.tls ? (o['reality-opts'] ? 'reality' : 'tls') : 'none',
        tls: { enabled: !!o.tls },
      };
      if (o.tls) {
        node.tls.server_name = o.servername || '';
        if (o['client-fingerprint']) node.tls.utls = { enabled: true, fingerprint: o['client-fingerprint'] };
      }
      if (o['reality-opts'] && o['reality-opts']['public-key']) {
        node.tls.reality = {
          enabled: true,
          public_key: o['reality-opts']['public-key'],
          short_id: o['reality-opts']['short-id'] || '',
        };
      }
      return node;
    }
    case 'vmess':
      return {
        ...base,
        type: 'vmess',
        uuid: o.uuid,
        alter_id: numericPort(o.alterId === undefined ? 0 : o.alterId),
        cipher: o.cipher === undefined ? 'auto' : o.cipher,
        network: networkValue(o.network),
        tls: { enabled: !!o.tls, server_name: o.servername || '' },
      };
    case 'ss':
      return { ...base, type: 'shadowsocks', method: o.cipher, password: o.password };
    case 'trojan':
      return { ...base, type: 'trojan', password: o.password, tls: { enabled: true, server_name: o.sni || '' } };
    default:
      throw new Error(`Clash 配置里暂不支持的节点类型: ${o.type}`);
  }
}

export function parseClashYaml(text, { skipped = [], maxNodes = MAX_SUBSCRIPTION_NODES } = {}) {
  const nodes = [];
  let count = 0;
  let inProxies = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw;
    if (/^proxies\s*:/.test(line)) {
      inProxies = true;
      continue;
    }
    if (inProxies && /^\S/.test(line)) {
      inProxies = false;
      continue;
    }
    if (!inProxies) continue;
    const t = line.trim();
    if (!t.startsWith('-')) continue;
    const body = t.slice(1).trim();
    if (++count > maxNodes) throw new Error('Subscription node limit exceeded');
    try {
      if (!body.startsWith('{')) throw new Error('Unsupported YAML style');
      const obj = parseFlowMap(body);
      const node = clashProxyToNode(obj);
      node.network = networkValue(obj.network);
      if (node.network === 'ws') {
        const opts = obj['ws-opts'] === undefined ? {} : obj['ws-opts'];
        node.ws = { path: opts.path ?? '/', host: opts.headers?.Host ?? opts.headers?.host ?? '' };
        if (Object.keys(opts).some(k => !['path','headers'].includes(k)) || (opts.headers && Object.keys(opts.headers).some(k => !['Host','host'].includes(k)))) throw new Error('Unsupported WS options');
      }
      if (node.network === 'grpc') {
        const opts = obj['grpc-opts'] === undefined ? {} : obj['grpc-opts'];
        node.grpc = { service_name: opts['grpc-service-name'] ?? '' };
        if (Object.keys(opts).some(k => k !== 'grpc-service-name')) throw new Error('Unsupported gRPC options');
      }
      if (obj['skip-cert-verify'] !== undefined) {
        if (typeof obj['skip-cert-verify'] !== 'boolean' || !node.tls) throw new Error('Invalid TLS option');
        node.tls.insecure = obj['skip-cert-verify'];
      }
      nodes.push(validateNode(node));
    } catch { skipped.push({ line: count, reason: 'Invalid or unsupported node' }); }
  }
  return nodes;
}

// ---- 统一入口 ------------------------------------------------------------

/** 订阅响应体 → { format, nodes[], skipped[] } */
export function parseSubscription(raw, { maxNodes = MAX_SUBSCRIPTION_NODES } = {}) {
  const { format, body } = decodeSubscription(raw);
  if (format === 'clash-yaml') {
    const skipped = [];
    return { format, nodes: parseClashYaml(body, { skipped, maxNodes }), skipped };
  }
  const nodes = [];
  const skipped = [];
  let count = 0;
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (++count > maxNodes) throw new Error('Subscription node limit exceeded');
    try {
      nodes.push(parseShareLink(t));
    } catch (e) {
      skipped.push({ line: count, reason: e.message });
    }
  }
  return { format, nodes, skipped };
}
