// 隔离开关不能借用正式状态目录，更不能用MockAdapter清掉真实恢复日志。
import { mkdirSync, readdirSync, existsSync, readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

export function prepareIsolatedDirectory(dir) {
  if (!dir) throw new Error('隔离实例必须显式指定独立空目录');
  const directory = resolve(dir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const reserved = name => ['jms client', 'jms-client'].includes(name.normalize('NFC').toLowerCase());
  if (lstatSync(directory).isSymbolicLink() || reserved(basename(directory)) || reserved(basename(realpathSync(directory)))) throw new Error('隔离实例不能使用正式目录或符号链接别名');
  if (existsSync(join(directory, 'sysproxy-journal.json'))) throw new Error('隔离实例不能打开含真实恢复日志的目录');
  const marker = join(directory, '.jms-isolated.json');
  if (existsSync(marker)) {
    let value;
    try { value = JSON.parse(readFileSync(marker, 'utf8')); } catch { throw new Error('隔离目录标记无效'); }
    if (value?.format !== 'jms-isolated-state' || value.version !== 1) throw new Error('隔离目录标记无效');
  } else {
    // entry先取得锁，当前自己的app.lock不算业务数据；其他既有文件一律拒绝。
    if (readdirSync(directory).some(name => name !== 'app.lock')) throw new Error('隔离实例要求空目录或已标记的隔离目录');
    writeFileSync(marker, JSON.stringify({ format: 'jms-isolated-state', version: 1 }), { mode: 0o600, flag: 'wx' });
  }
  return directory;
}
