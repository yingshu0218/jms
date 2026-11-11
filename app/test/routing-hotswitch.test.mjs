import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, ROUTING_MODES } from '../core/to-singbox.mjs';
import { buildTunPerAppConfig } from '../core/per-app.mjs';

const nodes = [{ type: 'vless', name: 'fixture', server: '192.0.2.10', server_port: 443, uuid: '11111111-2222-3333-4444-555555555555' }];
const builders = {
  sysproxy: opts => buildConfig(nodes, opts),
  positive: opts => buildTunPerAppConfig(nodes, { platform: 'darwin', processNames: ['Fixture'], ...opts }).config,
  reverse: opts => buildTunPerAppConfig(nodes, { platform: 'darwin', processNames: ['Fixture'], reverseApps: true, ...opts }).config,
};
for (const [name, build] of Object.entries(builders)) {
  for (const ruleSetPaths of [{}, { 'geoip-cn': '/fixture/ip.srs', 'geosite-cn': '/fixture/site.srs' }]) {
    test(`${name}: every directed hot switch retains cold-target route and DNS structure (${Object.keys(ruleSetPaths).length} sets)`, () => {
      for (const from of ROUTING_MODES) for (const to of ROUTING_MODES) {
        const source = build({ routingMode: from, ruleSetPaths });
        const target = build({ routingMode: to, ruleSetPaths });
        assert.deepEqual(source.route, target.route, `${from} -> ${to} route`);
        assert.deepEqual(source.dns, target.dns, `${from} -> ${to} DNS`);
      }
    });
  }
  test(`${name}: initial controller mode is explicit`, () => {
    for (const routingMode of ROUTING_MODES)
      assert.equal(build({ routingMode }).experimental.clash_api.default_mode, routingMode);
  });
}
for (const reverseApps of [false, true]) for (const apps of [[], ['antigravity']]) {
  test(`TUN diagnostic inbound is selector-only before process/mode guards: reverse=${reverseApps}, apps=${apps.length}`, () => {
    for (const routingMode of ROUTING_MODES) {
      const config = buildTunPerAppConfig(nodes, { platform: 'darwin', apps, reverseApps, routingMode }).config;
      assert.deepEqual(config.route.rules[0], { inbound: ['mixed-in'], outbound: 'proxy' });
      assert.deepEqual(config.dns.rules[0], { inbound: ['mixed-in'], server: 'remote' });
      const selector = config.outbounds.find(o => o.tag === 'proxy');
      assert.ok(!selector.outbounds.includes('direct'), 'a failed diagnostic node must not fall back to direct');
    }
  });
}

// These are rule-selection assertions, not a substitute for running sing-box.
function dnsServer(config, { mode, domestic, process = 'Fixture', inbound = 'tun-in' }) {
  for (const rule of config.dns.rules) {
    if (rule.inbound && !rule.inbound.includes(inbound)) continue;
    if (rule.process_name && !rule.process_name.includes(process)) continue;
    if (rule.clash_mode && rule.clash_mode !== mode) continue;
    if ((rule.rule_set || rule.domain_suffix) && !domestic) continue;
    return rule.server;
  }
  return config.dns.final;
}
for (const [name, build] of Object.entries(builders)) {
  test(`${name}: DNS mode semantics survive all cold starts`, () => {
    for (const cold of ROUTING_MODES) for (const mode of ROUTING_MODES) {
      const config = build({ routingMode: cold });
      // Reverse lists exclude Fixture, so use a nonexcluded process there.
      const process = name === 'reverse' ? 'Other' : 'Fixture';
      assert.equal(dnsServer(config, { mode, domestic: false, process }), mode === 'direct' ? 'local' : 'remote');
      // Preserve existing policy: sysproxy/positive TUN keep domestic CDN DNS
      // local even in global; reverse TUN uses remote for global eligible apps.
      assert.equal(dnsServer(config, { mode, domestic: true, process }), name === 'reverse' && mode === 'global' ? 'remote' : 'local');
      if (name !== 'sysproxy') {
        const excluded = name === 'reverse' ? 'Fixture' : 'Other';
        assert.equal(dnsServer(config, { mode, domestic: false, process: excluded }), 'local');
        assert.equal(dnsServer(config, { mode, domestic: true, process: excluded, inbound: 'mixed-in' }), 'remote');
      }
    }
  });
}
