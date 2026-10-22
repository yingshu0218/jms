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

export class CoreSupervisor extends EventEmitter {
  #child = null;
  #stopRequested = false;
  #restartTimes = [];
  #startedAt = null;
  #lastExit = null;
  #restartTimer = null;
  #logStream = null;
  #givingUp = false;
  #spawnOk = false;

  constructor({
    binaryPath,
    configPath,
    workDir,
    logFile,
    readyCheck, // async () => any，抛错表示未就绪
    maxRestarts = 5,
    windowMs = 60_000,
    restartDelayMs = 1200,
    readyTimeoutMs = 15_000,
    logMaxBytes = 8 * 1024 * 1024,
    spawnImpl = spawn,
  }) {
    super();
    if (!binaryPath) throw new Error('缺少内核路径 binaryPath');
    if (typeof readyCheck !== 'function') throw new Error('缺少 readyCheck');
    Object.assign(this, {
      binaryPath,
      configPath,
      workDir: workDir || dirname(configPath || '.'),
      logFile,
      readyCheck,
      maxRestarts,
      windowMs,
      restartDelayMs,
      readyTimeoutMs,
      logMaxBytes,
      spawnImpl,
    });
  }

  isRunning() {
    // #spawnOk / pid 检查是必要的：spawn 失败（ENOENT 等）时 exitCode 仍为 null、killed 为 false，
    // 只看这两项会把「根本没起来的内核」误判成运行中。
    return Boolean(
      this.#child &&
        this.#spawnOk &&
        this.#child.pid != null &&
        this.#child.exitCode === null &&
        !this.#child.killed,
    );
  }

  status() {
    return {
      running: this.isRunning(),
      pid: this.#child?.pid ?? null,
      uptimeMs: this.#startedAt ? Date.now() - this.#startedAt : 0,
      restarts: this.#restartTimes.length,
      lastExit: this.#lastExit,
      givingUp: this.#givingUp,
      logFile: this.logFile || null,
    };
  }

  #openLog() {
    if (!this.logFile) return null;
    mkdirSync(dirname(this.logFile), { recursive: true, mode: 0o700 });
    try {
      if (existsSync(this.logFile) && statSync(this.logFile).size > this.logMaxBytes) {
        renameSync(this.logFile, `${this.logFile}.1`);
      }
    } catch {
      /* ignore */
    }
    return createWriteStream(this.logFile, { flags: 'a', mode: 0o600 });
  }

  async start() {
    if (this.isRunning()) return this.status();
    this.#stopRequested = false;
    this.#givingUp = false;
    await this.#spawn();
    await this.#awaitReady();
    this.emit('started', this.status());
    return this.status();
  }

  async #spawn() {
    if (!this.logFile || !this.#logStream) this.#logStream = this.#openLog();
    const child = this.spawnImpl(this.binaryPath, ['run', '-c', this.configPath], {
      cwd: this.workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.#child = child;
    this.#startedAt = Date.now();
    this.#spawnOk = child.pid != null;

    const pipe = (stream) => {
      stream?.on('data', (buf) => {
        const line = buf.toString();
        this.#logStream?.write(line);
        for (const l of line.split('\n')) {
          if (l.trim()) this.emit('log', l);
        }
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);

    child.on('error', (err) => {
      // 绝不能 emit('error') —— EventEmitter 对 'error' 有特殊语义：没有监听者时会直接抛出，
      // 把「内核启动失败」升级成进程级崩溃。用自定义事件名。
      this.#spawnOk = false;
      this.#lastExit = {
        code: null,
        signal: null,
        at: new Date().toISOString(),
        intentional: this.#stopRequested,
        error: err.message,
      };
      this.emit('core-error', err);
    });
    child.on('exit', (code, signal) => this.#handleExit(code, signal));
  }

  async #awaitReady() {
    const deadline = Date.now() + this.readyTimeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
      if (!this.isRunning()) {
        const why = this.#lastExit?.error || this.#lastExit?.code || '未知';
        throw new Error(`内核启动后立即退出：${why}`);
      }
      try {
        await this.readyCheck();
        return;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error(`内核未在 ${this.readyTimeoutMs}ms 内就绪：${lastErr?.message || '未知错误'}`);
  }

  #handleExit(code, signal) {
    const intentional = this.#stopRequested;
    this.#child = null;
    this.#startedAt = null;
    this.#lastExit = { code, signal, at: new Date().toISOString(), intentional };
    this.emit('exit', this.#lastExit);

    if (intentional) {
      this.emit('stopped', this.#lastExit);
      return;
    }

    // 崩溃：按窗口限流
    const now = Date.now();
    this.#restartTimes = this.#restartTimes.filter((t) => now - t < this.windowMs);
    if (this.#restartTimes.length >= this.maxRestarts) {
      this.#givingUp = true;
      this.emit('giveup', {
        restarts: this.#restartTimes.length,
        windowMs: this.windowMs,
        lastExit: this.#lastExit,
      });
      return;
    }
    this.#restartTimes.push(now);
    this.emit('crash', this.#lastExit);

    this.#restartTimer = setTimeout(async () => {
      this.#restartTimer = null;
      if (this.#stopRequested) return;
      try {
        await this.#spawn();
        await this.#awaitReady();
        this.emit('restarted', this.status());
      } catch (e) {
        this.emit('core-error', e);
        // 重启本身失败也走同一套限流逻辑
        this.#handleExit(null, 'restart-failed');
      }
    }, this.restartDelayMs);
    this.#restartTimer.unref?.();
  }

  async stop({ timeoutMs = 6000 } = {}) {
    this.#stopRequested = true;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    const child = this.#child;
    if (!child) return this.status();
    // spawn 失败没有 PID，也不会触发 exit，不能等待不存在的进程。
    if (child.pid == null || child.exitCode !== null || child.signalCode != null) {
      this.#child = null;
      this.#startedAt = null;
      return this.status();
    }

    await new Promise((resolve) => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        child.removeListener('exit', done);
        resolve();
      };
      child.once('exit', done);
      // 正在等待清理完成时保留计时器，避免事件循环提前结束。
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        done();
      }, timeoutMs);
      try {
        child.kill('SIGTERM');
      } catch {
        done();
      }
    });
    return this.status();
  }

  closeLog() {
    try {
      this.#logStream?.end();
    } catch {
      /* ignore */
    }
    this.#logStream = null;
  }
}

/** 定位内核二进制：环境变量优先，其次 PATH 常见位置 */
export function resolveCoreBinary({ env = process.env, exists = existsSync } = {}) {
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
