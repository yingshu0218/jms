// 应用服务层：把 store / subscription / 配置生成 / 内核守护 / 系统代理 串成一个可用的客户端。
//
// 这一层不依赖 HTTP、也不依赖 Tauri —— 换个外壳它照样能用。
// （Tauri 集成时，Rust 侧只需把本文件当作 Node sidecar 的入口来调。）

import { withLatencyCore } from './latency-core.mjs';
import { prepareIsolatedDirectory } from './isolation.mjs';
import { validateSettings, CONFIG_FILENAMES } from '../core/settings.mjs';
import { ProfilesService } from './profiles.mjs';
import { EventEmitter, once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { assertPortsAvailable, assertListenerOwnership } from './ports.mjs';
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

import { Store } from './store.mjs';
import { fetchSubscription, diffNodes, summarizeChange, dedupeNodes } from './subscription.mjs';
import { ClashApi } from './clash-api.mjs';
import { CoreSupervisor, resolveCoreBinary } from './supervisor.mjs';
import { ProxyJournal, getAdapter, MockAdapter, enableProxy, disableProxy, healIfNeeded, isPointingAtUs } from './sysproxy/index.mjs';
import { parseSubscription } from '../core/parse.mjs';
import { buildConfig, buildOutbounds, SELECTOR_TAG, ROUTING_MODES } from '../core/to-singbox.mjs';
import { APP_PROFILES, buildTunPerAppConfig } from '../core/per-app.mjs';
import { ensureRuleSets } from './rulesets.mjs';
import { normalizeCustomRules, rulesDocument, importRules } from '../core/custom-rules.mjs';
import { runLinkCheck, DEFAULT_TARGETS } from './linkcheck.mjs';
import { checkTunPrivilege, needsElevation, planElevation, relaunchArguments } from './privilege.mjs';

export class AppService extends EventEmitter {
  constructor({ dir, coreBinary, adapter, clashApiFactory, latencyCoreRunner = withLatencyCore, isolated = false, controlPort = 7788, supervisorFactory, portsAvailable = assertPortsAvailable, ruleSetProvider = ensureRuleSets, listenerOwnership = assertListenerOwnership } = {}) {
    super();
    this.isolated = isolated;
    this.controlPort = controlPort;
    this.draining = false;
    this.portsAvailable = portsAvailable;
    this.ruleSetProvider = ruleSetProvider;
    this.listenerOwnership = listenerOwnership;
    this.supervisorFactory = supervisorFactory || (options => new CoreSupervisor(options));
    this.coreSecret = randomBytes(32).toString('hex');
    if (isolated) dir = prepareIsolatedDirectory(dir);
    this.store = new Store(dir);
    if (isolated) this.store.write({ settings: { port: 12080, clashApi: '127.0.0.1:19090' } });
    this.dir = this.store.dir;
    this.varDir = join(this.dir, 'run');
    mkdirSync(this.varDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.varDir, 0o700);
    } catch {
      /* ignore */
    }

    this.coreBinary = coreBinary || resolveCoreBinary();
    this.journal = new ProxyJournal(this.dir);
    // 隔离实例永远不使用宿主适配器，即使调用者误传真实适配器也不会接管系统设置。
    this.adapter = isolated ? new MockAdapter({ mode: 'off' }) : adapter || getAdapter(process.platform);
    this.clashApiFactory = clashApiFactory || ((url, options) => new ClashApi(url, options));

    this.supervisor = null;
    this.lastLatency = new Map();
    this.lastLatencyByTag = new Map();
    this.latencyCoreRunner = latencyCoreRunner;
    this.busy = null;
    this.profiles = new ProfilesService(this);
    if (isolated) this.profiles.fetchImpl = async (url, options) => {
      const target = new URL(url);
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password) throw new Error('隔离实例只接受本机测试订阅');
      return fetch(url, { ...options, redirect: 'error' });
    };
  }

  get busy() { return this._busy ?? null; }
  set busy(value) { this._busy = value; if (!value) this.emit('idle'); }

  assertMutable() {
    if (this.draining) throw Object.assign(new Error('引擎正在退出，暂停新操作'), { code: 'DRAINING' });
  }

  assertNetworkAllowed() {
    this.assertMutable();
    if (this.isolated) throw Object.assign(new Error('隔离实例禁止真实网络接管、提权、检测与测速'), { code: 'ISOLATED' });
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.draining = true;
    clearInterval(this.refreshTimer);
    this.shutdownPromise = (async () => {
      // 先停止接收新操作，再等待已进入的操作完成；取消 HTTP 不代表服务器已停止。
      if (this.busy) await once(this, 'idle', { signal: AbortSignal.timeout(120_000) });
      await this.disconnect();
      if (this.supervisor?.isRunning() || this.journal.isPending()) throw new Error('恢复尚未完成，保留引擎以便重试');
      return { ok: true };
    })();
    try { return await this.shutdownPromise; } finally { this.shutdownPromise = null; }
  }

  resume() {
    if (this.shutdownPromise || this.busy) throw new Error('恢复仍在执行，请稍后重试');
    this.draining = false;
    this.startAutoRefresh();
    return { ok: true };
  }

  validatedSettings(patch = this.store.state.settings) {
    const settings = validateSettings(patch);
    const apiPort = Number(settings.clashApi?.split(':').at(-1));
    if (settings.port === apiPort || settings.port === this.controlPort || apiPort === this.controlPort) throw new Error('代理、内核 API 和引擎 HTTP 端口必须不同');
    return settings;
  }

  // ── 状态 ───────────────────────────────────────────────────────────────
  apiClient() {
    const addr = (this.sessionSettings || this.store.state.settings).clashApi;
    return this.clashApiFactory(addr.startsWith('http') ? addr : `http://${addr}`, { secret: this.coreSecret });
  }

  async connections() {
    if (!this.supervisor?.isRunning()) return { running: false, connections: [], uploadTotal: 0, downloadTotal: 0 };
    const data = await this.apiClient().connections();
    if (!data || !Array.isArray(data.connections)) throw new Error('内核连接数据格式无效');
    return { running: true, connections: data.connections, uploadTotal: data.uploadTotal ?? 0, downloadTotal: data.downloadTotal ?? 0 };
  }

  async closeConnections({ id, all = false } = {}) {
    if (all !== true && (typeof id !== 'string' || !id.trim() || id.length > 256)) throw new Error('请选择要关闭的连接');
    if (!this.supervisor?.isRunning()) throw new Error('内核未运行，无法关闭连接');
    if (all === true) await this.apiClient().closeAllConnections();
    else await this.apiClient().closeConnection(id);
    return { ok: true };
  }

  /** 节点下标 → 出站标签（必须与配置生成用同一套规则，否则测速/切换会打不到） */
  nodeTags() {
    return buildOutbounds(this.store.state.subscription.nodes, 0).tags;
  }

  async status() {
    const s = this.store.state;
    const sup = this.supervisor?.status() || { running: false, pid: null, uptimeMs: 0, restarts: 0 };
    const pointingAtUs = await isPointingAtUs({ adapter: this.adapter, port: s.settings.port });
    return {
      ...sup,
      connected: s.runtime.connected && sup.running,
      mode: s.settings.mode,
      port: s.settings.port,
      node: s.subscription.nodes[s.settings.selected]?.name ?? null,
      nodeCount: s.subscription.nodes.length,
      pointingAtUs,
      pendingProxyJournal: this.journal.isPending(),
      coreBinary: this.coreBinary,
      busy: this.busy,
    };
  }

  /** 给 API / UI 的脱敏快照 */
  async snapshot() {
    return {
      ...this.store.redacted(),
      status: await this.status(),
      privilege: await this.privilegeStatus(),
      latency: Object.fromEntries(this.lastLatency),
      nodeLatency: Object.fromEntries(this.nodeTags().map((tag, i) => [String(i), this.lastLatencyByTag.get(tag)]).filter(([, result]) => result)) ,
      change: this.store.state.subscription.lastChange,
      linkCheck: this.lastLinkCheck || null,
    };
  }

  // ── 常用链接检测 ───────────────────────────────────────────────────────
  /**
   * 检测常用站点是否可达。
   *
   * **默认走本地代理端口** —— 这样测的是完整链路（本地入口 → 路由 → 出口节点 → 目标站），
   * 才能回答"我现在能不能上 Google"。直连检测只能说明机器有没有网，对这个客户端没有意义。
   *
   * 内核没运行时退化为直连检测，并在结果里标注 via:'direct'，
   * 让界面能如实提示"本次未经过代理" —— 不能让人误以为代理链路正常。
   */
  async checkLinks({ targets = DEFAULT_TARGETS, timeoutMs = 8000, diagnose = true } = {}) {
    this.assertNetworkAllowed();
    const running = Boolean(this.supervisor?.isRunning());
    const proxy = running ? { host: '127.0.0.1', port: Number(this.store.state.settings.port) } : null;
    if (!running) {
      this.emit('warn', '内核未运行：本次只能做直连检测，无法验证代理链路');
    }

    const out = await runLinkCheck({ proxy, targets, timeoutMs, diagnose: diagnose && running });
    const payload = {
      at: Date.now(),
      via: proxy ? 'proxy' : 'direct',
      port: proxy ? proxy.port : null,
      results: out.results,
      summary: out.summary,
    };
    this.lastLinkCheck = payload;
    this.emit('linkcheck', payload.summary);
    return payload;
  }

  // ── 启动自愈 ───────────────────────────────────────────────────────────
  async boot() {
    const healed = await healIfNeeded({ adapter: this.adapter, journal: this.journal });
    if (healed.healed) {
      this.emit('healed', healed);
      if (healed.platformMismatch) {
        this.emit('warn', `检测到上次在 ${healed.platform} 上异常退出，已按本地平台还原系统代理`);
      }
    }
    // 上次是连接状态 → 说明是异常退出，本次不自动重连（避免用户不知情就走代理）
    if (this.store.state.runtime.connected) {
      this.store.markRuntime({ connected: false, startedAt: null, pid: null });
    }
    return healed;
  }

  // ── 订阅 ───────────────────────────────────────────────────────────────
  async refreshSubscription({ url, force = false } = {}) {
    const result = await this.profiles.legacyRefresh({ url, force });
    if (result.change?.changed.length) this.emit('warn', `${result.change.changed.length} 个节点参数已轮换`);
    return result;
  }

  /** 订阅自动刷新（服务端参数轮换时的兜底） */
  startAutoRefresh({ intervalMs } = {}) {
    if (this.draining || this.isolated) return null;
    const every = intervalMs ?? this.store.state.settings.autoRefreshMinutes * 60_000;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (!every || every <= 0) return null;
    this.refreshTimer = setInterval(() => { void this.autoRefreshSubscriptions(); }, every);
    this.refreshTimer.unref?.();
    return this.refreshTimer;
  }

  async autoRefreshSubscriptions() {
    if (this.draining || this.isolated || this.autoRefreshing || this.busy || !this.store.state.profiles.length) return;
    this.autoRefreshing = true;
    try {
      const result = await this.profiles.refreshAll({ background: true });
      this.emit('subscription', { automatic: true, ...result });
      if (result.failed) this.emit('warn', `订阅自动刷新：${result.failed} 个订阅更新失败，已保留原有节点`);
      return result;
    } catch {
      this.emit('warn', '订阅自动刷新失败，已保留原有节点');
    } finally { this.autoRefreshing = false; }
  }

  // ── 权限 ───────────────────────────────────────────────────────────────
  /**
   * 权限状态。给界面显示「为什么 TUN 模式连不上」，也给上层决定要不要提权。
   * 不抛错 —— 拿不到状态总比让整个界面挂掉好。
   */
  async privilegeStatus({ mode = this.store.state.settings.mode } = {}) {
    try {
      return await checkTunPrivilege({
        mode,
        corePath: this.coreBinary,
        exe: process.execPath,
        args: relaunchArguments(),
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 提权方案：外壳或用户按这个命令重启到特权模式 */
  async elevationPlan({ mode = this.store.state.settings.mode } = {}) {
    this.assertNetworkAllowed();
    if (!['sysproxy', 'tun-per-app'].includes(mode)) throw new Error('无效的接管方式');
    const st = await this.privilegeStatus({ mode });
    if (st.ok) return { needed: false, ...st };
    return {
      needed: true,
      ...st,
      // 独立运行时引擎就是 node 起的，提权重启的自然是同一条命令
      relaunch: planElevation({
        platform: process.platform,
        exe: process.execPath,
        args: relaunchArguments(),
      }),
    };
  }

  /**
   * TUN 模式准入检查。不满足时抛带 code 的错误 ——
   * 前端凭 code 就能弹出「以管理员身份重启」引导，而不是让用户对着一句
   * 「权限不足」发呆：他不知道缺哪个权限、也不知道该怎么办。
   */
  async #assertPrivilege() {
    const mode = this.store.state.settings.mode;
    if (!needsElevation(mode)) return;
    const st = await checkTunPrivilege({
      mode,
      corePath: this.coreBinary,
      exe: process.execPath,
      args: relaunchArguments(),
    });
    if (st.ok) return;
    const err = new Error(st.hint || st.message);
    err.code = 'NEED_ELEVATION';
    err.privilege = st;
    throw err;
  }

  // ── 配置生成 ───────────────────────────────────────────────────────────
  writeConfig({ ruleSetPaths = {} } = {}) {
    const { nodes } = this.store.state.subscription;
    const s = this.validatedSettings();
    if (!nodes.length) throw new Error('没有可用节点，请先刷新订阅');

    const selected = Math.max(0, Math.min(s.selected, nodes.length - 1));
    let config;
    let meta = {};

    if (s.mode === 'tun-per-app') {
      const built = buildTunPerAppConfig(nodes, {
        apps: s.apps,
        reverseApps: s.reverseApps,
        platform: process.platform,
        selected,
        debugPort: s.port,
        clashApi: s.clashApi,
        // ★ 以下参数以前漏传，导致 TUN 模式下三档路由与自定义规则**完全不生效**：
        //   clash_mode 确实通过 API 写了进去，但配置里没有任何规则引用它，
        //   于是界面上的按钮点了没反应，而 setRoutingMode() 还会返回「切换成功」。
        routingMode: s.routingMode || 'rule',
        directRules: s.directRules,
        ruleSetPaths,
        localDns: s.localDns || 'system',
        remoteDns: s.remoteDns || 'https://1.1.1.1/dns-query',
        customRules: s.customRules || [],
      });
      config = built.config;
      // 非法自定义规则要能被界面提示出来，不能静默丢弃
      meta = { processNames: built.processNames, customErrors: built.customErrors };
    } else {
      config = buildConfig(nodes, {
        port: s.port,
        clashApi: s.clashApi,
        selected,
        routingMode: s.routingMode || 'rule',
        directRules: s.directRules,
        ruleSetPaths,
        localDns: s.localDns || 'system',
        remoteDns: s.remoteDns || 'https://1.1.1.1/dns-query',
        customRules: s.customRules || [],
      });
    }

    config.experimental.clash_api.secret = this.coreSecret;
    const file = resolve(this.varDir, CONFIG_FILENAMES[s.mode]);
    if (dirname(file) !== resolve(this.varDir)) throw new Error('配置路径越界');
    writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* ignore */
    }
    meta.mode = s.mode;
    meta.configPath = file;
    meta.node = nodes[selected]?.name ?? null;
    meta.outboundCount = config.outbounds.length;
    return meta;
  }

  // ── 连接 / 断开 ────────────────────────────────────────────────────────
  async connect() {
    this.assertNetworkAllowed();
    if (this.busy) throw new Error(`正在执行：${this.busy}`);
    // 对旧状态同样先验证，不能在下载、提权或生成文件后才发现非法模式/地址。
    this.validatedSettings();
    if (this.supervisor?.isRunning() && this.store.state.runtime.connected) return { connected: true, alreadyConnected: true, pid: this.supervisor.status().pid };
    // 有恢复日志/旧会话时只能先断开，不能覆盖原始快照或失去旧进程的所有权。
    if (this.supervisor || this.store.state.runtime.connected || this.journal.isPending()) throw new Error('仍有未清理的连接，请先断开或恢复后重试');
    this.profiles.applyPending();
    if (!this.store.state.subscription.nodes.length) throw new Error('没有可用节点，请先刷新订阅');
    this.busy = 'connect';
    try {
      // TUN 模式的权限检查放在**最前面**：在下载规则集、写配置、起内核之前就拦掉，
      // 快速失败，不留下任何半成品状态。
      await this.#assertPrivilege();
      this.validatedSettings();
      this.coreSecret = randomBytes(32).toString('hex');

      // 先把规则集缓存到本地：远程规则集会让内核启动依赖网络，下载失败即 FATAL 退出
      this.emit('operation-progress', { stage: '准备大陆 IP / 域名规则集（每项最多15秒）', command: 'GET <公开规则集> → 本地缓存' });
      const ruleSets = await this.ruleSetProvider({ dir: this.dir, coreBinary: this.coreBinary });
      if (!ruleSets['geoip-cn'] || !ruleSets['geosite-cn']) {
        this.emit('warn', '规则集未完全就绪，本次使用内置兜底规则（分流与 DNS 就近解析可能略偏）');
      }
      const meta = this.writeConfig({ ruleSetPaths: ruleSets });
      const settings = { ...this.store.state.settings };
      this.sessionSettings = settings;

      if (!this.coreBinary) throw new Error('找不到内核二进制，请设置环境变量 SING_BOX');

      const ports = [settings.port, Number(settings.clashApi.split(':').at(-1))];
      await this.portsAvailable(ports);
      this.supervisor = this.supervisorFactory({
        binaryPath: this.coreBinary,
        configPath: meta.configPath,
        workDir: this.varDir,
        logFile: join(this.store.logDir, 'core.log'),
        readyCheck: async () => {
          // 先证明两监听属于刚spawn的PID，再向API发送秘密，不能信任任意/version。
          await this.listenerOwnership(ports, this.supervisor.status().pid);
          return this.apiClient().verifyOwnership();
        },
      });
      this.#wireSupervisor();

      this.emit('operation-progress', { stage: '启动代理内核并等待就绪', command: 'sing-box run -c <本地配置，凭据已隐藏>' });
      await this.supervisor.start();

      // 系统代理模式才需要改系统设置；TUN 模式由内核接管流量
      if (settings.mode === 'sysproxy') {
        this.emit('operation-progress', { stage: '配置系统 HTTP / HTTPS 代理（每条命令最多10秒）', command: 'networksetup <系统代理设置，参数已隐藏>' });
        await enableProxy({ adapter: this.adapter, journal: this.journal, port: settings.port });
      }

      this.store.markRuntime({
        connected: true,
        startedAt: new Date().toISOString(),
        pid: this.supervisor.status().pid,
        restarts: 0,
      });
      this.emit('connected', { ...meta, pid: this.supervisor.status().pid });
      return { ...meta, pid: this.supervisor.status().pid };
    } catch (e) {
      // 连接失败必须保证不留下脏状态
      await this.#safeTeardown();
      throw e;
    } finally {
      this.busy = null;
    }
  }

  async disconnect() {
    if (this.busy) throw new Error(`正在执行：${this.busy}`);
    this.busy = 'disconnect';
    try {
      // 顺序不可颠倒：先还原系统代理（恢复用户网络），再停内核
      let proxyRestore = null;
      if (this.journal.isPending()) {
        proxyRestore = await disableProxy({ adapter: this.adapter, journal: this.journal });
      }
      await this.supervisor?.stop();
      this.supervisor?.closeLog();
      this.supervisor = null;
      this.sessionSettings = null;

      this.store.markRuntime({ connected: false, startedAt: null, pid: null });
      this.profiles.applyPending();
      this.emit('disconnected', proxyRestore);
      return proxyRestore;
    } finally {
      this.busy = null;
    }
  }

  /**
   * 切换节点：内核在运行时走 Clash API 即时切换（不重连），
   * 否则只更新设置，下次连接生效。
   */
  async selectNode(index) {
    this.assertMutable();
    const nodes = this.store.state.subscription.nodes;
    if (!Number.isSafeInteger(index) || index < 0 || index >= nodes.length) throw new Error('节点索引无效');
    const idx = index;
    this.store.write({ settings: { selected: idx }, profiles: this.store.state.profiles.map(p => p.id === this.store.state.activeProfileId ? { ...p, selected: idx } : p) });
    const tag = this.nodeTags()[idx];

    if (!this.supervisor?.isRunning()) {
      return { applied: false, reason: '内核未运行，已记录选择，连接后生效', node: nodes[idx]?.name, tag };
    }
    try {
      await this.apiClient().select(SELECTOR_TAG, tag);
      this.emit('selected', { index: idx, node: nodes[idx]?.name, tag });
      return { applied: true, node: nodes[idx]?.name, tag };
    } catch (e) {
      // selector 切换失败（例如内核版本不支持）→ 提示需要重连，而不是静默失败
      return {
        applied: false,
        reason: `即时切换失败（${e.message}），重新连接后生效`,
        node: nodes[idx]?.name,
        tag,
      };
    }
  }

  /**
   * 切换路由模式（规则 / 全局 / 直连）。
   *
   * 内核在运行时走 Clash API **热切换** —— 实测 PATCH /configs 返回 204 且立即生效，
   * 因此不必重连、不必重启内核。失败才退回"记录设置、重连后生效"。
   */
  async setRoutingMode(mode) {
    this.assertMutable();
    if (!ROUTING_MODES.includes(mode)) throw new Error(`未知的路由模式: ${mode}`);
    this.store.write({ settings: { routingMode: mode } });

    if (!this.supervisor?.isRunning()) {
      return { applied: false, reason: '内核未运行，已记录，连接后生效', mode };
    }
    try {
      await this.apiClient().setMode(mode);
      const confirmed = await this.apiClient().getMode();
      this.emit('routing-mode', { mode, confirmed });
      return { applied: true, mode, confirmed };
    } catch (e) {
      return { applied: false, reason: `热切换失败（${e.message}），重新连接后生效`, mode };
    }
  }

  /** 出任何错时的兜底清理：尽力还原代理 + 杀内核 + 清状态 */
  async #safeTeardown() {
    try {
      if (this.journal.isPending()) {
        await healIfNeeded({ adapter: this.adapter, journal: this.journal });
      }
    } catch (error) {
      this.emit('warn', '系统代理恢复失败，保留内核与恢复日志以便重试');
      throw error;
    }
    // 若尚未确认退出，保留所有权；不能让下一次连接覆盖仍存活的进程。
    await this.supervisor?.stop();
    this.supervisor?.closeLog();
    this.supervisor = null;
    this.sessionSettings = null;
    this.store.markRuntime({ connected: false, startedAt: null, pid: null });
  }

  #wireSupervisor() {
    const sup = this.supervisor;
    sup.on('log', (line) => this.emit('core-log', line));
    sup.on('core-error', (e) => this.emit('warn', `内核错误：${e.message}`));
    sup.on('crash', (info) => this.emit('warn', `内核异常退出（code=${info.code ?? 'null'}），正在重启`));

    sup.on('restarted', (st) => {
      if (this.supervisor !== sup) return;
      this.store.markRuntime({ pid: st.pid, restarts: st.restarts });
      this.emit('restarted', st);
    });

    // 内核彻底起不来 → 必须撤掉系统代理，否则用户直接断网
    sup.on('giveup', async (info) => {
      if (this.supervisor !== sup) return;
      this.emit('warn', `内核连续 ${info.restarts} 次启动失败，已停止重试`);
      try {
        if (this.journal.isPending()) {
          await disableProxy({ adapter: this.adapter, journal: this.journal });
          this.emit('warn', '已还原系统代理设置');
        }
      } catch (e) {
        this.emit('warn', `还原系统代理失败：${e.message}`);
      }
      if (this.supervisor !== sup) return;
      this.store.markRuntime({ connected: false, pid: null });
      this.emit('gaveup', info);
    });
  }

  // ── 测速 ───────────────────────────────────────────────────────────────
  async measureLatency({ index, all = false } = {}) {
    this.assertNetworkAllowed();
    if (this.busy) throw new Error('正在执行：' + this.busy);
    const nodes = this.store.state.subscription.nodes;
    if (!nodes.length) throw new Error('没有可用节点，请先导入订阅');
    if (!all && index !== undefined && (!Number.isInteger(index) || !nodes[index])) throw new Error('节点索引无效');
    this.busy = 'latency';
    try {
      if (this.supervisor?.isRunning()) return await this.measureWithApi(this.apiClient(), { index, all });
      return await this.latencyCoreRunner(this.coreBinary, nodes, api => this.measureWithApi(api, { index, all }));
    } finally { this.busy = null; }
  }

  async measureWithApi(api, { index, all }) {
    const nodes = this.store.state.subscription.nodes;
    const tags = this.nodeTags();
    const record = (name, r) => this.lastLatency.set(name, { ...r, at: Date.now() });

    if (all || index === undefined) {
      const res = await api.delayAll(tags);
      for (const [tag, r] of res) {
        const node = nodes[tags.indexOf(tag)];
        record(node?.name ?? tag, r);
        this.lastLatencyByTag.set(tag, r);
      }
      return Object.fromEntries(res);
    }

    const i = Number(index);
    const node = nodes[i];
    if (!node) throw new Error(`节点索引越界: ${index}`);
    try {
      const delay = await api.delay(tags[i]);
      record(node.name, { ok: true, delay });
      this.lastLatencyByTag.set(tags[i], { ok: true, delay });
      return { [node.name]: { ok: true, delay } };
    } catch (e) {
      const r = { ok: false, error: /timeout|超时|deadline|abort/i.test(e.message) ? '超时' : '不可用' };
      record(node.name, r);
      this.lastLatencyByTag.set(tags[i], r);
      return { [node.name]: r };
    }
  }

  // ── 设置 ───────────────────────────────────────────────────────────────
  async updateSettings(patch) {
    this.assertMutable();
    if (this.busy) throw new Error(`正在执行：${this.busy}`);
    const next = validateSettings(patch);
    if (!Object.keys(next).length) return this.store.state.settings;
    this.validatedSettings({ ...this.store.state.settings, ...next });
    if (next.selected !== undefined) {
      const max = Math.max(0, this.store.state.subscription.nodes.length - 1);
      next.selected = Math.max(0, Math.min(Number(next.selected), max));
    }
    // 运行中改端口/模式需要重连才生效
    // 自定义规则非法项要明确告知，不能静默丢弃
    if (next.customRules !== undefined) {
      const { errors } = normalizeCustomRules(next.customRules);
      for (const e of errors) this.emit('warn', `自定义规则未生效：${e.error}`);
    }
    // 规则改动无法热更新（内核不支持），必须重连
    if (next.customRules !== undefined &&
        JSON.stringify(next.customRules) !== JSON.stringify(this.store.state.settings.customRules || [])) {
      this.emit('warn', '分流规则已修改，需要重新连接后生效');
    }
    // routingMode 可热切换，走 setRoutingMode，不走重连路径
    if (next.routingMode !== undefined && next.routingMode === this.store.state.settings.routingMode) {
      delete next.routingMode;
    }
    const needsReconnect =
      (next.apps !== undefined && JSON.stringify(next.apps) !== JSON.stringify(this.store.state.settings.apps)) ||
      (next.reverseApps !== undefined && next.reverseApps !== this.store.state.settings.reverseApps) ||
      (next.port !== undefined && Number(next.port) !== Number(this.store.state.settings.port)) ||
      (next.mode !== undefined && next.mode !== this.store.state.settings.mode) ||
      (next.localDns !== undefined && next.localDns !== this.store.state.settings.localDns) ||
      (next.remoteDns !== undefined && next.remoteDns !== this.store.state.settings.remoteDns);

    this.store.write({ settings: next });
    if (next.autoRefreshMinutes !== undefined) this.startAutoRefresh();
    if (needsReconnect && this.store.state.runtime.connected) {
      this.emit('warn', '端口/模式已修改，需要重新连接后生效');
    }
    return this.store.state.settings;
  }

  exportRules() {
    return { ...rulesDocument(this.store.state.settings.customRules || []),
      apps: this.store.state.settings.apps, reverseApps: this.store.state.settings.reverseApps === true };
  }

  async importRules({ text, mode = 'append' } = {}) {
    const result = importRules(text, this.store.state.settings.customRules || [], mode);
    const doc = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    const patch = { customRules: result.rules };
    if (!Array.isArray(doc)) {
      if (doc.apps !== undefined) patch.apps = doc.apps;
      if (doc.reverseApps !== undefined) patch.reverseApps = doc.reverseApps;
    }
    await this.updateSettings(patch);
    return result;
  }

  // ── 日志 ───────────────────────────────────────────────────────────────
  tailLogs({ lines = 200 } = {}) {
    const file = join(this.store.logDir, 'core.log');
    if (!existsSync(file)) return [];
    // 日志按 8MB 轮转，直接读即可；只取尾部 N 行
    const all = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return all.slice(-lines);
  }

  logFiles() {
    try {
      return readdirSync(this.store.logDir).map((f) => ({
        name: f,
        bytes: statSync(join(this.store.logDir, f)).size,
      }));
    } catch {
      return [];
    }
  }
}
