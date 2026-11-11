// 源码 CLI 与 SEA 共用启动/安全退出路径，避免恢复失败时仍退出并释放锁。
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { AppService } from './app.mjs';
import { DEFAULT_DIR } from './store.mjs';
import { createAppServer } from './server.mjs';
import { acquireLock } from './lock.mjs';
import { newApiToken, checkApiToken } from './control-auth.mjs';

export async function runEngine({ argv = process.argv, env = process.env } = {}) {
  const argOf = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const host = argOf('host', '127.0.0.1');
  const port = Number(argOf('port', '7788'));
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('引擎仅允许监听回环地址');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HTTP 端口无效');
  const authToken = checkApiToken(env.JMS_API_TOKEN || newApiToken());
  const instanceId = env.JMS_INSTANCE_ID || randomUUID();
  const isolated = argv.includes('--isolated');
  const requestedDir = argOf('dir', undefined);
  if (isolated && !requestedDir) throw new Error('隔离实例必须显式指定独立空目录');
  const dir = resolve(requestedDir || DEFAULT_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 获取锁先于Store读取/损坏重命名或隔离端口写入，拒绝实例不得改变原状态。
  const lock = acquireLock(join(dir, 'app.lock'));
  if (!lock.ok) throw new Error('已有引擎拥有此状态目录，未复用、停止或覆盖该引擎');
  let app;
  let server;
  try {
    app = new AppService({ dir, coreBinary: argOf('core', undefined), isolated, controlPort: port });
    app.ready = false;
    // 先绑定控制端口，碰到已有服务时绝不先自愈/修改宿主代理。
    server = createAppServer({ app, host, port, uiFile: argOf('ui', undefined), authToken, instanceId });
    await once(server, 'listening');
    const healed = await app.boot();
    app.ready = true;
    app.startAutoRefresh();
    if (healed.healed) console.log('[自愈] 已恢复上次未完成的系统代理设置');
    // CLI 凭据只落到用户自己的 0600 文件；不打印秘密或放进 URL。
    if (!env.JMS_API_TOKEN) {
      const file = join(app.dir, 'api-auth.json');
      writeFileSync(file, JSON.stringify({ authToken, instanceId }), { mode: 0o600 });
      chmodSync(file, 0o600);
    }
  } catch (error) {
    server?.close();
    lock.release();
    throw error;
  }
  app.on('warn', message => console.log(`[警告] ${message}`));
  app.on('connected', () => console.log('[已连接]'));
  app.on('disconnected', () => console.log('[已断开]'));
  console.log(`jms-client 引擎已启动 → http://${host}:${port}`);
  console.log(app.isolated ? '[隔离] 禁止真实网络接管、提权与外部订阅' : '[就绪]');
  let closing;
  const shutdown = () => {
    if (closing) return closing;
    closing = (async () => {
      try {
        await server.drain();
        server.closeAllConnections();
        server.close();
        lock.release();
        process.exitCode = 0;
      } catch (error) {
        // 保留端口、锁与进程，用户可以检查状态和重试；不能把失败报告成成功退出。
        console.error(`清理未完成，已保留引擎：${error.message}`);
        process.exitCode = 1;
      } finally { closing = null; }
    })();
    return closing;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.on('error', error => { console.error(`控制接口错误：${error.code || 'UNKNOWN'}`); void shutdown(); });
  return { app, server, shutdown };
}
