// 单实例锁
//
// 为什么必须有：两个实例同时跑会有两套系统代理设置互相覆盖，
// 而且第二个内核会抢同一个本地端口 —— 表现是"点连接没反应"或"系统代理乱跳"，
// 极难排查。所以启动时就锁住。
//
// 关键点：**崩溃会留下锁文件**，所以不能只看"文件存在"，必须校验持有者进程是否还活着；
// 已死的进程留下的锁视为陈旧锁，直接接管。

import { openSync, writeSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM 说明进程存在但没有权限发信号 → 仍视为存活
    return e.code === 'EPERM';
  }
}

/**
 * 尝试获取独占锁。
 * @returns {{ok:true, release:Function, stalePid?:number}} 或 {{ok:false, pid:number}}
 */
export function acquireLock(file) {
  try {
    const fd = openSync(file, 'wx'); // 'wx' = 独占创建，已存在则 EEXIST
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return { ok: true, release: () => releaseLock(file, process.pid) };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;

    let holder = NaN;
    try {
      holder = Number(String(readFileSync(file, 'utf8')).trim());
    } catch {
      /* 读不到就按陈旧锁处理 */
    }

    if (isAlive(holder)) return { ok: false, pid: holder };

    // 陈旧锁（上次崩溃留下的）→ 接管
    writeFileSync(file, String(process.pid), { mode: 0o600 });
    return { ok: true, stalePid: Number.isFinite(holder) ? holder : undefined, release: () => releaseLock(file, process.pid) };
  }
}

function releaseLock(file, pid) {
  try {
    // 只删自己的锁：避免把接管后新实例的锁删掉
    const holder = Number(String(readFileSync(file, 'utf8')).trim());
    if (holder === pid) unlinkSync(file);
  } catch {
    /* ignore */
  }
}
