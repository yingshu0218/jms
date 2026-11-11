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
  { type: 'domain_regex', label: '域名正则', hint: '受限 RE2 子集（不支持断言/反向引用）；例：^.+\\.example\\.com$' },
  { type: 'ip_cidr', label: 'IP 网段', hint: '例：10.0.0.0/8' },
  { type: 'process_name', label: '进程名', hint: '例：Postman.exe' },
  { type: 'process_path', label: '进程路径', hint: '例：/usr/bin/curl' },
];

const TYPE_SET = new Set(CUSTOM_RULE_TYPES.map((t) => t.type));
const OUTBOUND_LABEL = { [SELECTOR_TAG]: 'proxy', direct: 'direct' };

// Pure literal validation: no DNS, interfaces or platform-dependent parsing.
function ipv4(value) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every(p => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255);
}
function ipBits(value) {
  if (ipv4(value)) return 32;
  if (!value.includes(':') || !/^[0-9a-fA-F:.]+$/.test(value)) return 0;
  let text = value;
  if (text.includes('.')) {
    const index = text.lastIndexOf(':');
    if (!ipv4(text.slice(index + 1))) return 0;
    text = text.slice(0, index + 1) + '0:0';
  }
  const halves = text.split('::');
  if (halves.length > 2) return 0;
  const groups = halves.flatMap(h => h ? h.split(':') : []);
  if (!groups.every(g => /^[0-9a-fA-F]{1,4}$/.test(g))) return 0;
  return (halves.length === 2 ? groups.length < 8 : groups.length === 8) ? 128 : 0;
}

// Deliberately restricted RE2 syntax, NOT a JavaScript-to-RE2 equivalence claim.
// Permit ordinary groups/classes/quantifiers, Go flags and named captures. Reject
// everything outside this subset. The fixed sing-box config check remains final.
function validateRegexSubset(value) {
  let translated = '';
  let inClass = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\') {
      const next = value[++i];
      if (!next) throw new Error('末尾反斜杠');
      if ('Az'.includes(next) && !inClass) { translated += next === 'A' ? '^' : '$'; continue; }
      if (inClass && 'bB'.includes(next)) throw new Error('字符类内不支持词边界');
      if ('dDsSwWbBfnrt'.includes(next) || '\\.^$|?*+()[]{}-'.includes(next)) {
        // JS unicode mode disallows escaped '-' outside a class; literal is safe.
        translated += next === '-' && !inClass ? '-' : '\\' + next;
        continue;
      }
      if (next === 'x' && /^[0-9a-fA-F]{2}/.test(value.slice(i + 1))) {
        translated += value.slice(i - 1, i + 3); i += 2; continue;
      }
      throw new Error(`不支持转义 \\${next}（含反向引用、Unicode/八进制转义）`);
    }
    if (c === '[' && !inClass) {
      if (/^\[\^?\]/.test(value.slice(i))) throw new Error('空字符类不受支持');
      inClass = true; translated += c; continue;
    }
    if (c === ']' && inClass) { inClass = false; translated += c; continue; }
    if (inClass) {
      if (c === '[') throw new Error('暂不支持 POSIX 字符类或嵌套字符类');
      translated += c; continue;
    }
    if (c === '(' && value[i + 1] === '?') {
      const suffix = value.slice(i);
      const named = /^\(\?(?:P)?<([A-Za-z_][A-Za-z0-9_]*)>/.exec(suffix);
      const flags = /^\(\?([imsU]+(?:-[imsU]+)?|-[imsU]+)([:)])/.exec(suffix);
      if (named) { translated += '('; i += named[0].length - 1; continue; }
      if (flags) {
        translated += flags[2] === ':' ? '(?:' : '(?:)';
        i += flags[0].length - 1; continue;
      }
      if (suffix.startsWith('(?:')) { translated += '(?:'; i += 2; continue; }
      throw new Error('不支持断言、递归、条件、原子组等扩展');
    }
    if (c === '{') {
      const count = /^\{(\d+)(?:,(\d*))?\}/.exec(value.slice(i));
      if (!count || Number(count[1]) > 1000 || (count[2] && Number(count[2]) > 1000))
        throw new Error('重复次数须为 0–1000，字面花括号需要转义');
    }
    translated += c;
  }
  // Secondary structural check only, after the explicit subset filter above.
  new RegExp(translated, 'u');
}

/** 校验单条规则，返回 { rule } 或 { error } */
export function validateCustomRule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: '规则不是对象' };
  for (const key of ['type', 'value']) {
    if (typeof input[key] !== 'string') return { error: `${key} 必须是字符串` };
  }
  for (const key of ['outbound', 'id']) {
    if (key in input && typeof input[key] !== 'string') return { error: `${key} 必须是字符串` };
  }
  if ('enabled' in input && typeof input.enabled !== 'boolean') return { error: 'enabled 必须是布尔值' };
  const type = input.type.trim();
  const value = input.value.trim();
  const outbound = (input.outbound ?? 'proxy').trim();

  if (!TYPE_SET.has(type)) return { error: `不支持的匹配类型: ${type || '(空)'}` };
  if (!value) return { error: '匹配内容不能为空' };
  if (value.length > 512) return { error: '匹配内容过长（上限 512 字符）' };
  if (outbound !== 'proxy' && outbound !== 'direct') return { error: `出站只能是 proxy 或 direct，收到 ${outbound}` };

  if (type === 'domain_regex') {
    try { validateRegexSubset(value); }
    catch (e) { return { error: `正则表达式无效或超出受限 RE2 子集：${e.message}` }; }
  }
  if (type === 'ip_cidr') {
    const parts = value.split('/');
    const bits = ipBits(parts[0]);
    if (!bits || parts.length > 2 || (parts.length === 2 &&
        (!/^(0|[1-9][0-9]{0,2})$/.test(parts[1]) || Number(parts[1]) > bits))) {
      return { error: `IP 网段无效：${value}（IPv4 前缀 0–32，IPv6 前缀 0–128）` };
    }
  }
  // 域名关键词不该带通配符（这是常见误用）
  if (type === 'domain' && value.includes('*')) {
    return { error: '精确域名不支持通配符，请改用「域名后缀」' };
  }

  return {
    rule: {
      id: (input.id ?? '').trim() || `${type}:${value}:${outbound}`,
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
