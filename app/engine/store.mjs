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
    if (['__proto__', 'constructor', 'prototype'].includes(k)) throw new Error('不支持的状态字段');
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] || {}, v) : v;
  }
  return out;
}

export class Store {
  constructor(dir = DEFAULT_DIR, { fileIO = {} } = {}) {
    this.fileIO = { readFile: readFileSync, writeFile: writeFileSync, chmod: chmodSync, rename: renameSync, ...fileIO };
    this.revision = 0;
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
    let raw;
    try { raw = this.fileIO.readFile(this.file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return empty();
      throw Object.assign(new Error('读取本地状态失败，原文件未被重命名或覆盖'), { code: 'STORAGE_READ_FAILED', cause: error });
    }
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('状态根对象无效');
      const state = merge(empty(), value);
      if (!Array.isArray(state.profiles) || !state.subscription || !Array.isArray(state.subscription.nodes)) throw new Error('状态结构无效');
      if (!state.profiles.length && state.subscription.url) {
        state.activeProfileId = 'legacy';
        state.profiles = [{ ...state.subscription, id: 'legacy', name: '原有订阅', selected: state.settings.selected }];
      }
      state.version = 2;
      return state;
    } catch (error) {
      // 只把确有语法/结构损坏的内容保留为corrupt；权限/IO错误不冒充空配置。
      try { this.fileIO.rename(this.file, `${this.file}.corrupt`); }
      catch (failure) { throw Object.assign(new Error('无法保留损坏状态，未创建空配置'), { code: 'STORAGE_READ_FAILED', cause: failure }); }
      return empty();
    }
  }

  /** 原子写：先写临时文件再 rename，崩溃也不会留下半个 JSON */
  write(patch) {
    // Candidate与调用者均不别名；任何落盘步骤失败都不得交换内存版本。
    const candidate = patch ? merge(this.state, patch) : this.state;
    const payload = JSON.stringify(candidate, null, 2);
    const next = JSON.parse(payload);
    try {
      this.fileIO.writeFile(this.tmp, payload, { mode: 0o600 });
      this.fileIO.chmod(this.tmp, 0o600);
      this.fileIO.rename(this.tmp, this.file);
    } catch (error) {
      try { rmSync(this.tmp, { force: true }); } catch { /* 不隐藏原始失败 */ }
      error.persistenceFailure = true;
      throw error;
    }
    this.state = next;
    this.revision++;
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
        nodes: s.subscription.nodes.map((value, index) => {
          const n = value && typeof value === 'object' ? value : {};
          return {
          name: typeof n.name === 'string' ? n.name.slice(0, 256) : `无效节点 ${index + 1}`,
          type: typeof n.type === 'string' ? n.type : 'invalid',
          server: typeof n.server === 'string' ? n.server.slice(0, 253) : '',
          server_port: Number.isSafeInteger(n.server_port) ? n.server_port : 0,
          security: ['none', 'tls', 'reality'].includes(n.security) ? n.security : (n.tls?.enabled === true ? 'tls' : 'none'),
          flow: typeof n.flow === 'string' && n.flow === 'xtls-rprx-vision' ? n.flow : null,
          transport: n.ws ? 'ws' : n.grpc ? 'grpc' : 'tcp',
        }; }),
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
