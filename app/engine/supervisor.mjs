// 内核进程守护
//
// 这是整个客户端里最容易出错、也最影响体验的一块。必须处理好的四件事：
//   ① 区分「用户主动停止」和「内核崩溃」—— 否则用户点断开，程序会把它拉起来
//   ② 崩溃后按窗口限流重启，避免内核配置错误时无限重启刷屏
//   ③ 重启失败要上报，让上层去还原系统代理（否则全机断网）
//   ④ 日志落盘 —— 调试 Reality / 进程匹配问题的唯一有效手段

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, mkdirSync, statSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

export class CoreSupervisor extends EventEmitter {
  #current = null;
  #generation = 0;
  #stopRequested = false;
  #restartTimes = [];
  #lastExit = null;
  #restartTimer = null;
  #logStream = null;
  #givingUp = false;
  #startPromise = null;
  #stopPromise = null;

  constructor({ binaryPath, configPath, workDir, logFile, readyCheck,
    maxRestarts = 5, windowMs = 60_000, restartDelayMs = 1200,
    readyTimeoutMs = 15_000, logMaxBytes = 8 * 1024 * 1024, spawnImpl = spawn,
    now = () => performance.now(), setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
  }) {
    super();
    if (!binaryPath) throw new Error('缺少内核路径 binaryPath');
    if (typeof readyCheck !== 'function') throw new Error('缺少 readyCheck');
    Object.assign(this, { binaryPath, configPath, workDir: workDir || dirname(configPath || '.'),
      logFile, readyCheck, maxRestarts, windowMs, restartDelayMs, readyTimeoutMs,
      logMaxBytes, spawnImpl, now, setTimeoutImpl, clearTimeoutImpl });
  }

  #alive(record) {
    const child = record?.child;
    // child.killed only means a signal was sent, not that the process exited.
    return Boolean(child && !record.exited && child.pid != null &&
      child.exitCode === null && child.signalCode == null);
  }
  isRunning() { return this.#alive(this.#current); }
  status() {
    return { running: this.isRunning(), pid: this.#current?.child.pid ?? null,
      uptimeMs: this.#current ? Math.max(0, this.now() - this.#current.startedAt) : 0,
      restarts: this.#restartTimes.length, lastExit: this.#lastExit,
      givingUp: this.#givingUp, logFile: this.logFile || null };
  }

  #openLog() {
    if (!this.logFile) return null;
    mkdirSync(dirname(this.logFile), { recursive: true, mode: 0o700 });
    try {
      if (existsSync(this.logFile) && statSync(this.logFile).size > this.logMaxBytes) {
        renameSync(this.logFile, `${this.logFile}.1`);
      }
    } catch { /* log rotation must not prevent recovery */ }
    return createWriteStream(this.logFile, { flags: 'a', mode: 0o600 });
  }

  start() {
    if (this.#stopPromise) return Promise.reject(new Error('内核正在停止，请等待退出后重试'));
    if (this.#startPromise) return this.#startPromise;
    if (this.#current) {
      if (this.#current.ready && !this.#stopRequested && this.isRunning()) return Promise.resolve(this.status());
      return Promise.reject(new Error('旧内核尚未确认退出，不能启动另一个进程'));
    }
    if (this.#restartTimer) {
      this.clearTimeoutImpl(this.#restartTimer); this.#restartTimer = null;
    }
    this.#stopRequested = false;
    this.#givingUp = false;
    this.#generation++;
    return this.#runAttempt('started');
  }

  #runAttempt(event) {
    const generation = this.#generation;
    const promise = this.#attempt(event, generation).finally(() => {
      if (this.#startPromise === promise) this.#startPromise = null;
    });
    this.#startPromise = promise;
    return promise;
  }

  async #attempt(event, generation) {
    let record;
    try {
      record = this.#spawn(generation);
      await this.#awaitReady(record);
      this.#assertCurrent(record);
      record.ready = true;
      this.emit(event, this.status());
      return this.status();
    } catch (error) {
      if (!record && !this.#current && generation === this.#generation) {
        // A synchronous spawn failure owns no PID and consumes only one attempt.
        record = { generation, exited: true, recoveryScheduled: false, failure: error };
        this.#lastExit = { code: null, signal: 'spawn-failed', at: new Date().toISOString(),
          intentional: this.#stopRequested, error: error.message };
      }
      if (record) record.failure = error;
      if (!this.#stopRequested && generation === this.#generation) this.emit('core-error', error);
      if (record && !record.exited) {
        // Never discard a still-live child after a readiness timeout. Confirm its
        // exit before recovery can allocate another process.
        try { await this.#terminate(record); }
        catch (stopError) {
          if (!this.#stopRequested && generation === this.#generation) {
            this.emit('core-error', stopError);
            this.#giveUp(record);
          }
          throw stopError;
        }
      }
      if (record) this.#scheduleRestart(record);
      throw error;
    }
  }

  #spawn(generation) {
    if (this.#current) throw new Error('旧内核尚未确认退出');
    if (!this.#logStream) this.#logStream = this.#openLog();
    const env = { ...process.env };
    delete env.JMS_API_TOKEN;
    delete env.JMS_INSTANCE_ID;
    const child = this.spawnImpl(this.binaryPath, ['run', '-c', this.configPath], {
      cwd: this.workDir, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    const record = { child, generation, startedAt: this.now(), exited: false,
      ready: false, intentional: false, recoveryScheduled: false,
      abort: new AbortController(), terminationPromise: null };
    this.#current = record;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (buf) => {
        if (this.#current !== record || record.exited) return;
        const line = buf.toString();
        this.#logStream?.write(line);
        for (const l of line.split('\n')) if (l.trim()) this.emit('log', l);
      });
    }
    child.on('error', (error) => {
      if (record.exited || this.#current !== record) return;
      record.failure = error;
      record.abort.abort(error);
      // A failed spawn has no PID and does not emit exit. Other errors (e.g. a
      // failed signal) do not prove the process is gone.
      if (child.pid == null) this.#handleExit(record, null, 'spawn-failed');
      else this.emit('core-error', error);
    });
    child.on('exit', (code, signal) => this.#handleExit(record, code, signal));
    return record;
  }

  #assertCurrent(record) {
    if (record !== this.#current || record.generation !== this.#generation ||
        this.#stopRequested || record.exited || !this.#alive(record)) {
      throw new Error(`内核启动后立即退出或已停止：${record.failure?.message || this.#lastExit?.code || '未知'}`);
    }
  }

  #bounded(promise, record, remaining) {
    return new Promise((resolve, reject) => {
      let timer;
      const done = (callback, value) => {
        this.clearTimeoutImpl(timer);
        record.abort.signal.removeEventListener('abort', aborted);
        callback(value);
      };
      const aborted = () => done(reject, record.abort.signal.reason || new Error('内核已停止'));
      timer = this.setTimeoutImpl(() => done(reject, new Error(`内核未在 ${this.readyTimeoutMs}ms 内就绪`)), Math.max(0, remaining));
      record.abort.signal.addEventListener('abort', aborted, { once: true });
      if (record.abort.signal.aborted) aborted();
      // Attach both handlers even after cancellation: a late readyCheck rejection
      // must not become an unhandled rejection or mutate a newer generation.
      Promise.resolve(promise).then(value => done(resolve, value), error => done(reject, error));
    });
  }

  async #awaitReady(record) {
    const deadline = this.now() + this.readyTimeoutMs;
    let lastError;
    while (this.now() < deadline) {
      this.#assertCurrent(record);
      try {
        await this.#bounded(Promise.resolve().then(() => this.readyCheck()), record, deadline - this.now());
        this.#assertCurrent(record);
        if (this.now() >= deadline) throw new Error('就绪检查超过截止时间');
        return;
      } catch (error) {
        lastError = error;
        this.#assertCurrent(record);
        if (record.abort.signal.aborted) throw error;
        const remaining = deadline - this.now();
        if (remaining <= 0) break;
        let timer;
        try {
          await this.#bounded(new Promise(resolve => {
            timer = this.setTimeoutImpl(resolve, Math.min(200, remaining));
          }), record, remaining);
        } finally { this.clearTimeoutImpl(timer); }
      }
    }
    throw new Error(`内核未在 ${this.readyTimeoutMs}ms 内就绪：${lastError?.message || '未知错误'}`);
  }

  #handleExit(record, code, signal) {
    if (record.exited) return;
    record.exited = true;
    record.abort.abort(new Error(`内核启动后立即退出：${record.failure?.message || code || signal || '未知'}`));
    // A late exit from an older child may release its own waiters, but cannot
    // clear the new child, emit a second crash, or spend another restart budget.
    if (this.#current !== record) return;
    this.#current = null;
    this.#lastExit = { code, signal, at: new Date().toISOString(),
      intentional: record.intentional || this.#stopRequested,
      ...(record.failure ? { error: record.failure.message } : {}) };
    this.emit('exit', this.#lastExit);
    if (this.#lastExit.intentional) this.emit('stopped', this.#lastExit);
    // Pending start attempts own their failure handling. This avoids the exit
    // event and the readiness rejection scheduling two independent restarts.
    else if (record.ready) this.#scheduleRestart(record);
  }

  #giveUp(record) {
    if (record.recoveryScheduled) return;
    record.recoveryScheduled = true;
    this.#givingUp = true;
    this.emit('giveup', { restarts: this.#restartTimes.length,
      windowMs: this.windowMs, lastExit: this.#lastExit });
  }

  #scheduleRestart(record) {
    if (record.recoveryScheduled || !record.exited || this.#stopRequested ||
        record.generation !== this.#generation || this.#restartTimer) return;
    const now = this.now();
    this.#restartTimes = this.#restartTimes.filter(t => now - t < this.windowMs);
    if (this.#restartTimes.length >= this.maxRestarts) { this.#giveUp(record); return; }
    record.recoveryScheduled = true;
    this.#restartTimes.push(now);
    this.emit('crash', this.#lastExit);
    const generation = this.#generation;
    this.#restartTimer = this.setTimeoutImpl(() => {
      this.#restartTimer = null;
      if (this.#stopRequested || generation !== this.#generation || this.#current) return;
      // Readiness and exit are handled inside the attempt exactly once.
      void this.#runAttempt('restarted').catch(() => {});
    }, this.restartDelayMs);
    this.#restartTimer.unref?.();
  }

  #terminate(record, timeoutMs = 6000) {
    if (record.terminationPromise) return record.terminationPromise;
    const child = record.child;
    if (!this.#alive(record)) {
      if (!record.exited) this.#handleExit(record, child.exitCode, child.signalCode || 'not-spawned');
      return Promise.resolve();
    }
    record.terminationPromise = new Promise((resolve, reject) => {
      let timer;
      const done = (error) => {
        this.clearTimeoutImpl(timer);
        child.removeListener('exit', exited);
        if (error) reject(error); else resolve();
      };
      const exited = () => done();
      child.once('exit', exited);
      timer = this.setTimeoutImpl(() => {
        // Retain ownership if even SIGKILL has not produced a confirmed exit.
        timer = this.setTimeoutImpl(() => done(new Error('内核尚未确认退出，已保留进程所有权')), Math.min(1000, timeoutMs));
        try { child.kill('SIGKILL'); } catch (error) { done(error); }
      }, timeoutMs);
      try { child.kill('SIGTERM'); } catch (error) { done(error); }
    });
    const pending = record.terminationPromise;
    // A later stop may retry signalling the same retained child, never a new PID.
    void pending.catch(() => { if (record.terminationPromise === pending) record.terminationPromise = null; });
    return pending;
  }

  stop({ timeoutMs = 6000 } = {}) {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopRequested = true;
    this.#generation++;
    if (this.#restartTimer) {
      this.clearTimeoutImpl(this.#restartTimer); this.#restartTimer = null;
    }
    const record = this.#current;
    if (record) {
      record.intentional = true;
      record.abort.abort(new Error('内核已停止'));
    }
    const promise = (async () => {
      if (record) await this.#terminate(record, timeoutMs);
      // A cancelled readiness check must settle before another start is allowed.
      if (this.#startPromise) await this.#startPromise.catch(() => {});
      return this.status();
    })().finally(() => { if (this.#stopPromise === promise) this.#stopPromise = null; });
    this.#stopPromise = promise;
    return promise;
  }

  closeLog() {
    try { this.#logStream?.end(); } catch { /* ignore */ }
    this.#logStream = null;
  }
}

/** 定位内核二进制：环境变量优先，其次 PATH 常见位置 */
export function resolveCoreBinary({ env = process.env, exists = existsSync } = {}) {
  if (env.JMS_TEST_NO_CORE === '1') return null;
  const candidates = [
    env.SING_BOX,
    env.SING_BOX_PATH,
    env.JMS_CORE,
    join(process.cwd(), 'bin', process.platform === 'win32' ? 'sing-box.exe' : 'sing-box'),
    '/usr/local/bin/sing-box',
    '/usr/bin/sing-box',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (exists(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}
