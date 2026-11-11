import { isIP } from 'node:net';
// Pure normalized-node validation. Error messages never contain subscription values.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const methods = new Set(['aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305', '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305']);
const fail = field => { throw Object.assign(new Error(`Invalid node field: ${field}`), { code: 'INVALID_NODE' }); };
const text = (v, field) => { if (typeof v !== 'string' || !v.length || v.length > 4096 || /[\x00-\x1f\x7f]/.test(v)) fail(field); };
const record = (v, field) => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(field); };
const optionalString = (v, field) => { if (v !== undefined && (typeof v !== 'string' || v.length > 4096 || /[\x00-\x1f\x7f]/.test(v))) fail(field); };
const optionalBool = (v, field) => { if (v !== undefined && typeof v !== 'boolean') fail(field); };
export function validateNode(input) {
 record(input, 'node');
 const node = { ...input };
 if (node.name !== undefined && (typeof node.name !== 'string' || node.name.length > 256 || /\p{Cc}/u.test(node.name))) fail('name');
 if (node.type === 'vmess') {
  if (node.alter_id === undefined) node.alter_id = 0;
  if (node.cipher === undefined) node.cipher = 'auto';
 }
 if (node.ws !== undefined) record(node.ws, 'ws');
 if (node.grpc !== undefined) record(node.grpc, 'grpc');
 if (node.ws !== undefined && node.grpc !== undefined) fail('transport');
 if (node.network === undefined) node.network = node.ws !== undefined ? 'ws' : node.grpc !== undefined ? 'grpc' : 'tcp';
 if ((node.network === 'ws') !== (node.ws !== undefined) || (node.network === 'grpc') !== (node.grpc !== undefined)) fail('transport');
 optionalString(node.flow, 'flow');

 if (!node || !['vless','vmess','shadowsocks','trojan'].includes(node.type)) fail('type');
 text(node.server, 'server');
 // URL parsing is pure and validates IPv6 syntax; forbid URL/userinfo/path instead of repairing it.
 if (/[\s/@?#\\]/.test(node.server)) fail('server');
 if (!node.server.includes(':') && (node.server.length > 253 || !node.server.replace(/\.$/, '').split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))) fail('server');
 if (node.server.includes(':') && isIP(node.server) !== 6) fail('server');
 if (/^(?:[0-9]+|0x[0-9a-f]+)(?:\.(?:[0-9]+|0x[0-9a-f]+))*$/i.test(node.server) && isIP(node.server) !== 4) fail('server');
 try { const u = new URL(`http://${node.server.includes(':') ? `[${node.server}]` : node.server}:443`); if (!u.hostname || (!node.server.includes(':') && isIP(u.hostname) === 4 && u.hostname !== node.server)) fail('server'); } catch { fail('server'); }
 if (!Number.isSafeInteger(node.server_port) || node.server_port < 1 || node.server_port > 65535) fail('port');
 if (!['tcp','ws','grpc'].includes(node.network) || node.extra_network !== undefined) fail('transport');
 if (node.security !== undefined && !['none','tls','reality'].includes(node.security)) fail('security');
 if (node.type === 'vless' || node.type === 'vmess') { if (typeof node.uuid !== 'string' || !uuid.test(node.uuid)) fail('uuid'); }
 if (node.type === 'vless' && !['','xtls-rprx-vision'].includes(node.flow || '')) fail('flow');
 if (node.type === 'vmess') {
  if (!Number.isInteger(node.alter_id) || node.alter_id < 0 || node.alter_id > 65535) fail('alter_id');
  if (!['auto','none','zero','aes-128-gcm','chacha20-poly1305'].includes(node.cipher)) fail('cipher');
 }
 if (['trojan','shadowsocks'].includes(node.type)) text(node.password,'password');
 if (node.type === 'shadowsocks' && (node.network) !== 'tcp') fail('transport');
 if (node.type === 'shadowsocks' && !methods.has(node.method)) fail('cipher');
 if (node.type === 'shadowsocks' && node.method.startsWith('2022-')) {
  const size = node.method === '2022-blake3-aes-128-gcm' ? 16 : 32;
  if (!node.password.split(':').every(key => /^[A-Za-z0-9+/]+={0,2}$/.test(key) && Buffer.from(key, 'base64').length === size)) fail('password');
 }
 if (node.type === 'shadowsocks' && node.tls !== undefined) fail('tls');
 if (node.type === 'trojan' && node.tls?.enabled === false) fail('tls');
 if (node.security === 'tls' && node.tls?.enabled !== true) fail('security');
 if (node.security === 'reality' && node.tls?.reality?.enabled !== true) fail('security');
 if (node.tls !== undefined) {
  record(node.tls, 'tls');
  if (typeof node.tls.enabled !== 'boolean') fail('tls');
  optionalString(node.tls.server_name, 'server_name');
  optionalBool(node.tls.insecure, 'insecure');
  if (node.tls.alpn !== undefined) {
   if (!Array.isArray(node.tls.alpn) || node.tls.alpn.length > 32) fail('alpn');
   for (const value of node.tls.alpn) text(value, 'alpn');
  }
  if (node.tls.utls !== undefined) {
   record(node.tls.utls, 'utls');
   optionalBool(node.tls.utls.enabled, 'utls.enabled');
   optionalString(node.tls.utls.fingerprint, 'fingerprint');
  }
  if (node.tls.reality !== undefined) {
   const reality = node.tls.reality;
   record(reality, 'reality');
   if (typeof reality.enabled !== 'boolean') fail('reality.enabled');
   optionalString(reality.public_key, 'public_key');
   optionalString(reality.short_id, 'short_id');
   optionalString(reality.spider_x, 'spider_x');
   if (reality.enabled && (!node.tls.enabled || !/^[A-Za-z0-9_-]{43}=?$/.test(reality.public_key || ''))) fail('reality');
   if (reality.short_id !== undefined && !/^(?:[0-9a-f]{2}){0,8}$/i.test(reality.short_id)) fail('short_id');
  }
 }
 for (const [kind, fields] of [['ws',['path','host']],['grpc',['service_name']]]) if (node[kind] !== undefined) {
  for (const key of Object.keys(node[kind])) if (!fields.includes(key)) fail('transport');
  for (const field of fields) optionalString(node[kind][field], 'transport');
 }

 return node;
}
