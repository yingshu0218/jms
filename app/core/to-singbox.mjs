import { validateNode } from './node-schema.mjs';
// 配置生成层：节点对象 → sing-box config.json
//
// 字段名以官方文档为准：
//   VLESS outbound  https://sing-box.sagernet.org/configuration/outbound/vless/
//   TLS / Reality   https://sing-box.sagernet.org/configuration/shared/tls/#outbound
//   TUN inbound     https://sing-box.sagernet.org/configuration/inbound/tun/
//   Selector        https://sing-box.sagernet.org/configuration/outbound/selector/
//   DNS             https://sing-box.sagernet.org/configuration/dns/
//   DNS 规则        https://sing-box.sagernet.org/configuration/dns/rule/
//
// 三个设计要点：
//   ① 每个节点都是独立出站，前面套一个 selector —— 切节点不必重连内核，且可逐个测速
//   ② 三档路由模式（规则/全局/直连）用 clash_mode 规则实现 —— 可热切换，不必重连
//   ③ **DNS 必须独立配置且做分流** —— 否则"国内站点直连但 DNS 走远端"会导致就近解析失效

import { customRulesToRouteRules } from './custom-rules.mjs';

function tlsToSingbox(tls) {
  if (!tls || !tls.enabled) return undefined;
  const out = { enabled: true };
  if (tls.server_name) out.server_name = tls.server_name;
  if (tls.insecure) out.insecure = true;
  if (tls.alpn && tls.alpn.length) out.alpn = tls.alpn;
  if (tls.utls && tls.utls.enabled !== false) out.utls = { enabled: true, fingerprint: tls.utls.fingerprint || 'chrome' };
  if (tls.reality && tls.reality.enabled) {
    out.reality = {
      enabled: true,
      public_key: tls.reality.public_key,
      short_id: tls.reality.short_id ?? '',
    };
    // Xray 的 spiderX(spx) 在 sing-box 中**没有**对应字段，生成了会被内核拒载
  }
  return out;
}

function transportToSingbox(node) {
  if (node.ws) {
    const t = { type: 'ws', path: node.ws.path || '/' };
    if (node.ws.host) t.headers = { Host: node.ws.host };
    return t;
  }
  if (node.grpc) return { type: 'grpc', service_name: node.grpc.service_name || '' };
  return undefined;
}

/** 单个节点 → sing-box outbound */
export function nodeToOutbound(node, tag = 'proxy') {
  node = validateNode(node);
  const base = { tag, server: node.server, server_port: node.server_port };

  switch (node.type) {
    case 'vless': {
      const out = { type: 'vless', ...base, uuid: node.uuid };
      if (node.flow) out.flow = node.flow;
      const tls = tlsToSingbox(node.tls);
      if (tls) out.tls = tls;
      const tr = transportToSingbox(node);
      if (tr) out.transport = tr;
      return out;
    }
    case 'vmess': {
      const out = {
        type: 'vmess',
        ...base,
        uuid: node.uuid,
        security: node.cipher && node.cipher !== 'auto' ? node.cipher : 'auto',
        alter_id: node.alter_id ?? 0,
      };
      const tls = tlsToSingbox(node.tls);
      if (tls) out.tls = tls;
      const tr = transportToSingbox(node);
      if (tr) out.transport = tr;
      return out;
    }
    case 'shadowsocks':
      return { type: 'shadowsocks', ...base, method: node.method, password: node.password };
    case 'trojan': {
      const out = { type: 'trojan', ...base, password: node.password };
      const tls = tlsToSingbox(node.tls);
      out.tls = tls || { enabled: true };
      const tr = transportToSingbox(node);
      if (tr) out.transport = tr;
      return out;
    }
    default:
      throw new Error(`暂不支持的节点类型: ${node.type}`);
  }
}

export const SELECTOR_TAG = 'proxy';
export const ROUTING_MODES = ['rule', 'global', 'direct'];
const RESERVED_TAGS = new Set([SELECTOR_TAG, 'direct', 'block', 'dns-out']);

/** 节点名 → 合法且唯一的出站标签（节点名是用户数据，可能重复或撞保留字） */
export function tagsForNodes(nodes) {
  const used = new Set();
  return nodes.map((n) => {
    let base = String(n.name ?? '').trim() || `${n.server}:${n.server_port}`;
    if (RESERVED_TAGS.has(base)) base = `${base}-node`;
    let tag = base;
    let i = 2;
    while (used.has(tag)) tag = `${base} #${i++}`;
    used.add(tag);
    return tag;
  });
}

/** 生成全部出站：selector + 每个节点 + direct */
export function buildOutbounds(nodes, selected = 0, { selectorTag = SELECTOR_TAG } = {}) {
  nodes = nodes.map(validateNode);
  const tags = tagsForNodes(nodes);
  const nodeOutbounds = nodes.map((n, i) => nodeToOutbound(n, tags[i]));
  const def = tags[Math.max(0, Math.min(selected, tags.length - 1))];
  return {
    outbounds: [
      { type: 'selector', tag: selectorTag, outbounds: tags, default: def },
      ...nodeOutbounds,
      { type: 'direct', tag: 'direct' },
    ],
    tags,
  };
}

/** 生成前的自检：宁可在这里报错，也不要生成一份连不上的配置 */
export function validateOutbound(out) {
  const problems = [];
  if (!out.server) problems.push('server 为空');
  if (!out.server_port || Number.isNaN(out.server_port)) problems.push('server_port 无效');
  if (out.type === 'vless' || out.type === 'vmess') {
    if (!/^[0-9a-fA-F-]{36}$/.test(String(out.uuid || ''))) {
      problems.push('uuid 格式无效');
    }
  }
  if (out.type === 'vless' && out.tls && out.tls.reality && out.tls.reality.enabled) {
    const pk = out.tls.reality.public_key;
    if (!pk) problems.push('Reality 缺少 public_key');
    else if (!/^[A-Za-z0-9_+/=-]{42,46}$/.test(pk)) {
      problems.push('public_key 不是合法 base64，内核会报 invalid public_key');
    }
    if (!out.tls.utls) problems.push('Reality 建议启用 utls（fp 参数）');
  }
  return problems;
}

/**
 * 内置兜底分流规则。
 * 只在「规则集文件未就绪」时使用 —— 宁可分流失准（少数国内站点多绕一圈），
 * 也不能让内核因为下载规则集失败而退出。完整规则集由 engine/rulesets.mjs 预先缓存到本地。
 */
export const FALLBACK_CN_SUFFIXES = [
  '.cn',
  'baidu.com', 'qq.com', 'taobao.com', 'tmall.com', 'aliyun.com', 'alipay.com', 'jd.com',
  'bilibili.com', 'weibo.com', '163.com', 'zhihu.com', 'douyin.com', 'tencent.com',
  'csdn.net', 'cnblogs.com', '12306.cn', 'mi.com', 'huawei.com', 'xiaohongshu.com',
];

/**
 * ★ DNS 配置 —— 这是「国内网站不抖动」的关键，也是很多客户端做错的地方。
 *
 * 为什么必须独立配置 DNS：**DNS 查询路径和连接路径是两件独立的事**。
 * 路由规则决定"连接走直连"，但不决定"域名由谁解析"。如果国内域名也交给远端解析器：
 *   ① 就近 CDN 解析失效 —— 会返回靠近解析器（境外）的边缘节点，
 *      于是 TCP 明明直连、却连到一个很远的 IP，延迟高且忽高忽低
 *   ② 每次解析多一个跨境往返，缓存过期后表现为"偶尔卡一下"
 *   ③ 连接直连 + DNS 跨境，两条路径不一致 → 时延基线完全跑偏
 *
 * 官方文档（https://sing-box.sagernet.org/configuration/dns/rule/）确认 DNS 规则支持
 * rule_set / domain_suffix / clash_mode / outbound，并可指定 `server` 指向某个解析器。
 *
 * @param opts.routingMode  三档模式；直接影响兜底解析器
 * @param opts.ruleSetPaths 已缓存到本地的规则集路径，用于把国内域名判定为本地解析
 * @param opts.localDns     'system'（用系统解析器，就近解析最准）或具体 DNS 地址
 * @param opts.processNames 进程级模式下，只把这些进程的解析送远端
 */
export function buildDnsConfig({
  routingMode = 'rule',
  ruleSetPaths = {},
  localDns = 'system',
  remoteDns = 'https://1.1.1.1/dns-query',
  processNames = null,
} = {}) {
  // `type: "local"` 使用系统解析器（sing-box 1.12+），
  // 这是对「国内域名就近解析」最准确的选项 —— 它沿用你 ISP 的解析结果。
  const localServer = localDns && localDns !== 'system'
    ? { tag: 'local', type: 'udp', server: localDns }
    : { tag: 'local', type: 'local' };

  const doh = new URL(remoteDns.includes('://') ? remoteDns : `https://${remoteDns}/dns-query`);
  if (doh.protocol !== 'https:' || doh.username || doh.password || doh.hash) throw new Error('远端 DNS 需要有效的 HTTPS 地址');
  const servers = [
    localServer,
    { tag: 'remote', type: 'https', server: doh.hostname.replace(/^\[|\]$/g, ''), server_port: Number(doh.port || 443), path: doh.pathname + doh.search, domain_resolver: 'local', detour: SELECTOR_TAG },
  ];

  const rules = [];

  // 进程级模式：只把目标应用的解析送远端，其余一律本地
  if (processNames?.length) {
    rules.push({ process_name: processNames, server: 'remote' });
  }

  // ★ 国内域名一律本地解析 —— 保证就近 CDN。这一条缺失就会出现"直连但很慢/很抖"
  if (ruleSetPaths['geosite-cn']) {
    rules.push({ rule_set: 'geosite-cn', server: 'local' });
  } else {
    rules.push({ domain_suffix: FALLBACK_CN_SUFFIXES, server: 'local' });
  }

  // 模式感知：直连档全部本地解析；全局档保留上面的国内 DNS 就近解析例外。
  rules.push({ clash_mode: 'direct', server: 'local' });
  rules.push({ clash_mode: 'global', server: 'remote' });

  // 默认是 rule 档的远端兜底；direct 由运行时守卫处理，不能绑定冷启动档位。
  const final = 'remote';

  return { servers, rules, final, strategy: 'prefer_ipv4' };
}

/**
 * 生成路由规则。三档模式通过 clash_mode 实现（可热切换，不必重连内核）：
 *   rule   —— 国内直连，其余走代理
 *   global —— 全部走代理
 *   direct —— 全部直连（客户端保持运行，但不出代理）
 */
export function buildRouteRules({
  routingMode = 'rule',
  ruleSetPaths = {},
  directRules = true,
  selectorTag = SELECTOR_TAG,
  customRules = [],
} = {}) {
  const rules = [];
  const ruleSet = [];

  // ① 直连档守卫放最前：用户显式选择"不使用代理"时，连自定义规则也不该翻盘
  rules.push({ clash_mode: 'direct', outbound: 'direct' });

  // ② 自定义规则 —— 用户意图优先于内置地理库
  const custom = customRulesToRouteRules(customRules);
  rules.push(...custom.rules);

  // ③ 全局档守卫
  rules.push({ clash_mode: 'global', outbound: selectorTag });

  rules.push({ ip_is_private: true, outbound: 'direct' });

  // rule 档才做国内直连；global / direct 档由上面的守卫接管
  if (directRules) {
    if (ruleSetPaths['geoip-cn']) {
      rules.push(ruleSetPaths['geosite-cn'] ? { rule_set: 'geosite-cn', outbound: 'direct' } : { domain_suffix: FALLBACK_CN_SUFFIXES, outbound: 'direct' });
      rules.push({ action: 'resolve' });
      rules.push({ rule_set: 'geoip-cn', outbound: 'direct' });
      ruleSet.push({ tag: 'geoip-cn', type: 'local', format: 'binary', path: ruleSetPaths['geoip-cn'] });
    } else {
      rules.push({ domain_suffix: FALLBACK_CN_SUFFIXES, outbound: 'direct' });
    }
  }

  // DNS 规则要引用 geosite-cn，所以规则集声明要一并放进来（rule_set 在 route 下统一声明）
  if (ruleSetPaths['geosite-cn']) {
    ruleSet.push({ tag: 'geosite-cn', type: 'local', format: 'binary', path: ruleSetPaths['geosite-cn'] });
  }

  // customErrors 交由调用方提示用户 —— 非法规则绝不静默丢弃
  return { rules, ruleSet, customErrors: custom.errors, customCount: custom.count };
}

/**
 * 生成完整 sing-box 配置
 * @param {object[]} nodes 节点数组
 * @param {object} opts
 *   port         本地混合代理端口（系统代理指向它）
 *   clashApi     内核的 Clash API 地址，用于测速/状态/切换节点/切换模式
 *   selected     选中的节点索引
 *   routingMode  'rule' | 'global' | 'direct'
 *   ruleSetPaths 本地规则集路径 { 'geoip-cn': path, 'geosite-cn': path }
 */
export function buildConfig(nodes, opts = {}) {
  const {
    port = 2080,
    clashApi = '127.0.0.1:9090',
    selected = 0,
    routingMode = 'rule',
    directRules = true,
    ruleSetPaths = {},
    localDns = 'system',
    remoteDns = 'https://1.1.1.1/dns-query',
    customRules = [],
  } = opts;

  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('没有可用节点');
  if (selected < 0 || selected >= nodes.length) throw new Error(`selected 越界: ${selected}`);
  if (!ROUTING_MODES.includes(routingMode)) throw new Error(`未知的路由模式: ${routingMode}`);

  const { outbounds } = buildOutbounds(nodes, selected);
  const { rules, ruleSet } = buildRouteRules({ routingMode, ruleSetPaths, directRules, customRules });

  const config = {
    log: { level: 'info', timestamp: true },
    dns: buildDnsConfig({ routingMode, ruleSetPaths, localDns, remoteDns }),
    experimental: {
      clash_api: { external_controller: clashApi, default_mode: routingMode },
      cache_file: { enabled: true },
    },
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: port,
      },
    ],
    outbounds,
    route: {
      // ★ 一旦配置了 dns 段，sing-box 1.12+ 就要求显式指定域名解析器；
      // 1.14 起缺失会**直接拒绝启动**（实测 FATAL: missing `route.default_domain_resolver`）。
      default_domain_resolver: 'local',
      rules,
      final: SELECTOR_TAG,
    },
  };
  if (ruleSet.length) config.route.rule_set = ruleSet;

  return config;
}
