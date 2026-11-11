// 进程级分流（per-app routing）配置生成
//
// 目标：按应用名单决定代理分流范围，支持反向选择 —— 用 sing-box 原生的进程匹配规则实现，
//      不需要 Proxifier / 付费驱动 / DLL 注入。
//
// 官方依据：
//   process_name / process_path / process_path_regex "Only supported on Linux, Windows, and macOS."
//   https://sing-box.sagernet.org/configuration/route/rule/
//   auto_detect_interface "prevent routing loops under tun"
//   https://sing-box.sagernet.org/configuration/route/
//
// ⚠️ 一个实测结论：process_name 匹配在 **mixed / socks 本地代理入口下完全失效**
//    （控制实验：curl 与 python3 行为一致，内核日志 `router: failed to search process: process not found`）。
//    只有 TUN 层捕获才拿得到进程归属 —— 所以按应用分流必须走 TUN，没有第二条路。
//
// ── TUN 模式下的两层判定 ──────────────────────────────────────────────────
//
//   第一层「谁能用代理」：默认名单内分流；reverseApps 时名单内先直连，名单外分流。
//   第二层「目标应用的流量怎么走」：三档路由模式 + 自定义规则 + 国内直连。
//
//   这两层是独立的。少了第二层，三档路由在 TUN 模式下就变成**三个点了没反应的按钮** ——
//   界面显示切换成功（clash_mode 确实通过 API 写进去了），但配置里没有任何规则引用
//   clash_mode，于是什么都不会发生。这是本文件最需要说清的地方。

import {
  buildOutbounds,
  buildDnsConfig,
  buildRouteRules,
  SELECTOR_TAG,
  ROUTING_MODES,
  FALLBACK_CN_SUFFIXES,
} from './to-singbox.mjs';
import { customRulesToRouteRules } from './custom-rules.mjs';

/**
 * 已知应用的进程名档案。
 * ⚠️ 这些名字必须在你自己的机器上实测确认 —— 不同版本、不同平台的进程名会变。
 * 用 `node src/discover.mjs` 把真实进程名抓出来，再来改这里。
 */
export const APP_PROFILES = {
  antigravity: {
    label: 'Google Antigravity',
    // 关键：Antigravity 的 agent 后端跑在 **另一个进程** 里（language_server_*），
    // 只代理 Antigravity.exe 是新手最常踩的坑 —— 界面能开，agent 一直转圈。
    win32: ['Antigravity.exe', 'language_server_windows_x64.exe'],
    darwin: ['Antigravity', 'Antigravity Helper', 'language_server_macos_arm64', 'language_server_macos_x64'],
    linux: ['antigravity', 'language_server_linux_x64', 'language_server_linux_arm64'],
  },
  vscode: {
    label: 'VS Code',
    win32: ['Code.exe'],
    darwin: ['Code', 'Code Helper', 'Code Helper (Renderer)', 'Code Helper (Plugin)'],
    linux: ['code', 'code-oss'],
  },
  chrome: {
    label: 'Google Chrome',
    win32: ['chrome.exe'],
    darwin: ['Google Chrome', 'Google Chrome Helper'],
    linux: ['chrome', 'google-chrome'],
  },
};

/** 取某平台下已知应用的进程名 */
export function appProcessNames(appKeys, platform = process.platform) {
  const names = [];
  for (const key of appKeys) {
    const p = APP_PROFILES[key];
    if (!p) throw new Error(`未知的应用档案: ${key}（可用: ${Object.keys(APP_PROFILES).join(', ')}）`);
    const list = p[platform] || [];
    if (!list.length) throw new Error(`${p.label} 在 ${platform} 上没有登记进程名，请先用 discover.mjs 抓取`);
    names.push(...list);
  }
  return [...new Set(names)];
}

/**
 * 生成「只代理指定应用」的 TUN 配置
 *
 * 与全局 TUN 的区别：TUN 负责**捕获**全部流量，路由规则决定**谁走代理**。
 * 捕获范围 ≠ 分流范围 —— 除了目标应用，其他流量进入内核后立刻被判定为 direct，不经过海外节点。
 *
 * @param opts.reverseApps   true 时名单内直连，名单外按规则分流
 * @param opts.apps          应用档案键（如 ['antigravity']）
 * @param opts.processNames  直接指定进程名，优先于 apps
 * @param opts.routingMode   'rule' | 'global' | 'direct' —— 决定**目标应用**的流量怎么走
 * @param opts.customRules   用户自定义规则；在 TUN 模式下被限定在目标应用上
 * @param opts.ruleSetPaths  已缓存的规则集路径；缺失时退回内置域名后缀
 */
export function buildTunPerAppConfig(nodes, opts = {}) {
  const {
    apps = ['antigravity'],
    reverseApps = false,
    processNames: explicitNames,
    platform = process.platform,
    selected = 0,
    clashApi = '127.0.0.1:9090',
    debugPort = 2080, // 额外开一个本地混合代理口，方便手动验证
    strictRoute = false,
    remoteDns = 'https://1.1.1.1/dns-query',
    localDns = '223.5.5.5',
    routingMode = 'rule',
    ruleSetPaths = {},
    directRules = true,
    customRules = [],
  } = opts;

  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('没有可用节点');
  if (!ROUTING_MODES.includes(routingMode)) throw new Error(`未知的路由模式: ${routingMode}`);
  if (selected < 0 || selected >= nodes.length) throw new Error(`selected 越界: ${selected}`);

  const processNames = explicitNames?.length ? explicitNames : appProcessNames(apps, platform);
  const { outbounds } = buildOutbounds(nodes, selected);
  const custom = customRulesToRouteRules(customRules);

  // ── DNS：只让目标应用的解析走远端，且国内域名优先走本地 ──
  //
  // 顺序很关键。目标应用访问国内站点时，必须命中「本地解析」而不是「进程 → 远端」，
  // 否则就近 CDN 依然失效 —— 那就等于没做 DNS 分流。
  const baseDns = buildDnsConfig({ routingMode, ruleSetPaths, localDns, remoteDns });
  const cnMatch = ruleSetPaths['geosite-cn']
    ? { rule_set: 'geosite-cn' }
    : { domain_suffix: FALLBACK_CN_SUFFIXES };

  const dns = {
    ...baseDns,
    rules: [
      // ① 直连档：目标应用也本地解析
      { process_name: processNames, clash_mode: 'direct', server: 'local' },
      ...custom.rules.filter(r => !r.process_name && !r.process_path && !r.ip_cidr)
        .map(({ outbound, ...match }) => ({ process_name: processNames, ...match, server: outbound === 'direct' ? 'local' : 'remote' })),
      // ② ★ 目标应用 + 国内域名 → 本地解析（就近 CDN 的关键）
      { process_name: processNames, ...cnMatch, server: 'local' },
      // ③ 目标应用的其余域名 → 远端解析（规则档与全局档都需要）
      { process_name: processNames, server: 'remote' },
    ],
    // 非目标应用一律本地解析，与 final: 'direct' 对应
    final: 'local',
  };

  // ── 路由规则 ──
  let rules = [
    { action: 'sniff' },
    { protocol: 'dns', action: 'hijack-dns' },

    ...(processNames.length ? [{ process_name: processNames, invert: true, outbound: 'direct' }] : []),
    // ① 直连档守卫：显式选择「不使用代理」时，连自定义规则也不该翻盘
    { process_name: processNames, clash_mode: 'direct', outbound: 'direct' },

    // ② 自定义规则 —— 用户意图优先于内置地理库。
    //    进程规则可进一步缩小范围；前面的名单外直连守卫始终有效。
    ...custom.rules.map((r) => ({ process_name: processNames, ...r })),

    // ③ 全局档守卫
    { process_name: processNames, clash_mode: 'global', outbound: SELECTOR_TAG },

    // ④ 内网直连
    { process_name: processNames, ip_is_private: true, outbound: 'direct' },

    // ⑤ 规则档才做国内直连；global / direct 档由上面的守卫接管
    ...(directRules
      ? [...(ruleSetPaths['geoip-cn'] ? [{ process_name: processNames, ...cnMatch, outbound: 'direct' }, { process_name: processNames, action: 'resolve' }] : []), ruleSetPaths['geoip-cn']
          ? { process_name: processNames, rule_set: 'geoip-cn', outbound: 'direct' }
          : { process_name: processNames, domain_suffix: FALLBACK_CN_SUFFIXES, outbound: 'direct' }]
      : []),

    // ⑥ 目标应用兜底 → 代理。
    //    应用分流末尾兜底；名单外不匹配，继续到与 final 等价的模式兜底。
    { process_name: processNames, outbound: SELECTOR_TAG },
  ];

  if (reverseApps) {
    // 先排除名单内应用，再应用站点规则，确保站点代理规则不能越过应用边界。
    const excluded = processNames.length ? [{ process_name: processNames, outbound: 'direct' }] : [];
    const general = buildRouteRules({ routingMode, ruleSetPaths, directRules, customRules });
    rules = [{ action: 'sniff' }, { protocol: 'dns', action: 'hijack-dns' },
      ...excluded, ...general.rules];
    dns.rules = [
      ...(processNames.length ? [{ process_name: processNames, server: 'local' }] : []),
      { clash_mode: 'direct', server: 'local' },
      ...custom.rules.filter(r => !r.process_name && !r.process_path && !r.ip_cidr)
        .map(({ outbound, ...match }) => ({ ...match, server: outbound === 'direct' ? 'local' : 'remote' })),
      { clash_mode: 'global', server: 'remote' },
      ...(directRules ? [{ ...cnMatch, server: 'local' }] : []),
    ];
    dns.final = 'remote';
  } else if (!processNames.length) {
    // 空名单：默认方向全部直连，反向方向全部进入规则分流。
    rules = [{ action: 'sniff' }, { protocol: 'dns', action: 'hijack-dns' }];
    dns.rules = [];
  }

  // mixed-in 是节点诊断专用入口，不携带原始应用身份。它必须绕过应用、
  // 模式及自定义直连规则，失败只能体现为代理失败，不能被直连成功掩盖。
  rules.unshift({ inbound: ['mixed-in'], outbound: SELECTOR_TAG });
  dns.rules.unshift({ inbound: ['mixed-in'], server: 'remote' });
  // Keep all Clash modes discoverable even after the empty-list rewrite.
  // These terminal routes exactly match final; earlier process/site/mixed
  // decisions retain precedence. No fake "never-matching" domains are needed.
  const finalOutbound = reverseApps ? SELECTOR_TAG : 'direct';
  rules.push(...ROUTING_MODES.map(clash_mode => ({ clash_mode, outbound: finalOutbound })));

  // rule_set 在 route 下统一声明；DNS 规则引用了 geosite-cn，所以即便路由规则没用它也要声明
  const ruleSet = [];
  if (ruleSetPaths['geoip-cn']) {
    ruleSet.push({ tag: 'geoip-cn', type: 'local', format: 'binary', path: ruleSetPaths['geoip-cn'] });
  }
  if (ruleSetPaths['geosite-cn']) {
    ruleSet.push({ tag: 'geosite-cn', type: 'local', format: 'binary', path: ruleSetPaths['geosite-cn'] });
  }

  const config = {
    log: { level: 'info', timestamp: true },
    dns,
    experimental: {
      clash_api: { external_controller: clashApi, default_mode: routingMode },
      cache_file: { enabled: true },
    },
    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
        auto_route: true,
        strict_route: strictRoute,
        // 明确排除内网网段，避免局域网设备被卷进来
        route_exclude_address: ['192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', 'fc00::/7'],
      },
      // 调试口：不经过 TUN，手动 curl 验证节点本身是否可用
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: debugPort,
      },
    ],
    outbounds,
    route: {
      // 必须开：让出站连接绑定默认网卡，否则 TUN 下形成路由环路
      auto_detect_interface: true,
      // sing-box 1.12+ 要求显式指定域名解析器；1.14 起缺失会直接拒绝启动
      default_domain_resolver: 'local',
      rules,
      // 默认其余直连；反向时名单内已排除，其余进入代理分流
      final: finalOutbound,
    },
  };
  if (ruleSet.length) config.route.rule_set = ruleSet;

  return {
    config,
    processNames,
    routingMode,
    // 非法自定义规则绝不静默丢弃 —— 交由调用方提示用户
    customErrors: custom.errors,
    customCount: custom.count,
  };
}
