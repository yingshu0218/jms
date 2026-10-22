// 订阅解析层
// 输入：订阅响应体（字符串）→ 输出：统一节点对象数组
// 支持三种订阅形态：① base64 编码的分享链接列表 ② 明文分享链接列表 ③ Clash YAML（flow 风格 proxies）
// 设计原则：这一层是纯函数，不碰网络、不碰文件、不碰系统 API —— 所以能被 AI 快速写对，也最好测。

const SHARE_SCHEMES = ['vless', 'vmess', 'trojan', 'ss', 'ssr'];

function b64decode(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const pad = t.length % 4 ? '='.repeat(4 - (t.length % 4)) : '';
  return Buffer.from(t + pad, 'base64').toString('utf8');
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

  let server = hostport;
  let port = '';
  if (hostport.startsWith('[')) {
    const e = hostport.indexOf(']');
    server = hostport.slice(1, e);
    port = hostport.slice(e + 2);
  } else {
    const c = hostport.lastIndexOf(':');
    if (c >= 0) {
      server = hostport.slice(0, c);
      port = hostport.slice(c + 1);
    }
  }

  return { scheme, userinfo, server, port: Number(port), name, params: new URLSearchParams(query) };
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 一条分享链接 → 节点对象 */
export function parseShareLink(link) {
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
  if (!j.add || !j.port || !j.id) throw new Error(`VMess 节点缺少必要字段: ${j.ps || j.add || '(未命名)'}`);

  const net = String(j.net || 'tcp').toLowerCase();
  const node = {
    name: j.ps || `${j.add}:${j.port}`,
    type: 'vmess',
    server: j.add,
    server_port: Number(j.port),
    uuid: j.id,
    alter_id: Number(j.aid ?? 0),
    cipher: j.scy || 'auto',
    network: net,
    security: j.tls === 'tls' ? 'tls' : 'none',
    tls: { enabled: j.tls === 'tls' },
  };
  if (node.tls.enabled) {
    node.tls.server_name = j.sni || j.host || '';
    if (j.fp) node.tls.utls = { enabled: true, fingerprint: j.fp };
    if (j.alpn) node.tls.alpn = String(j.alpn).split(',').map((s) => s.trim()).filter(Boolean);
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
    const c = hp.lastIndexOf(':');
    server = hp.slice(0, c);
    port = Number(hp.slice(c + 1));
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
    password: p.userinfo,
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
  const out = {};
  const inner = body.trim().replace(/^\{/, '').replace(/\}$/, '');
  let i = 0;

  while (i < inner.length) {
    const km = /^[\s,]*([A-Za-z0-9_.-]+)\s*:\s*/.exec(inner.slice(i));
    if (!km) break;
    const key = km[1];
    let j = i + km[0].length;

    if (inner[j] === '{') {
      // 嵌套对象：花括号配对，跳过引号内的括号
      let depth = 0;
      let quote = null;
      let k = j;
      for (; k < inner.length; k++) {
        const ch = inner[k];
        if (quote) {
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            k++;
            break;
          }
        }
      }
      out[key] = parseFlowMap(inner.slice(j, k));
      i = k;
    } else {
      // 标量：读到深度 0 的逗号为止；引号内的逗号不算分隔符
      let quote = null;
      let buf = '';
      let k = j;
      for (; k < inner.length; k++) {
        const ch = inner[k];
        if (quote) {
          if (ch === quote) quote = null;
          else buf += ch;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === ',' || ch === '}') break;
        buf += ch;
      }
      out[key] = buf.trim();
      i = k + 1;
    }
  }
  return out;
}

function clashProxyToNode(o) {
  const type = String(o.type || '').toLowerCase();
  const base = {
    name: o.name || `${o.server}:${o.port}`,
    server: o.server,
    server_port: Number(o.port),
  };
  switch (type) {
    case 'vless': {
      const node = {
        ...base,
        type: 'vless',
        uuid: o.uuid,
        flow: o.flow || '',
        network: 'tcp',
        security: o.tls ? 'reality' : 'none',
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
        alter_id: Number(o.alterId ?? 0),
        cipher: o.cipher || 'auto',
        network: 'tcp',
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

export function parseClashYaml(text) {
  const nodes = [];
  let inProxies = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
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
    if (!body.startsWith('{')) continue; // 块状风格（多行）M1 暂不支持
    nodes.push(clashProxyToNode(parseFlowMap(body)));
  }
  return nodes;
}

// ---- 统一入口 ------------------------------------------------------------

/** 订阅响应体 → { format, nodes[], skipped[] } */
export function parseSubscription(raw) {
  const { format, body } = decodeSubscription(raw);
  if (format === 'clash-yaml') {
    return { format, nodes: parseClashYaml(body), skipped: [] };
  }
  const nodes = [];
  const skipped = [];
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    try {
      nodes.push(parseShareLink(t));
    } catch (e) {
      skipped.push({ line: t.slice(0, 60), reason: e.message });
    }
  }
  return { format, nodes, skipped };
}
