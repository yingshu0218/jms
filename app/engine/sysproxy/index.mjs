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

  // 取完整快照（不只是对外视图）：适配器把「哪些网卡 / 哪些注册表项」
  // 记在 base 里，还原时按快照逐项写回 —— 只记一份 host/port 是不够的。
  const snap = typeof adapter.snapshot === 'function' ? await adapter.snapshot() : await adapter.read();
  const previous = { ...snap };
  delete previous.base;
  await journal.begin({
    platform: adapter.platform,
    previous,
    previousBase: snap.base ?? null,
    target: { mode: 'on', host, port, bypass: bypass || null },
  });

  try {
    await adapter.apply({ mode: 'on', host, port, bypass: bypass || null, ...(snap.base ? { base: snap.base } : {}) });
  } catch (e) {
    // 改动失败：尽力还原，并清掉日志（因为已经还原了）
    try {
      await restoreTo(adapter, { previous, previousBase: snap.base ?? null });
      journal.clear();
    } catch {
      /* 还原也失败 —— 日志保留，留给下次启动自愈 */
    }
    throw new Error(`设置系统代理失败：${e.message}`);
  }
  return { previous };
}

/**
 * 还原到上一次改动前的状态。
 *
 * 有完整快照就走 adapter.restore()（按网卡 / 按注册表项逐项写回）；
 * 没有快照（旧版本留下的日志）退回 apply(previous) —— 对多网卡场景只能做到
 * 「大致关掉」，但总比留着我们的设置强。
 */
async function restoreTo(adapter, entry) {
  const base = entry?.previousBase;
  if (base && typeof adapter.restore === 'function') {
    await adapter.restore(base);
    return;
  }
  await adapter.apply(entry?.previous || { mode: 'off' });
}

/** 关闭系统代理并还原到开启前的状态 */
export async function disableProxy({ adapter, journal }) {
  if (!adapter || !journal) throw new Error('disableProxy 需要 adapter 与 journal');
  const entry = journal.read();
  if (!entry) return { restored: null, hadJournal: false };
  const previous = entry.previous;
  await restoreTo(adapter, entry);
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
  const previous = entry.previous || { mode: 'off' };
  await restoreTo(adapter, entry);
  journal.clear();
  return {
    healed: true,
    startedAt: entry.startedAt,
    platform: entry.platform,
    restoredTo: previous,
    // 跨平台残留：上次是在别的系统上崩的，本地还原可能不适用
    platformMismatch: entry.platform !== adapter.platform,
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
