// 内核的 Clash API 兼容接口客户端
//
// 为什么不自己写测速/状态：sing-box 的 clash_api 已经提供了延迟测试、连接列表、
// 流量统计、以及 **selector 切换**。自己写只会得到一份不准确、还需要维护的实现。
//
// 端点（Clash 兼容）： /version · /proxies · /proxies/{name}/delay · PUT /proxies/{name} · /connections

export class ClashApi {
  constructor(baseUrl = 'http://127.0.0.1:9090', { secret = '', timeoutMs = 8000 } = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.secret = secret;
    this.timeoutMs = timeoutMs;
  }

  #headers() {
    return this.secret ? { Authorization: `Bearer ${this.secret}` } : {};
  }

  async #req(path, { method = 'GET', body, timeoutMs = this.timeoutMs } = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('内核 API 超时')), timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          ...this.#headers(),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`内核 API ${method} ${path} → HTTP ${res.status}`);
      // PUT 切换节点可能返回空体
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(t);
    }
  }

  async version() {
    return this.#req('/version', { timeoutMs: 3000 });
  }

  async proxies() {
    const data = await this.#req('/proxies');
    return data.proxies || {};
  }

  async connections() {
    return this.#req('/connections');
  }

  async closeConnection(id) {
    return this.#req(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async closeAllConnections() {
    return this.#req('/connections', { method: 'DELETE' });
  }

  /**
   * 切换 selector 指向的节点 —— **不需要重启内核**。
   * 这是把节点做成 selector 出站带来的直接好处。
   */
  async select(selectorName, targetName) {
    await this.#req(`/proxies/${encodeURIComponent(selectorName)}`, {
      method: 'PUT',
      body: { name: targetName },
      timeoutMs: 5000,
    });
    return true;
  }

  /**
   * 读取当前路由模式（内核 /configs 的 mode 字段）。
   * 实测 sing-box 1.14.3：GET /configs 返回 { mode: "Rule" | "Global" | "Direct", mode-list: [...] }
   */
  async getMode() {
    const d = await this.#req('/configs');
    return d?.mode ?? null;
  }

  /**
   * 热切换路由模式 —— **不需要重启内核**。
   * 实测：PATCH /configs {"mode":"global"} 返回 204，随后 GET /configs 的 mode 与
   * 实际出站选择都会随之改变（配合配置里的 clash_mode 规则）。
   */
  async setMode(mode) {
    await this.#req('/configs', { method: 'PATCH', body: { mode }, timeoutMs: 5000 });
    return mode;
  }

  /** 读取 selector 当前指向 */
  async currentSelection(selectorName) {
    const p = await this.proxies();
    return p[selectorName]?.now ?? null;
  }

  /**
   * 单个节点的真实延迟（内核实际发起连接测得，不是 ping）。
   * 节点不可用/超时会抛错 —— 调用方应把它转成"该节点不可用"，而不是让整个测速失败。
   */
  async delay(proxyName, { url = 'http://www.gstatic.com/generate_204', timeoutMs = 5000 } = {}) {
    const q = new URLSearchParams({ timeout: String(timeoutMs), url });
    const data = await this.#req(`/proxies/${encodeURIComponent(proxyName)}/delay?${q}`, {
      timeoutMs: timeoutMs + 4000,
    });
    if (typeof data?.delay !== 'number') throw new Error('内核未返回延迟值');
    return data.delay;
  }

  /** 内核是否就绪：能返回版本号即视为就绪 */
  async waitForReady({ timeoutMs = 15000, intervalMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
      try {
        return await this.version();
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
    throw new Error(`内核在 ${timeoutMs}ms 内未就绪：${lastErr?.message || '未知错误'}`);
  }

  /** 并发测速（带并发上限，别把内核打爆） */
  async delayAll(names, { concurrency = 4, ...opts } = {}) {
    const results = new Map();
    const queue = [...names];
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
      while (queue.length) {
        const name = queue.shift();
        const t0 = Date.now();
        try {
          results.set(name, { ok: true, delay: await this.delay(name, opts) });
        } catch (e) {
          // 超时 → 报超时；连不上 → 报不可用。两者对用户的含义不同。
          const msg = /timeout|超时|deadline|abort/i.test(e.message) ? '超时' : '不可用';
          results.set(name, { ok: false, error: msg, elapsed: Date.now() - t0 });
        }
      }
    });
    await Promise.all(workers);
    return results;
  }
}
