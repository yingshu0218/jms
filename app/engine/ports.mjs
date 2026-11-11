import { createServer } from 'node:net';

// 抢先拒绝旧监听器，不能将其 /version 当成本次内核启动成功。
export async function assertPortsAvailable(ports) {
  const reservations = [];
  try {
    for (const port of ports) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
      });
      reservations.push(server);
    }
  } catch {
    throw new Error('本地代理或内核 API 端口已被占用，请更换端口；未修改系统网络设置');
  } finally {
    await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
  }
}

/** macOS/Linux本机监听归属的只读检查；只查看刚启动的自有PID。 */
export async function assertListenerOwnership(ports, pid, { platform = process.platform, run } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('缺少本次内核进程身份');
  if (!run) {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    run = promisify(execFile);
  }
  const binary = platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof';
  for (const port of ports) {
    const { stdout } = await run(binary, ['-nP', '-a', '-p', String(pid), '-iTCP:' + port, '-sTCP:LISTEN', '-Fpn'], { timeout: 2000, maxBuffer: 64 * 1024 });
    const fields = stdout.split('\n');
    if (!fields.includes(`p${pid}`) || !fields.includes(`n127.0.0.1:${port}`)) throw new Error('本地端口不属于本次内核进程');
  }
}
