import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { connect } from 'node:net';
import { probe } from '../engine/net/proxy-request.mjs';

function fixture(t, names) {
  const dir = mkdtempSync(join(tmpdir(), 'jms-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'openssl.cnf'), `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=${names}\n`, { mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-config', join(dir, 'openssl.cnf')], { stdio: 'ignore', timeout: 15_000 });
  return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
}
async function listen(t, server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return server.address().port;
}

test('HTTPS：默认拒绝自签名证书，明确报告TLS错误', async t => {
  const certificate = fixture(t, 'IP:127.0.0.1');
  const port = await listen(t, httpsServer(certificate, (_req, res) => res.writeHead(204).end()));
  const result = await probe(`https://127.0.0.1:${port}/ok`);
  assert.equal(result.ok, false); assert.equal(result.error, 'TLS 证书错误');
});

test('HTTPS：即使CA受信任也拒绝错误主机名', async t => {
  const certificate = fixture(t, 'DNS:localhost');
  const port = await listen(t, httpsServer(certificate, (_req, res) => res.writeHead(204).end()));
  const result = await probe(`https://127.0.0.1:${port}/ok`, { ca: certificate.cert });
  assert.equal(result.ok, false); assert.equal(result.error, 'TLS 证书错误');
});

test('HTTPS：受信任本地fixture保留精确路径和query，CONNECT同样校验证书', async t => {
  const certificate = fixture(t, 'IP:127.0.0.1');
  const paths = [];
  const port = await listen(t, httpsServer(certificate, (req, res) => { paths.push(req.url); res.writeHead(204).end(); }));
  const proxy = httpServer(); const sockets = new Set();
  proxy.on('connect', (_req, client, head) => {
    const target = connect(port, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) target.write(head); client.pipe(target); target.pipe(client); });
    for (const socket of [client, target]) { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); }
  });
  const proxyPort = await listen(t, proxy);
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  for (const path of ['/exact', '/exact?x=1']) {
    assert.equal((await probe(`https://127.0.0.1:${port}${path}`, { ca: certificate.cert })).status, 204);
    assert.equal((await probe(`https://127.0.0.1:${port}${path}`, { ca: certificate.cert, proxy: { host: '127.0.0.1', port: proxyPort } })).status, 204);
  }
  assert.deepEqual(paths, ['/exact', '/exact', '/exact?x=1', '/exact?x=1']);
  assert.equal((await probe(`https://127.0.0.1:${port}/untrusted`, { proxy: { host: '127.0.0.1', port: proxyPort } })).ok, false);
});
