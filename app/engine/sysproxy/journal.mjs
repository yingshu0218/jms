// 系统代理「操作日志」(journal)
//
// 存在的唯一理由：**崩溃自愈**。
//
// 系统代理是全项目最容易把用户搞断网的地方：一旦程序在「已改代理、未还原」的状态下崩溃，
// 用户的浏览器就永久指向一个已经不存在的端口 —— 表现为"突然上不了网"，
// 而用户根本不会想到是代理客户端干的。
//
// 做法：在**改动系统设置之前**先把原始状态落盘；正常断开时清除；
// 下次启动时若发现这份日志还在，说明上次没走完流程 —— 立刻还原。

import { readFileSync, writeFileSync, renameSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export class ProxyJournal {
  constructor(dir) {
    this.file = join(dir, 'sysproxy-journal.json');
    this.tmp = `${this.file}.tmp`;
  }

  read() {
    let text;
    try { text = readFileSync(this.file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw recoveryError();
    }
    try {
      const entry = JSON.parse(text);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          !entry.previous || !['on', 'off'].includes(entry.previous.mode) ||
          (entry.previous.mode === 'on' && (typeof entry.previous.host !== 'string' || !entry.previous.host ||
            !Number.isInteger(entry.previous.port) || entry.previous.port < 1 || entry.previous.port > 65535)) ||
          (entry.previousBase !== undefined && entry.previousBase !== null && (typeof entry.previousBase !== 'object' || Array.isArray(entry.previousBase)))) throw recoveryError();
      return entry;
    } catch { throw recoveryError(); }
  }

  isPending() {
    return existsSync(this.file);
  }

  /** 改动系统设置**之前**调用 */
  begin({ platform, previous, previousBase, target }) {
    if (this.isPending()) throw recoveryError();
    const payload = {
      platform,
      previous: previous ?? { mode: 'off' },
      // 完整快照：多网卡 / 多注册表项的精确还原全靠它
      previousBase: previousBase ?? null,
      target,
      startedAt: new Date().toISOString(),
      pid: process.pid,
    };
    writeFileSync(this.tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.tmp, 0o600);
    } catch {
      /* ignore */
    }
    renameSync(this.tmp, this.file);
    return payload;
  }

  /** 成功断开、或自愈完成后调用 */
  clear() {
    rmSync(this.file, { force: true });
  }
}

function recoveryError() {
  return Object.assign(new Error('系统代理恢复日志无效或尚未恢复，未修改网络设置；请保留日志并手动检查原设置'), { code: 'RECOVERY_REQUIRED' });
}
