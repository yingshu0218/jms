// 状态存储
// 设计要点：
//   ① 原子写（tmp + rename），避免崩溃时留下半个文件
//   ② 目录 0700 / 文件 0600 —— 里面是节点凭据
//   ③ 对外提供 redacted() —— API 和 UI **永远拿不到** uuid / 公钥 / 密码

import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_DIR = join(homedir(), '.config', 'jms-client');

const empty = () => ({
  version: 2,
  profiles: [],
  activeProfileId: null,
  subscription: {
    url: '',
    updatedAt: null,
    etag: null,
    lastError: null,
    nodes: [],
    lastChange: null, // {added, removed, changed}
  },
  settings: {
    selected: 0,
    mode: 'sysproxy', // sysproxy | tun-per-app
    port: 2080,
    clashApi: '127.0.0.1:9090',
    autoRefreshMinutes: 180,
    // 三档路由模式：rule（国内直连）| global（全部走代理）| direct（全部直连）
    routingMode: 'rule',
    // 国内解析器：'system' 用系统解析器（就近解析最准），也可填具体地址如 223.5.5.5
    localDns: 'system',
    remoteDns: 'https://1.1.1.1/dns-query',
    directRules: true,
    // 用户自定义分流规则：优先级高于内置地理库（见 core/custom-rules.mjs）
    customRules: [],
    apps: ['antigravity'],
    reverseApps: false,
  },
  runtime: {
    connected: false,
    startedAt: null,
    pid: null,
    restarts: 0,
    lastExit: null,
  },
});

function merge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] || {}, v) : v;
  }
  return out;
}

export class Store {
  constructor(dir = DEFAULT_DIR) {
    this.dir = dir;
    this.file = join(dir, 'state.json');
    this.logDir = join(dir, 'logs');
    this.tmp = join(dir, '.state.json.tmp');
    mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
      chmodSync(this.logDir, 0o700);
    } catch {
      /* Windows 上 chmod 语义不同，忽略 */
    }
    this.state = this.read();
  }

  read() {
    try {
      const raw = readFileSync(this.file, 'utf8');
      const state = merge(empty(), JSON.parse(raw));
      if (!state.profiles.length && state.subscription.url) {
        state.activeProfileId = 'legacy';
        state.profiles = [{ ...state.subscription, id: 'legacy', name: '原有订阅', selected: state.settings.selected }];
      }
      state.version = 2;
      return state;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // 损坏的状态文件：重命名保留现场，然后从空状态开始
        try {
          renameSync(this.file, `${this.file}.corrupt`);
        } catch {
          /* ignore */
        }
      }
      return empty();
    }
  }

  /** 原子写：先写临时文件再 rename，崩溃也不会留下半个 JSON */
  write(patch) {
    if (patch) this.state = merge(this.state, patch);
    writeFileSync(this.tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.tmp, 0o600);
    } catch {
      /* ignore */
    }
    renameSync(this.tmp, this.file);
    return this.state;
  }

  /** 给 API / UI 用的脱敏视图 —— 凭据一律不出现在这里 */
  redacted() {
    const s = this.state;
    return {
      ...s,
      profiles: s.profiles.map(p => ({ id: p.id, name: p.name, url: maskUrl(p.url), nodeCount: p.nodes.length, updatedAt: p.updatedAt, lastError: p.lastError || null, pendingUpdate: Boolean(p.pendingUpdate) })),
      subscription: {
        ...s.subscription,
        // 订阅链接本身就是凭据：只暴露主机名，方便用户辨认用的是哪一条
        url: s.subscription.url ? maskUrl(s.subscription.url) : '',
        hasUrl: Boolean(s.subscription.url),
        nodes: s.subscription.nodes.map((n) => ({
          name: n.name,
          type: n.type,
          server: n.server,
          server_port: n.server_port,
          security: n.security || (n.tls && n.tls.enabled ? 'tls' : 'none'),
          flow: n.flow || null,
          transport: n.ws ? 'ws' : n.grpc ? 'grpc' : 'tcp',
        })),
      },
    };
  }

  /** 已连接状态下的运行信息（内核不在状态文件里存 pid，避免重启后误判） */
  markRuntime(patch) {
    return this.write({ runtime: patch });
  }

  resetLogs() {
    rmSync(this.logDir, { recursive: true, force: true });
    mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
  }
}

/** 订阅链接脱敏：保留主机名，其余打码 */
export function maskUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname ? '/…' : ''}`;
  } catch {
    return '…';
  }
}

/** 节点指纹：只取非凭据字段，用于检测服务端参数轮换（换 IP/端口） */
export function nodeFingerprint(n) {
  return [n.type, n.server, n.server_port, n.security || '', n.network || '', n.flow || ''].join('|');
}

/** 节点去重键 */
export function nodeKey(n) {
  return `${n.type}|${n.server}:${n.server_port}|${n.name}`;
}
