// 多订阅管理；活动订阅镜像保持旧接口兼容，个人规则独立保存。
import { randomUUID } from 'node:crypto';
import { fetchSubscription, dedupeNodes, diffNodes, summarizeChange } from './subscription.mjs';
import { parseSubscription } from '../core/parse.mjs';

export const emptySubscription = () => ({ url: '', nodes: [], etag: null, updatedAt: null, lastError: null, lastChange: null });
const safeError = (error) => error.code === 'SUBSCRIPTION_SIZE' ? '订阅内容超过安全上限，原有节点与选择已保留' : error.code === 'SUBSCRIPTION_REDIRECT' ? '订阅重定向无效或不安全，原有节点与选择已保留' : /node limit/i.test(error.message) ? '订阅节点数量超过5000，原有节点与选择已保留' : /超时|timeout|abort/i.test(error.message) ? '订阅更新超时（20秒），原有节点已保留，可稍后重试' : /HTTP \d{3}$/.test(error.message) ? error.message : '订阅更新失败，请检查链接、内容和网络后重试';
export class ProfilesService {
  constructor(app, { fetchImpl = fetch } = {}) { this.app = app; this.store = app.store; this.fetchImpl = fetchImpl; }
  find(id) {
    const profile = this.store.state.profiles.find(p => p.id === id);
    if (!profile) throw new Error('订阅不存在，请刷新列表');
    return profile;
  }
  assertDisconnected() {
    if (this.app.supervisor?.isRunning() || this.store.state.runtime.connected) throw new Error('请先断开代理，再切换或修改当前订阅');
  }
  async mutate(work) {
    this.app.assertMutable();
    if (this.app.busy) throw new Error(`正在执行：${this.app.busy}`);
    this.app.busy = 'subscription';
    try { return await work(); } finally { this.app.busy = null; }
  }
  async load(url, previous, force) {
    const parsedURL = new URL(url);
    if (!['http:', 'https:'].includes(parsedURL.protocol)) throw new Error('订阅链接必须以 http:// 或 https:// 开头');
    const res = await fetchSubscription(url, { etag: force ? undefined : previous.etag, fetchImpl: this.fetchImpl });
    if (res.notModified && previous.nodes.length) return { ...previous, updatedAt: new Date().toISOString(), lastError: null, lastChange: null, notModified: true };
    const parsed = parseSubscription(res.body || '');
    const nodes = dedupeNodes(parsed.nodes);
    if (!nodes.length) throw new Error('订阅中没有可用节点');
    return { url, nodes, etag: res.etag, updatedAt: new Date().toISOString(), lastError: null, lastChange: diffNodes(previous.nodes, nodes), skipped: parsed.skipped.length, notModified: false };
  }
  commit(profile, activate) {
    if (activate) profile = { ...profile, pendingUpdate: false };
    const s = this.store.state;
    const base = s.activeProfileId && s.activeProfileId !== profile.id
      ? s.profiles.map(p => p.id === s.activeProfileId ? { ...p, selected: s.settings.selected } : p)
      : s.profiles;
    const profiles = base.some(p => p.id === profile.id) ? base.map(p => p.id === profile.id ? profile : p) : [...base, profile];
    const patch = { profiles };
    if (activate) {
      const same = s.activeProfileId === profile.id;
      const oldNode = same ? s.subscription.nodes[s.settings.selected] : null;
      let selected = oldNode ? profile.nodes.findIndex(n => n.name === oldNode.name && n.type === oldNode.type && n.server === oldNode.server && n.server_port === oldNode.server_port) : profile.selected || 0;
      selected = Math.max(0, Math.min(selected, Math.max(0, profile.nodes.length - 1)));
      patch.activeProfileId = profile.id;
      patch.subscription = { ...emptySubscription(), ...profile };
      patch.settings = { selected };
    }
    try { this.store.write(patch); }
    catch (cause) { throw Object.assign(new Error('订阅保存失败，原有配置和缓存未改变'), { code: 'PERSIST_FAILED', cause }); }
    if (activate) {
      this.app.lastLatency.clear();
      this.app.lastLatencyByTag?.clear();
    }
    this.app.emit('subscription', { nodes: profile.nodes.length });
  }
  async save({ id, name, url } = {}) {
    return this.mutate(async () => {
      const previous = id ? this.find(id) : { ...emptySubscription(), id: randomUUID(), name: '', selected: 0 };
      const activate = !this.store.state.activeProfileId || previous.id === this.store.state.activeProfileId;
      const target = url?.trim() || previous.url;
      const title = String(name || previous.name || '新订阅').trim();
      if (!title || title.length > 80) throw new Error('订阅名称长度应为 1–80 个字符');
      if (!target) throw new Error('请填写订阅链接');
      const changedURL = target !== previous.url;
      if (activate && (!id || changedURL)) this.assertDisconnected();
      let loaded = previous;
      if (!id || changedURL) {
        try { loaded = await this.load(target, changedURL ? emptySubscription() : previous, true); }
        catch (error) { throw new Error(safeError(error)); }
      }
      const profile = { ...previous, ...loaded, id: previous.id, name: title };
      this.commit(profile, activate && !(profile.pendingUpdate && (this.app.supervisor?.isRunning() || this.store.state.runtime.connected)));
      return { id: profile.id, nodes: profile.nodes.length };
    });
  }
  async refresh(id, { force = false, background = false } = {}) {
    return this.mutate(async () => {
      const previous = this.find(id);
      const active = id === this.store.state.activeProfileId;
      const deferApply = active && Boolean(this.app.supervisor?.isRunning() || this.store.state.runtime.connected);
      this.app.emit('operation-progress', { stage: '正在下载并校验订阅（20秒超时）', command: 'GET <订阅地址已隐藏>' });
      try {
        const loaded = await this.load(previous.url, previous, force);
        this.commit({ ...previous, ...loaded, pendingUpdate: deferApply }, active && !deferApply);
        return { id, nodes: loaded.nodes.length, pendingUpdate: deferApply, notModified: loaded.notModified, change: loaded.lastChange, summary: summarizeChange(loaded.lastChange), skipped: loaded.skipped || 0 };
      } catch (error) {
        if (error.code === 'PERSIST_FAILED' || error.persistenceFailure) throw error;
        const message = safeError(error);
        this.store.write({ profiles: this.store.state.profiles.map(p => p.id === id ? { ...p, lastError: message } : p), ...(active ? { subscription: { lastError: message } } : {}) });
        throw new Error(message);
      }
    });
  }
  async activate(id) {
    return this.mutate(async () => {
      this.assertDisconnected();
      const profile = this.find(id);
      if (!profile.nodes.length) throw new Error('此订阅没有可用节点，请先更新');
      this.commit(profile, true);
      return { ok: true };
    });
  }
  async remove(id) {
    return this.mutate(async () => {
      this.find(id);
      const active = id === this.store.state.activeProfileId;
      if (active) this.assertDisconnected();
      this.store.write({ profiles: this.store.state.profiles.filter(p => p.id !== id), ...(active ? { activeProfileId: null, subscription: emptySubscription(), settings: { selected: 0 } } : {}) });
      if (active) { this.app.lastLatency.clear(); this.app.lastLatencyByTag?.clear(); }
      this.app.emit('subscription', { removed: true });
      return { ok: true };
    });
  }
  applyPending() {
    const profile = this.store.state.profiles.find(p => p.id === this.store.state.activeProfileId);
    if (!profile?.pendingUpdate) return;
    this.assertDisconnected();
    this.commit({ ...profile, pendingUpdate: false }, true);
  }
  async refreshAll({ background = false } = {}) {
    const results = [];
    for (const { id } of [...this.store.state.profiles]) {
      try { results.push({ id, ok: true, ...await this.refresh(id, { background }) }); }
      catch (error) { results.push({ id, ok: false, error: safeError(error) }); }
    }
    return { updated: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
  }
  async legacyRefresh({ url, force = false } = {}) {
    const target = url || this.store.state.subscription.url;
    if (!target) throw new Error('请先填写订阅链接');
    if (target !== this.store.state.subscription.url) this.assertDisconnected();
    let profile = this.store.state.profiles.find(p => p.url === target);
    if (!profile) {
      const result = await this.save({ url: target, name: '订阅 ' + (this.store.state.profiles.length + 1) });
      profile = this.find(result.id);
      if (this.store.state.activeProfileId !== profile.id) await this.activate(profile.id);
      return { ...result, notModified: false, change: profile.lastChange, summary: summarizeChange(profile.lastChange), skipped: profile.skipped || 0 };
    }
    if (profile.id !== this.store.state.activeProfileId) this.assertDisconnected();
    const result = await this.refresh(profile.id, { force });
    if (profile.id !== this.store.state.activeProfileId) await this.activate(profile.id);
    return result;
  }
}
