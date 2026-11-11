import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCustomRule, rulesDocument, importRules } from '../core/custom-rules.mjs';
const validate = (type, value) => validateCustomRule({ type, value, outbound: 'proxy' });
test('CIDR rejects invalid IPv4, IPv6 and prefix ranges', () => {
  for (const value of ['999.1.2.3/24', '1.2.3.4/33', '::1/129', '12345::/64', '1:2:3:4:5:6:7:8:9', '1::2::3', 'abcd', '1.2.3', '01.2.3.4', '::ffff:999.1.2.3', '1.2.3.4/-1', '::/1.5'])
    assert.ok(validate('ip_cidr', value).error, value);
});
test('CIDR accepts valid literal families and boundary prefixes', () => {
  for (const value of ['0.0.0.0/0', '255.255.255.255/32', '192.0.2.1', '::/0', '::1/128', '2001:db8::/32', '1:2:3:4:5:6:7:8', '::ffff:192.0.2.1/128'])
    assert.ok(validate('ip_cidr', value).rule, value);
});
test('regex rejects non-RE2 constructs accepted by JavaScript and unsafe repetition', () => {
  for (const value of ['a(?=b)', 'a(?!b)', '(?<=a)b', '(?<!a)b', '(a)\\1', '(?<x>a)\\k<x>', '(?R)', '(?(1)a|b)', '(?>a)', 'a++', 'a{1001}', '\\u0041', '\\q'])
    assert.ok(validate('domain_regex', value).error, value);
});
test('regex supports common RE2 flags and named captures without JS-only rejection', () => {
  for (const value of ['(?i)^example\\.com$', '(?im-s:foo)', '(?P<name>foo)', '(?<name>foo)', '(?U)a+', '\\Afoo\\z', '[a-z0-9]+\\.example\\.com', 'a{1,1000}'])
    assert.ok(validate('domain_regex', value).rule, value);
});
test('rule document/import rejects entire invalid batch without mutating input', () => {
  const current = [{ type: 'domain', value: 'example.com', enabled: false }];
  const before = structuredClone(current);
  for (const bad of [{ type: 'ip_cidr', value: '999.0.0.0/8' }, { type: 'domain_regex', value: '(?=bad)' }]) {
    assert.throws(() => rulesDocument([...current, bad]));
    for (const mode of ['append', 'replace']) assert.throws(() => importRules(JSON.stringify([...current, bad]), current, mode));
    assert.deepEqual(current, before);
  }
});

test('rule schema rejects coercion and malformed object shapes atomically', () => {
  const valid = { type: 'domain', value: 'example.com' };
  const bad = [[], null, false, 'domain', ...['type', 'value', 'outbound', 'id'].flatMap(key =>
    [null, false, 1, {}, [], ['example.com']].map(value => ({ ...valid, [key]: value }))),
    ...[null, 0, 'false', {}, []].map(enabled => ({ ...valid, enabled }))];
  for (const input of bad) {
    assert.ok(validateCustomRule(input).error, JSON.stringify(input));
    assert.throws(() => rulesDocument([valid, input]));
    assert.throws(() => importRules(JSON.stringify([valid, input]), [valid]));
  }
  assert.equal(validateCustomRule(valid).rule.outbound, 'proxy');
  assert.equal(validateCustomRule(valid).rule.id, 'domain:example.com:proxy');
  assert.equal(validateCustomRule({ ...valid, id: '', enabled: false }).rule.enabled, false);
});
