// 常用链接检测
//
// 设计要点（这几点决定了这个功能是否有用）：
//
// ① **默认走代理端口检测**，不是直连。直连只能告诉你"机器有没有网"，
//    而用户真正要问的是"我现在能不能上 Google"。只有经过本地代理端口，
//    测的才是完整链路：本地入口 → 路由规则 → 出口节点 → 目标站。
//
// ② **失败时自动补一次直连对照**，据此给出诊断结论：
//      直连也失败 → 目标本身不可达或网络受限（不是代理的问题）
//      直连可达但代理失败 → 隧道/出口有问题
//    这把两种完全不同的故障区分开了 —— 否则用户只会看到"不通"，无从下手。
//
// ③ **带一个对照组（Cloudflare）**。如果对照组也不通，说明是整条隧道断了；
//    只有 Google/YouTube 不通而对照组通，则是出口 IP 被针对性识别。

import { probe } from './net/proxy-request.mjs';

/**
 * group 含义：
 *   control  —— 对照组：通常不受网络限制，用于判断"是隧道断了还是目标被拦"
 *   blocked  —— 在国内通常无法直连，是检测代理是否生效的主要观察对象
 */
export const DEFAULT_TARGETS = [
  { id: 'google', label: 'Google', url: 'https://www.google.com/generate_204', group: 'blocked' },
  { id: 'youtube', label: 'YouTube', url: 'https://www.youtube.com/generate_204', group: 'blocked' },
  { id: 'github', label: 'GitHub', url: 'https://github.com/', group: 'blocked' },
  { id: 'x', label: 'X', url: 'https://x.com/', group: 'blocked' },
  { id: 'openai', label: 'OpenAI', url: 'https://chatgpt.com/', group: 'blocked' },
  { id: 'wikipedia', label: '维基百科', url: 'https://zh.wikipedia.org/', group: 'blocked' },
  { id: 'cloudflare', label: 'Cloudflare', url: 'https://www.cloudflare.com/cdn-cgi/trace', group: 'control' },
];

export function localTarget(label, url) {
  return { id: 'local', label, url, group: 'local' };
}

/**
 * 并发探测一组目标
 * @param {object} opts
 *   proxy        {host, port} —— 有值则走代理（这是默认且推荐的用法）
 *   targets      目标列表
 *   concurrency  并发上限
 *   probeImpl    注入用（测试）
 */
export async function checkTargets(targets = DEFAULT_TARGETS, {
  proxy = null,
  concurrency = 6,
  timeoutMs = 8000,
  probeImpl = probe,
} = {}) {
  const queue = [...targets];
  const results = [];

  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      const r = await probeImpl(t.url, { proxy, timeoutMs });
      results.push({ ...t, ...r, via: proxy ? 'proxy' : 'direct' });
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker),
  );

  // 保持输入顺序，便于 UI 稳定展示
  const order = new Map(targets.map((t, i) => [t.id, i]));
  results.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  return results;
}

/** 汇总 + 结论判定 */
export function summarize(results) {
  const total = results.length;
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  const control = results.filter((r) => r.group === 'control');
  const controlOk = control.some((r) => r.ok);

  let verdict;
  let level; // ok | warn | bad
  if (total === 0) {
    verdict = '没有可检测的目标';
    level = 'warn';
  } else if (ok === total) {
    verdict = '全部可达，链路正常';
    level = 'ok';
  } else if (control.length && !controlOk) {
    verdict = '对照组也不通 —— 隧道本身可能已断开，请检查连接状态或更换节点';
    level = 'bad';
  } else if (ok === 0) {
    verdict = '全部不可达，但对照组本应可达 —— 建议更换节点后重试';
    level = 'bad';
  } else {
    verdict = `部分站点不可达（${failed.length}/${total}）—— 链路是通的，可能是出口 IP 被针对性识别`;
    level = 'warn';
  }

  const blockedFail = failed.filter((r) => r.group === 'blocked').map((r) => r.label);
  const avg = results.filter((r) => r.ok).reduce((s, r) => s + r.latencyMs, 0) / (ok || 1);

  return {
    total,
    ok,
    failed: failed.length,
    failedLabels: blockedFail,
    avgLatencyMs: ok ? Math.round(avg) : null,
    controlOk,
    verdict,
    level,
  };
}

/**
 * 完整检测：走代理跑一遍；对失败项补一次直连，给出"到底是谁的问题"。
 */
export async function runLinkCheck({
  proxy = null,
  targets = DEFAULT_TARGETS,
  concurrency = 6,
  timeoutMs = 8000,
  probeImpl = probe,
  diagnose = true,
} = {}) {
  const results = await checkTargets(targets, { proxy, concurrency, timeoutMs, probeImpl });

  if (diagnose && proxy) {
    const failedItems = results.filter((r) => !r.ok);
    if (failedItems.length) {
      // 只对失败项补直连对照 —— 成功项没必要多打一次请求
      await Promise.all(
        failedItems.map(async (r) => {
          const direct = await probeImpl(r.url, { proxy: null, timeoutMs });
          r.direct = { ok: direct.ok, status: direct.status, error: direct.error, latencyMs: direct.latencyMs };
          if (direct.ok) {
            r.diagnosis = '直连可达、代理不可达 → 问题在隧道或出口节点';
          } else if (r.group === 'control') {
            r.diagnosis = '对照组且直连也不可达 → 更像本地网络问题，不是代理造成';
          } else {
            r.diagnosis = '直连同样不可达 → 目标本身受限，与代理无关';
          }
        }),
      );
    }
  }

  return { results, summary: summarize(results) };
}
