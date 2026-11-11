import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, ROUTING_MODES } from '../core/to-singbox.mjs';
import { buildTunPerAppConfig } from '../core/per-app.mjs';
const nodes = [{ type: 'vless', name: 'fixture', server: '127.0.0.1', server_port: 1, uuid: '11111111-2222-3333-4444-555555555555' }];
// v1.14.3 CalculateModeList derives available modes from rule references plus
// default_mode, not an implicit universal Rule/Global/Direct list. Walk nested
// logical rules as well so this assertion covers future configuration changes.
function availableModes(config) {
  const modes = new Set([config.experimental.clash_api.default_mode.toLowerCase()]);
  const visit = rules => { for (const rule of rules || []) {
    if (rule.clash_mode) modes.add(rule.clash_mode.toLowerCase());
    visit(rule.rules);
  } };
  visit(config.route.rules); visit(config.dns.rules);
  return [...modes].sort();
}
const variants = [
  {}, { directRules: false },
  { customRules: [{ type: 'domain_suffix', value: 'fixture.invalid', outbound: 'direct' }] },
  { ruleSetPaths: { 'geoip-cn': '/fixture/ip.srs', 'geosite-cn': '/fixture/site.srs' } },
  { directRules: false, ruleSetPaths: { 'geosite-cn': '/fixture/site.srs' } },
];
for (const cold of ROUTING_MODES) for (const kind of ['sysproxy', 'positive', 'reverse']) {
  test(`mode-list complete: ${kind}, cold=${cold}, empty/nonempty and options matrix`, () => {
    for (const apps of [[], ['chrome']]) for (const variant of variants) {
      const options = { routingMode: cold, platform: 'darwin', apps, reverseApps: kind === 'reverse', ...variant };
      const config = kind === 'sysproxy' ? buildConfig(nodes, options) : buildTunPerAppConfig(nodes, options).config;
      assert.deepEqual(availableModes(config), ['direct', 'global', 'rule']);
      // Terminal declarations are real fallback routes, never fake-domain
      // sentinels. They must be semantically identical to the existing final.
      assert.deepEqual(config.route.rules.slice(-3), ROUTING_MODES.map(clash_mode => ({ clash_mode, outbound: config.route.final })));
      if (kind !== 'sysproxy') assert.deepEqual(config.route.rules[0], { inbound: ['mixed-in'], outbound: 'proxy' });
    }
  });
}
