// 系统代理的开关 + 崩溃自愈
//
// 三条不可动摇的顺序规则：
//   ① 写入日志 → 再改系统设置（顺序反了就没有自愈能力）
//   ② 断开时：**先还原系统代理，再停内核**（反过来会有几秒的全机断网）
//   ③ 启动时：发现日志残留 = 上次崩了 → 立刻还原

import { ProxyJournal } from './journal.mjs';
import { getAdapter, MockAdapter } from './adapters.mjs';

export { ProxyJournal, getAdapter, MockAdapter };

/** 开启系统代理，返回可以精确还原的原始状态 */
export async function enableProxy({ adapter, journal, host = '127.0.0.1', port, bypass }) {
  if (!adapter || !journal) throw new Error('enableProxy 需要 adapter 与 journal');
  if (!port) throw new Error('enableProxy 缺少端口');
  if (adapter.platform === 'darwin' && ![2, 3].includes(adapter.transactionVersion)) throw recoveryError('Darwin 适配器不支持完整事务恢复，未修改设置');

  // 取完整快照（不只是对外视图）：适配器把「哪些网卡 / 哪些注册表项」
  // 记在 base 里，还原时按快照逐项写回 —— 只记一份 host/port 是不够的。
  const snap = typeof adapter.snapshot === 'function' ? await adapter.snapshot() : await adapter.read();
  const previous = { ...snap };
  delete previous.base;
  const target = { mode: 'on', host, port, bypass: bypass ?? null };
  const darwin = adapter.platform === 'darwin' ? await adapter.prepareTransaction(snap, target) : null;
  await journal.begin({
    platform: adapter.platform,
    previous,
    previousBase: snap.base ?? null,
    target, ...(darwin ? { darwin } : {}),
  });

  try {
    await adapter.apply({ ...target, ...(snap.base ? { base: snap.base } : {}) }, { journal });
  } catch (e) {
    // Darwin retains all write-ahead evidence on failure. The orchestration layer
    // must invoke verified disable/heal before stopping the core; do not hide a
    // second sequence of network writes inside a failed enable operation.
    if (adapter.platform !== 'darwin') {
      try {
        await restoreTo(adapter, journal.read(), journal);
        journal.clear();
      } catch { /* keep the journal for an explicit recovery attempt */ }
    }
    throw Object.assign(new Error(`设置系统代理失败：${e.message}`), { code: e.code || 'RECOVERY_REQUIRED' });
  }
  return { previous };
}

/**
 * 还原到上一次改动前的状态。
 *
 * 版本和平台必须匹配。Darwin只接受完整、带服务身份的事务日志，
 * 在全服务冲突检查和逐项读回通过后才允许清除日志；不猜测旧设置。
 */
function recoveryError(message) { return Object.assign(new Error(message), { code: 'RECOVERY_REQUIRED' }); }
async function restoreTo(adapter, entry, journal) {
  if (!entry || entry.version !== 2 || entry.platform !== adapter.platform) throw recoveryError('恢复日志版本或平台不匹配，未修改设置');
  const base = entry.previousBase;
  if (adapter.platform === 'darwin') {
    if (![2, 3].includes(adapter.transactionVersion) || !base) throw recoveryError('Darwin恢复日志不完整，未修改设置');
    await adapter.restore(base, { journal });
    if (!await adapter.verifyRestored(journal.read())) throw recoveryError('系统代理恢复读回不一致，日志已保留');
    return;
  }
  if (base && typeof adapter.restore === 'function') { await adapter.restore(base); return; }
  if (!entry.previous || !['on', 'off'].includes(entry.previous.mode)) throw recoveryError('恢复日志不完整，未修改设置');
  await adapter.apply(entry.previous);
}

/** 关闭系统代理并还原到开启前的状态 */
export async function disableProxy({ adapter, journal }) {
  if (!adapter || !journal) throw new Error('disableProxy 需要 adapter 与 journal');
  const entry = journal.read();
  if (!entry) return { restored: null, hadJournal: false };
  const previous = entry.previous;
  await restoreTo(adapter, entry, journal);
  journal.clear();
  return { restored: previous, hadJournal: Boolean(entry) };
}

/**
 * 启动时自愈：上次进程在「已改代理、未还原」状态下退出（崩溃 / 被强杀），
 * 这里把它还原回去。返回 { healed: false } 表示本来就没问题。
 */
export async function healIfNeeded({ adapter, journal }) {
  if (!adapter || !journal) throw new Error('healIfNeeded 需要 adapter 与 journal');
  const entry = journal.read();
  if (!entry) return { healed: false };
  const previous = entry.previous;
  await restoreTo(adapter, entry, journal);
  journal.clear();
  return {
    healed: true,
    startedAt: entry.startedAt,
    platform: entry.platform,
    restoredTo: previous,
    platformMismatch: false, // 不同平台已在任何写入前拒绝。
  };
}

/** 判断系统代理当前是否指向我们自己（用于状态显示与一致性校验） */
export async function isPointingAtUs({ adapter, port }) {
  try {
    const cur = await adapter.read();
    return cur.mode === 'on' && ['127.0.0.1', 'localhost', '::1'].includes(cur.host) && Number(cur.port) === Number(port) &&
      (!cur.https || (cur.https.enabled && Number(cur.https.port) === Number(port) && ['127.0.0.1', 'localhost', '::1'].includes(cur.https.host)));
  } catch {
    return false;
  }
}
