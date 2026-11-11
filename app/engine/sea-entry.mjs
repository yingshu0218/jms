// SEA（CommonJS 单文件）与源码 CLI 使用同一启动/停机路径。
import { runEngine } from './entry.mjs';
runEngine().catch(error => {
  console.error(`引擎启动失败：${error.message}`);
  process.exitCode = 1;
});
