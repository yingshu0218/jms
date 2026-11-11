import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateCustomRule,
  normalizeCustomRules,
  customRulesToRouteRules,
  CUSTOM_RULE_TYPES,
} from '../core/custom-rules.mjs';
import { buildConfig, buildRouteRules, SELECTOR_TAG } from '../core/to-singbox.mjs';
import { parseSubscription } from '../core/parse.mjs';
import { acquireLock } from '../engine/lock.mjs';
import { Store } from '../engine/store.mjs';
import { SAMPLE_PLAIN } from './sample.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'jms-rules-'));
const nodes = () => parseSubscription(SAMPLE_PLAIN).nodes;

// ══════════════════ 规则校验 ══════════════════

test('规则校验：接受全部受支持的匹配类型', () => {
  for (const { type } of CUSTOM_RULE_TYPES) {
    const hint = CUSTOM_RULE_TYPES.find((t) => t.type === type).hint;
    const sample = /例：(.*)$/.exec(hint)[1];
    const { rule, error } = validateCustomRule({ type, value: sample, outbound: 'proxy' });
    assert.ok(rule, `${type} 应通过校验，实际报错：${error}`);
    assert.equal(rule.type, type);
  }
});

test('规则校验：非法输入必须给出可读原因（不能静默丢弃）', () => {
  const cases = [
    [{ type: 'nope', value: 'x', outbound: 'proxy' }, /不支持的匹配类型/],
    [{ type: 'domain', value: '   ', outbound: 'proxy' }, /不能为空/],
    [{ type: 'domain', value: 'x'.repeat(600), outbound: 'proxy' }, /过长/],
    [{ type: 'domain', value: 'a.com', outbound: 'sideways' }, /出站只能是/],
    [{ type: 'domain_regex', value: '([', outbound: 'proxy' }, /正则表达式无效/],
    [{ type: 'ip_cidr', value: 'not-an-ip', outbound: 'proxy' }, /IP 网段无效/],
    [{ type: 'domain', value: '*.example.com', outbound: 'proxy' }, /不支持通配符/],
    [null, /不是对象/],
  ];
  for (const [input, re] of cases) {
    const { rule, error } = validateCustomRule(input);
    assert.equal(rule, undefined);
    assert.match(error, re, `输入 ${JSON.stringify(input)} 应报 ${re}`);
  }
});

test('规则归一化：剔除非法项并返回原因，去重', () => {
  const { rules, errors } = normalizeCustomRules([
    { type: 'domain', value: 'a.com', outbound: 'proxy' },
    { type: 'domain', value: 'a.com', outbound: 'proxy' }, // 重复
    { type: 'bogus', value: 'x', outbound: 'proxy' }, // 非法
    { type: 'ip_cidr', value: '10.0.0.0/8', outbound: 'direct' },
    { type: 'domain', value: 'off.com', outbound: 'proxy', enabled: false }, // 已停用
  ]);
  assert.equal(rules.length, 2);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => /重复/.test(e.error)));
  assert.ok(errors.some((e) => /不支持的匹配类型/.test(e.error)));
});

test('规则转换：生成正确的 sing-box 规则片段', () => {
  const out = customRulesToRouteRules([
    { type: 'domain_suffix', value: '.corp.internal', outbound: 'direct' },
    { type: 'process_name', value: 'Postman.exe', outbound: 'proxy' },
  ]);
  assert.equal(out.count, 2);
  assert.deepEqual(out.rules[0], { domain_suffix: ['.corp.internal'], outbound: 'direct' });
  assert.deepEqual(out.rules[1], { process_name: ['Postman.exe'], outbound: SELECTOR_TAG });
});

// ══════════════════ 优先级（本轮的核心设计） ══════════════════

test('★ 优先级：自定义规则排在模式守卫之间，用户意图优先于内置地理库', () => {
  const { rules } = buildRouteRules({
    routingMode: 'rule',
    ruleSetPaths: { 'geoip-cn': '/x.srs' },
    customRules: [{ type: 'domain_suffix', value: '.corp.internal', outbound: 'direct' }],
  });
  const iDirectGuard = rules.findIndex((r) => r.clash_mode === 'direct');
  const iCustom = rules.findIndex((r) => r.domain_suffix);
  const iGlobalGuard = rules.findIndex((r) => r.clash_mode === 'global');
  const iGeo = rules.findIndex((r) => r.rule_set === 'geoip-cn');

  assert.equal(iDirectGuard, 0, '直连档守卫必须在最前');
  assert.ok(iCustom > iDirectGuard && iCustom < iGlobalGuard, '自定义规则在直连守卫之后、全局守卫之前');
  assert.ok(iGeo > iCustom, '地理库规则排在自定义规则之后 —— 用户意图优先');
});

test('★ 优先级：自定义规则可以覆盖地理库的判定（国内域名也能强制走代理）', () => {
  const { rules } = buildRouteRules({
    routingMode: 'rule',
    ruleSetPaths: { 'geoip-cn': '/x.srs' },
    customRules: [{ type: 'domain_suffix', value: '.cn', outbound: 'proxy' }],
  });
  const iCustom = rules.findIndex((r) => r.domain_suffix);
  const iGeo = rules.findIndex((r) => r.rule_set === 'geoip-cn');
  assert.ok(iCustom < iGeo, '自定义规则先匹配 → 能覆盖国内直连的默认判定');
});

test('★ 优先级：显式选择「直连档」时，自定义的 proxy 规则也不翻盘', () => {
  const cfg = buildConfig(nodes(), {
    routingMode: 'direct',
    customRules: [{ type: 'domain', value: 'must-proxy.com', outbound: 'proxy' }],
  });
  assert.equal(cfg.route.rules[0].clash_mode, 'direct');
  assert.equal(cfg.route.rules[0].outbound, 'direct', '直连档守卫必须压过自定义规则');
});

test('全局档下自定义的 direct 规则仍然生效（有价值的逃生口）', () => {
  const { rules } = buildRouteRules({
    routingMode: 'global',
    customRules: [{ type: 'domain_suffix', value: '.corp.internal', outbound: 'direct' }],
  });
  const iCustom = rules.findIndex((r) => r.domain_suffix);
  const iGlobalGuard = rules.findIndex((r) => r.clash_mode === 'global');
  assert.ok(iCustom < iGlobalGuard, '全局档里也能为特定域名开直连');
});

test('非法规则不会进入生成的路由规则', () => {
  const { rules } = buildRouteRules({
    customRules: [
      { type: 'domain', value: 'ok.com', outbound: 'proxy' },
      { type: 'domain', value: '', outbound: 'proxy' },
    ],
  });
  const custom = rules.filter((r) => r.domain);
  assert.equal(custom.length, 1);
});

// ══════════════════ 存储与设置 ══════════════════

test('设置：customRules 有默认值且能持久化', () => {
  const dir = tmp();
  const s = new Store(dir);
  assert.deepEqual(s.state.settings.customRules, []);
  s.write({ settings: { customRules: [{ type: 'domain', value: 'a.com', outbound: 'proxy', id: 'x', enabled: true }] } });
  const again = new Store(dir);
  assert.equal(again.state.settings.customRules.length, 1);
  assert.equal(again.state.settings.customRules[0].value, 'a.com');
});

test('脱敏：自定义规则不含凭据，可以原样暴露给 UI', () => {
  const dir = tmp();
  const s = new Store(dir);
  s.write({ settings: { customRules: [{ type: 'domain', value: 'a.com', outbound: 'proxy', id: 'x', enabled: true }] } });
  const out = JSON.stringify(s.redacted());
  assert.ok(out.includes('a.com'));
  assert.ok(!/uuid|public_key|password/.test(out));
});

// ══════════════════ 单实例锁 ══════════════════

test('★ 单实例锁：第二个实例必须被拒绝，并告知占用者 PID', () => {
  const file = join(tmp(), 'app.lock');
  const a = acquireLock(file);
  assert.equal(a.ok, true);

  const b = acquireLock(file);
  assert.equal(b.ok, false, '同一进程重复获取也应被拒（锁属于已存活的持有者）');
  assert.equal(b.pid, process.pid);

  a.release();
  assert.equal(existsSync(file), false, '释放后锁文件应被删除');

  const c = acquireLock(file);
  assert.equal(c.ok, true);
  c.release();
});

test('★ 单实例锁：上次崩溃留下的陈旧锁应被接管，而不是永久卡住', () => {
  const file = join(tmp(), 'stale.lock');
  // 用一个几乎不可能存活的 PID 伪造"崩溃现场"
  writeFileSync(file, '999999999');
  const lock = acquireLock(file);
  assert.equal(lock.ok, true, '陈旧锁必须能接管，否则崩溃一次就再也起不来');
  assert.equal(lock.stalePid, 999999999);
  assert.equal(Number(readFileSync(file, 'utf8')), process.pid, '锁文件应改由自己持有');
  lock.release();
});

test('单实例锁：锁文件内容损坏时也能接管', () => {
  const file = join(tmp(), 'broken.lock');
  writeFileSync(file, 'not-a-pid');
  const lock = acquireLock(file);
  assert.equal(lock.ok, true);
  lock.release();
});

test('单实例锁：释放时不会误删别人的锁', () => {
  const file = join(tmp(), 'other.lock');
  const a = acquireLock(file);
  // 模拟被别的实例接管
  writeFileSync(file, '12345');
  a.release();
  assert.equal(existsSync(file), true, '不应删除不属于自己的锁');
  unlinkSync(file);
});

// 规则文件必须可往返，且非法文件不能部分覆盖已有设置。
import { rulesDocument, importRules } from '../core/custom-rules.mjs';
import { AppService } from '../engine/app.mjs';
import { MockAdapter } from '../engine/sysproxy/adapters.mjs';

test('规则文件：导出再导入保留顺序、ID、停用状态与所有匹配类型', () => {
  const input = CUSTOM_RULE_TYPES.map(({ type }, i) => ({
    type, value: type === 'ip_cidr' ? '10.0.0.0/8' : 'example.com',
    outbound: i % 2 ? 'direct' : 'proxy', id: `r${i}`, enabled: i !== 0,
  }));
  const doc = rulesDocument(input);
  assert.deepEqual(importRules(JSON.stringify(doc), [], 'replace').rules, input);
  assert.deepEqual(Object.keys(doc), ['format', 'version', 'rules']);
});

test('规则文件：追加保留原有优先级，重复项不覆盖原规则', () => {
  const old = [{ type: 'domain', value: 'a.com', outbound: 'direct', enabled: false }];
  const incoming = [...old, { type: 'domain', value: 'b.com', outbound: 'proxy' }];
  const result = importRules(JSON.stringify(incoming), old);
  assert.equal(result.imported, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.total, 2);
  assert.equal(result.rules[0].enabled, false);
  assert.equal(result.rules[1].value, 'b.com');
  assert.equal(importRules('\uFEFF[]', old, 'replace').total, 0);
});

test('规则文件：格式、版本、规则与导入方式均严格校验', () => {
  for (const input of ['oops', '{}', '{"format":"jms-rules","version":2,"rules":[]}',
    '{"format":"jms-rules","version":1,"rules":null}',
    '[{"type":"domain_regex","value":"(["}]',
    '[{"type":"domain","value":"a.com","enabled":"false"}]']) {
    assert.throws(() => importRules(input));
  }
  assert.throws(() => importRules('[]', [], 'unknown'));
});

test('规则文件：导入持久化；非法文件不改变任何规则或其他设置', async () => {
  const dir = tmp();
  const app = new AppService({ dir, adapter: new MockAdapter({ mode: 'off' }) });
  const input = [{ type: 'domain', value: 'a.com', outbound: 'direct' }];
  await app.importRules({ text: JSON.stringify(input), mode: 'replace' });
  const before = JSON.stringify(app.store.state);
  await assert.rejects(() => app.importRules({ text: JSON.stringify([...input, { type: 'invalid' }]), mode: 'replace' }));
  assert.equal(JSON.stringify(app.store.state), before);
  assert.deepEqual(new Store(dir).state.settings.customRules, app.exportRules().rules);
});

test('规则配置：应用名单和反向开关可往返，旧文件保留应用设置，非法设置原子拒绝', async () => {
  const app = new AppService({ dir: tmp(), adapter: new MockAdapter({ mode: 'off' }) });
  await app.updateSettings({ apps: ['chrome'], reverseApps: true });
  const doc = app.exportRules();
  await app.updateSettings({ apps: [], reverseApps: false });
  await app.importRules({ text: JSON.stringify(doc), mode: 'replace' });
  assert.deepEqual(app.store.state.settings.apps, ['chrome']);
  assert.equal(app.store.state.settings.reverseApps, true);
  await app.importRules({ text: '[]', mode: 'replace' });
  assert.equal(app.store.state.settings.reverseApps, true);
  const before = JSON.stringify(app.store.state);
  for (const patch of [{ apps: ['unknown'] }, { reverseApps: 'true' }]) {
    await assert.rejects(() => app.importRules({ text: JSON.stringify({ ...doc, ...patch }) }));
    assert.equal(JSON.stringify(app.store.state), before);
  }
});
