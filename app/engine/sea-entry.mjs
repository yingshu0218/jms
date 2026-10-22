// SEA（单文件二进制）打包专用入口。
//
// 为什么单独一个文件，而不是复用 engine/server.mjs 的 CLI 入口：
//   · Node SEA 只接受 CommonJS 主脚本，需要 esbuild 转格式；
//   · 转成 CJS 后 import.meta.url 不再可靠（SEA 里没有真实的模块目录），
//     而 server.mjs 用它推导 UI 路径。这里改为由 --ui 显式传入。
//
// 参数与 server.mjs 保持一致，Tauri 侧只需把 --ui 指向随包资源即可；
// 引擎逻辑一行没变，全部复用。

import { AppService } from './app.mjs';
import { createAppServer } from './server.mjs';
import { acquireLock } from './lock.mjs';

const argOf = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

async function main() {
  const host = argOf('host', '127.0.0.1');
  const port = Number(argOf('port', '7788'));
  const uiFile = argOf('ui', undefined);
  const app = new AppService({ dir: argOf('dir', undefined), coreBinary: argOf('core', undefined) });

  // 单实例：两个实例会互相覆盖系统代理，还会抢同一个端口
  const lock = acquireLock(`${app.dir}/app.lock`);
  if (!lock.ok) {
    console.error(`已有实例在运行（PID ${lock.pid}）。请先关闭它，或直接使用那个窗口。`);
    process.exit(1);
  }
  if (lock.stalePid) console.log(`[锁] 接管了上次异常退出留下的锁（原 PID ${lock.stalePid}）`);

  const healed = await app.boot();
  app.startAutoRefresh();
  if (healed.healed) console.log(`[自愈] 已还原上次异常退出留下的系统代理设置 → ${JSON.stringify(healed.restoredTo)}`);

  app.on('warn', (m) => console.log(`[警告] ${m}`));
  app.on('connected', (m) => console.log(`[已连接] 节点=${m.node} pid=${m.pid}`));
  app.on('disconnected', () => console.log('[已断开]'));
  app.on('healed', (h) => console.log(`[自愈] ${JSON.stringify(h)}`));

  createAppServer({ app, host, port, uiFile });
  console.log(`jms-client 引擎已启动 → http://${host}:${port}`);
  console.log(`内核: ${app.coreBinary || '未找到（设置 SING_BOX 环境变量）'}`);

  const shutdown = async (sig) => {
    console.log(`\n收到 ${sig}，正在清理…`);
    try {
      if (app.store.state.runtime.connected) await app.disconnect();
      else if (app.journal.isPending()) await app.boot();
    } catch (e) {
      console.error('清理失败：', e.message);
    }
    lock.release();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 引擎日志直接写标准输出：Tauri 侧会转成窗口里的「内核日志」
  console.log('[就绪]');
}

main().catch((e) => {
  console.error(`引擎启动失败：${e?.stack || e}`);
  process.exit(1);
});
