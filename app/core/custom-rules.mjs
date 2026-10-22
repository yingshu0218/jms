// 用户自定义分流规则
//
// 为什么需要它：靠 geoip/geosite 只能覆盖"大面上的国内网站"，
// 真实需求往往是很具体的 —— "这个内网域名别走代理"、"这个境外站点必须走代理"、
// "这个进程走直连"。没有自定义规则，"规则模式"就只是个预设，配不上这个名字。
//
// 规则优先级（这是本项目的明确设计，不是实现细节）：
//   1. 直连档守卫（clash_mode=direct 一律直连）—— 显式选择"不使用代理"时，自定义规则也不应翻盘
//   2. **自定义规则**（按用户书写顺序）—— 用户意图优先于内置的地理库
//   3. 全局档守卫（clash_mode=global 一律走代理）
//   4. 内网地址直连
//   5. 国内地址直连（仅规则档）
//   6. 兜底 → 代理

// 刻意不从 to-singbox.mjs 导入：to-singbox 要反向导入本模块，会形成循环依赖。
const SELECTOR_TAG = 'proxy';

/** 支持的匹配类型 —— 与 sing-box 路由规则字段一一对应 */
export const CUSTOM_RULE_TYPES = [
  { type: 'domain', label: '精确域名', hint: '例：example.com' },
  { type: 'domain_suffix', label: '域名后缀', hint: '例：.example.com' },
  { type: 'domain_keyword', label: '域名关键词', hint: '例：analytics' },
  { type: 'domain_regex', label: '域名正则', hint: '例：^.+\\.example\\.com$' },
  { type: 'ip_cidr', label: 'IP 网段', hint: '例：10.0.0.0/8' },
  { type: 'process_name', label: '进程名', hint: '例：Postman.exe' },
  { type: 'process_path', label: '进程路径', hint: '例：/usr/bin/curl' },
];

const TYPE_SET = new Set(CUSTOM_RULE_TYPES.map((t) => t.type));
const OUTBOUND_LABEL = { [SELECTOR_TAG]: 'proxy', direct: 'direct' };

/** 校验单条规则，返回 { rule } 或 { error } */
export function validateCustomRule(input) {
  if (!input || typeof input !== 'object') return { error: '规则不是对象' };
  const type = String(input.type ?? '').trim();
  const value = String(input.value ?? '').trim();
  const outbound = String(input.outbound ?? 'proxy').trim();

  if (!TYPE_SET.has(type)) return { error: `不支持的匹配类型: ${type || '(空)'}` };
  if (!value) return { error: '匹配内容不能为空' };
  if (value.length > 512) return { error: '匹配内容过长（上限 512 字符）' };
  if (outbound !== 'proxy' && outbound !== 'direct') return { error: `出站只能是 proxy 或 direct，收到 ${outbound}` };

  // 正则类规则先在本地编译一次，避免把坏正则交给内核（内核报错会导致启动失败）
  if (type === 'domain_regex') {
    try {
      new RegExp(value);
    } catch (e) {
      return { error: `正则表达式无效：${e.message}` };
    }
  }
  // IP 网段做一次粗校验
  if (type === 'ip_cidr') {
    const ok = /^[0-9a-fA-F:.]+\/\d{1,3}$/.test(value) || /^[0-9a-fA-F:.]+$/.test(value);
    if (!ok) return { error: `IP 网段格式可疑：${value}（例：10.0.0.0/8）` };
  }
  // 域名关键词不该带通配符（这是常见误用）
  if (type === 'domain' && value.includes('*')) {
    return { error: '精确域名不支持通配符，请改用「域名后缀」' };
  }

  return {
    rule: {
      id: String(input.id ?? '').trim() || `${type}:${value}:${outbound}`,
      type,
      value,
      outbound,
      enabled: input.enabled !== false,
    },
  };
}

/**
 * 批量校验，返回 { rules, errors }
 * 非法规则被剔除并返回原因 —— 绝不静默丢弃，否则用户会以为规则生效了。
 */
export function normalizeCustomRules(input = []) {
  const rules = [];
  const errors = [];
  const seen = new Set();

  for (const item of Array.isArray(input) ? input : []) {
    const { rule, error } = validateCustomRule(item);
    if (error) {
      errors.push({ input: item, error });
      continue;
    }
    if (rule.enabled === false) continue;
    const key = `${rule.type}|${rule.value}|${rule.outbound}`;
    if (seen.has(key)) {
      errors.push({ input: item, error: '与前面的规则重复，已忽略' });
      continue;
    }
    seen.add(key);
    rules.push(rule);
  }
  return { rules, errors };
}

/** 自定义规则 → sing-box 路由规则片段 */
export function customRulesToRouteRules(input = []) {
  const { rules, errors } = normalizeCustomRules(input);
  return {
    rules: rules.map((r) => ({ [r.type]: [r.value], outbound: r.outbound })),
    // 同一类型多条时可以合并，但保持原顺序对用户更可预测，因此不合并
    errors,
    count: rules.length,
  };
}

/** 出站标签 → 人类可读 */
export function outboundLabel(tag) {
  return OUTBOUND_LABEL[tag] || tag;
}

/** 可移植规则文件：保留顺序与停用状态，不包含订阅或节点。 */
export function rulesDocument(input) {
  if (!Array.isArray(input)) throw new Error('规则必须是数组');
  const rules = input.map((item, i) => {
    const { rule, error } = validateCustomRule(item);
    if (error) throw new Error(`第 ${i + 1} 条规则：${error}`);
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
      throw new Error(`第 ${i + 1} 条规则：enabled 必须是布尔值`);
    }
    return rule;
  });
  return { format: 'jms-rules', version: 1, rules };
}

export function importRules(text, current = [], mode = 'append') {
  if (!['append', 'replace'].includes(mode)) throw new Error('导入方式必须是追加或替换');
  let data;
  try { data = JSON.parse(String(text).replace(/^\uFEFF/, '')); }
  catch { throw new Error('规则文件不是合法 JSON'); }
  if (!Array.isArray(data) && (!data || data.format !== 'jms-rules' || data.version !== 1)) {
    throw new Error('不支持的规则文件格式或版本，请使用 JMS 导出的 JSON 文件');
  }
  const incoming = rulesDocument(Array.isArray(data) ? data : data.rules).rules;
  const base = mode === 'append' ? rulesDocument(current).rules : [];
  const seen = new Set(base.map(r => JSON.stringify([r.type, r.value, r.outbound])));
  const rules = [...base];
  let duplicates = 0;
  for (const rule of incoming) {
    const key = JSON.stringify([rule.type, rule.value, rule.outbound]);
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    rules.push(rule);
  }
  return { rules, imported: incoming.length - duplicates, duplicates, total: rules.length };
}
