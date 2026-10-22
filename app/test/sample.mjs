// 脱敏测试样本：地址用 TEST-NET（192.0.2.0/24，RFC 5737），UUID/公钥均为假值。
// 真实订阅链接**绝不**放进这个文件，也绝不提交到仓库。

const REALITY_LINK =
  'vless://11111111-2222-3333-4444-555555555555@192.0.2.10:443' +
  '?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome' +
  '&pbk=_U_s_AFlC1yYkKvCLd9mJflnfYP4Wd_zAdOXnkYNQyc&sid=0123abcd&spx=%2F' +
  '&type=tcp&flow=xtls-rprx-vision#JMS-s2-HK';

const REALITY_NO_SID_LINK =
  'vless://11111111-2222-3333-4444-555555555555@192.0.2.11:443' +
  '?encryption=none&security=reality&sni=www.apple.com&fp=chrome' +
  '&pbk=_U_s_AFlC1yYkKvCLd9mJflnfYP4Wd_zAdOXnkYNQyc&type=tcp&flow=xtls-rprx-vision#NoShortId';

const WS_TLS_LINK =
  'vless://66666666-7777-8888-9999-000000000000@192.0.2.12:443' +
  '?encryption=none&security=tls&sni=cdn.example.com&type=ws&host=cdn.example.com&path=%2Fws#Vless-WS';

const TROJAN_LINK = 'trojan://secret-password@192.0.2.13:443?sni=t.example.com&type=tcp#Trojan-Node';

const vmessJson = {
  v: '2',
  ps: 'VMess-WS',
  add: '192.0.2.14',
  port: '443',
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  aid: '0',
  scy: 'auto',
  net: 'ws',
  type: 'none',
  host: 'v.example.com',
  path: '/vm',
  tls: 'tls',
  sni: 'v.example.com',
};
const VMESS_LINK = 'vmess://' + Buffer.from(JSON.stringify(vmessJson), 'utf8').toString('base64');

const SS_LINK =
  'ss://' + Buffer.from('aes-256-gcm:my-ss-password', 'utf8').toString('base64') + '@192.0.2.15:8388#SS-Node';

export const SAMPLE_LINKS = [REALITY_LINK, REALITY_NO_SID_LINK, WS_TLS_LINK, TROJAN_LINK, VMESS_LINK, SS_LINK];

export const SAMPLE_PLAIN = SAMPLE_LINKS.join('\n');

export const SAMPLE_B64 = Buffer.from(SAMPLE_PLAIN, 'utf8').toString('base64');

// 故意缺 pbk 的 Reality 链接：用来验证「宁可报错，也不生成坏配置」
export const BROKEN_REALITY_LINK =
  'vless://11111111-2222-3333-4444-555555555555@192.0.2.99:443' +
  '?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&type=tcp#BrokenNoPbk';

export const SAMPLE_CLASH_YAML = `port: 7890
proxies:
  - {name: "Clash-Reality", type: vless, server: 192.0.2.20, port: 443, uuid: 11111111-2222-3333-4444-555555555555, network: tcp, tls: true, flow: xtls-rprx-vision, servername: www.microsoft.com, client-fingerprint: chrome, reality-opts: {public-key: "_U_s_AFlC1yYkKvCLd9mJflnfYP4Wd_zAdOXnkYNQyc", short-id: "0123abcd"}}
  - {name: "Clash-SS", type: ss, server: 192.0.2.21, port: 8388, cipher: aes-256-gcm, password: "clash-ss-pass"}
proxy-groups:
  - {name: PROXY, type: select, proxies: ["Clash-Reality"]}
`;
