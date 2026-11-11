// The only interactive-operation input is an owned Native child's private pipe.
// No HTTP request, environment boolean or background event can arm this bridge.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createDarwinPreferencesAdapter, createPreferencesInvoker, validateRawSnapshot } from './sysproxy/preferences.mjs';

export const MAX_NATIVE_FRAME = 8 * 1024 * 1024;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value);
const digestOf = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (code = 'RECOVERY_REQUIRED') => Object.assign(new Error('原生系统代理事务尚未确认；请保留恢复日志并检查当前状态'), { code });
const fields = (value, required) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === required.length && required.every(key => Object.hasOwn(value, key));
function decodeBytes(value) {
  if (typeof value !== 'string' || value.length > MAX_NATIVE_FRAME || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw failure();
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > MAX_NATIVE_FRAME || bytes.toString('base64') !== value) throw failure();
  return bytes;
}
function parseBytes(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw failure(); }
}

export class NativeFrameDecoder {
  constructor(receive, fail = () => {}) { this.receive = receive; this.fail = fail; this.buffer = Buffer.alloc(0); this.closed = false; }
  push(chunk) {
    if (this.closed) return;
    try {
      // Check before concatenating; a producer may not queue arbitrary raw data.
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
      if (this.buffer.length + chunk.length > MAX_NATIVE_FRAME + 1) throw failure('NATIVE_PROTOCOL');
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const index = this.buffer.indexOf(10);
        if (index < 0) break;
        const line = this.buffer.subarray(0, index); this.buffer = this.buffer.subarray(index + 1);
        if (!line.length || line.length > MAX_NATIVE_FRAME) throw failure('NATIVE_PROTOCOL');
        this.receive(parseBytes(line));
      }
    } catch { this.close(); this.fail(failure('NATIVE_PROTOCOL')); }
  }
  close() { this.closed = true; this.buffer = Buffer.alloc(0); }
  end() { const partial = this.buffer.length; this.close(); if (partial) this.fail(failure('NATIVE_PROTOCOL')); }
}

function preparedPayload(response, operationId, planDigest, plan) {
  if (!fields(response, ['ok','phase','operationId','planDigest','preparedDigest','preparedData']) || response.ok !== true || response.phase !== 'prepared' ||
      response.operationId !== operationId || response.planDigest !== planDigest || !/^[0-9a-f]{64}$/.test(response.preparedDigest)) throw failure();
  const bytes = decodeBytes(response.preparedData);
  if (digestOf(bytes) !== response.preparedDigest) throw failure();
  const value = parseBytes(bytes);
  if (!fields(value, ['original','target','current','desired'])) throw failure();
  for (const snapshot of Object.values(value)) validateRawSnapshot(snapshot);
  const identities = snapshot => snapshot.services.map(({proxies,...identity}) => identity);
  if (!isDeepStrictEqual(identities(value.original), identities(value.target))) throw failure();
  if (plan.action === 'apply') {
    if (!isDeepStrictEqual(value.current, value.original) || !isDeepStrictEqual(value.original, plan.expected) || !isDeepStrictEqual(value.desired, value.target)) throw failure();
  } else if (!isDeepStrictEqual(value.original, plan.original) || !isDeepStrictEqual(value.target, plan.proxyTarget) ||
      !isDeepStrictEqual(value.desired, value.original) ||
      (!isDeepStrictEqual(value.current, value.original) && !isDeepStrictEqual(value.current, value.target))) throw failure();
  return value;
}
function checkedFailure(response, operationId, planDigest, preparedDigest) {
  const keys = ['ok','phase','operationId','planDigest','code','committed',...(preparedDigest ? ['preparedDigest'] : [])];
  if (!fields(response,keys) || response.ok !== false || response.phase !== 'finished' || response.operationId !== operationId ||
      response.planDigest !== planDigest || !/^[A-Z_]{1,64}$/.test(response.code || '') ||
      ![true,false,'unknown'].includes(response.committed) || (!preparedDigest && response.committed !== false) ||
      (preparedDigest && response.preparedDigest !== preparedDigest)) throw failure();
  return response;
}

// An operation-local adapter reuses the reviewed WAL ordering and raw-journal
// validation. It cannot launch an interactive helper; Native owns that process.
function operationAdapter({app, launchId, operationId, action, helper, observe, assertCurrent}) {
  let prepared, proof, preparedDigest, planDigest, plan, commitSent = false;
  const prepare = async () => {
    if (prepared) return prepared;
    if (commitSent) throw failure();
    await assertCurrent();
    plan = {version:1,launchId,operationId,action:action === 'connect' ? 'apply' : 'restore'};
    if (action === 'connect') {
      plan.target = {host:'127.0.0.1',port:(app.sessionSettings || app.store.state.settings).port,bypass:['localhost','127.0.0.1','::1']};
      // Bind the settings the user is about to review BEFORE authorization.
      // The helper must reject a lock-time change, never silently re-plan it.
      plan.expected = validateRawSnapshot(await observe());
      await assertCurrent();
    }
    else {
      const entry = app.journal.read();
      if (entry?.version !== 2 || entry.platform !== 'darwin' || entry.previousBase?.schema !== 3 || entry.darwin?.schema !== 3 ||
          !isDeepStrictEqual(entry.previousBase, entry.darwin.originalBase) || Object.hasOwn(entry.darwin, 'states')) throw failure();
      plan.original = validateRawSnapshot(entry.previousBase); plan.proxyTarget = validateRawSnapshot(entry.darwin.targetBase);
    }
    const bytes = Buffer.from(JSON.stringify(plan));
    if (bytes.length > MAX_NATIVE_FRAME / 2) throw failure();
    planDigest = digestOf(bytes);
    const response = await helper({operation:'interactivePrepare',operationId,planDigest,planData:bytes.toString('base64')}, planDigest);
    if (response?.ok !== true) return checkedFailure(response,operationId,planDigest);
    prepared = preparedPayload(response, operationId, planDigest, plan);
    preparedDigest = response.preparedDigest;
    return prepared;
  };
  const adapter = createDarwinPreferencesAdapter({readPublic: () => app.adapter.read(),invoke: async request => {
    const p = await prepare();
    if (!p || p.ok === false) return p;
    if (request.operation === 'snapshot') {
      if (!commitSent) return {ok:true,snapshot:p.current};
      if (!proof) throw failure();
      // A separate non-authorizing process supplies a fresh stable observation.
      // Cached helper claims alone can never justify clearing the journal.
      const observed = await observe();
      validateRawSnapshot(observed);
      if (!isDeepStrictEqual(observed, p.desired)) throw failure();
      await assertCurrent();
      return {ok:true,snapshot:observed};
    }
    if (request.operation === 'prepare') {
      if (plan.action !== 'apply' || !isDeepStrictEqual(request.target, plan.target)) throw failure();
      return {ok:true,original:p.original,target:p.target};
    }
    if (request.operation !== 'compareAndSet' || commitSent || !isDeepStrictEqual(request.expected,p.current) || !isDeepStrictEqual(request.desired,p.desired)) throw failure();
    await assertCurrent();
    // Revalidate exactly the persisted transaction, never just a same-shaped log.
    const entry = app.journal.read();
    if (!isDeepStrictEqual(entry?.previousBase,p.original) || !isDeepStrictEqual(entry?.darwin?.targetBase,p.target) ||
        entry?.darwin?.outcome !== 'pending' || entry.darwin.intent !== (action === 'connect' ? 'apply' : 'restore')) throw failure();
    commitSent = true; // Unknown delivery is still permission sent, never retry.
    const response = await helper({operation:'interactiveCommit',operationId,planDigest,preparedDigest}, planDigest);
    if (response?.ok !== true) return checkedFailure(response,operationId,planDigest,preparedDigest);
    if (!fields(response,['ok','phase','operationId','planDigest','preparedDigest','snapshot','verifiedSnapshot','committed','applied']) ||
        response.phase !== 'finished' || response.operationId !== operationId || response.planDigest !== planDigest || response.preparedDigest !== preparedDigest ||
        response.committed !== true || response.applied !== true || !isDeepStrictEqual(response.snapshot,p.desired) || !isDeepStrictEqual(response.verifiedSnapshot,p.desired)) throw failure();
    await assertCurrent();
    proof = response;
    return {ok:true,snapshot:response.snapshot,committed:true,applied:true};
  }});
  adapter.assertCurrent = assertCurrent;
  return adapter;
}

export class NativeProxyCoordinator {
  constructor({app,launchId,send,observe = async () => {
    const result = await createPreferencesInvoker(process.env.JMS_PROXY_HELPER)({operation:'observe'});
    if (result?.ok !== true) throw failure(); return result.snapshot;
  },prepareTimeoutMs=240000,commitTimeoutMs=60000}={}) {
    if (!app || !identifier(launchId) || typeof send !== 'function') throw failure('NATIVE_PROTOCOL');
    Object.assign(this,{app,launchId,send,observe,prepareTimeoutMs,commitTimeoutMs});
    this.seen = new Set(); this.closed = false; this.active = null;
  }
  hello() { this.#send({version:1,type:'hello',launchId:this.launchId}); }
  #send(frame) { if (this.closed) throw failure('NATIVE_PROTOCOL'); if (Buffer.byteLength(JSON.stringify(frame)) > MAX_NATIVE_FRAME) throw failure(); this.send(frame); }
  handle(frame) {
    if (this.closed) return;
    if (!frame || frame.version !== 1 || frame.launchId !== this.launchId || !identifier(frame.operationId)) throw failure('NATIVE_PROTOCOL');
    if (frame.type === 'begin') {
      if (!fields(frame,['version','type','launchId','operationId','action']) || !['connect','disconnect'].includes(frame.action)) throw failure('NATIVE_PROTOCOL');
      if (this.app.isolated) { this.#complete(frame.operationId,false,'ISOLATED'); return; }
      if (this.active || this.app.busy || this.seen.has(frame.operationId) || this.seen.size >= 4096 || !this.app.nativeControl || this.app.adapter.platform !== 'darwin') {
        this.#complete(frame.operationId,false,'NATIVE_OPERATION_REJECTED'); return;
      }
      this.seen.add(frame.operationId);
      const active = this.active = {id:frame.operationId,sequence:0,commitSent:false,pending:null};
      active.task = this.#run(frame.action,active);
      return;
    }
    const active = this.active;
    if (!active || active.id !== frame.operationId) throw failure('NATIVE_PROTOCOL');
    if (frame.type === 'cancel') {
      if (!fields(frame,['version','type','launchId','operationId'])) throw failure('NATIVE_PROTOCOL');
      active.cancelled = true; active.pending?.reject(failure(active.commitSent ? 'RECOVERY_REQUIRED' : 'CANCELLED')); return;
    }
    if (frame.type !== 'helper-result' || !fields(frame,['version','type','launchId','operationId','sequence','planDigest','response']) ||
        !active.pending || frame.sequence !== active.sequence || frame.planDigest !== active.pending.planDigest) throw failure('NATIVE_PROTOCOL');
    const pending = active.pending; active.pending = null; pending.resolve(frame.response);
  }
  #complete(operationId,ok,code) {
    try { this.#send({version:1,type:'complete',launchId:this.launchId,operationId,ok,...(ok?{result:{confirmed:true,helperUsed:(this.active?.sequence || 0)>0}}:{code,message:'系统代理操作尚未确认，请检查恢复状态；没有自动提权'})}); }
    catch { this.close(); }
  }
  async #run(action,active) {
    const helper = (request,planDigest) => new Promise((resolve,reject) => {
      if (this.closed || this.active !== active || active.cancelled) return reject(failure(active.commitSent?'RECOVERY_REQUIRED':'CANCELLED'));
      active.sequence++;
      if (active.sequence > 2 || (active.sequence === 1) !== (request.operation === 'interactivePrepare')) return reject(failure());
      if (active.sequence === 2) active.commitSent = true;
      const timer = setTimeout(() => { if (active.pending === pending) active.pending = null; reject(failure(active.commitSent?'RECOVERY_REQUIRED':'AUTHORIZATION_TIMEOUT')); },active.sequence === 1?this.prepareTimeoutMs:this.commitTimeoutMs);
      const pending = active.pending = {planDigest,resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);active.pending=null;reject(error);}};
      try { this.#send({version:1,type:'helper',launchId:this.launchId,operationId:active.id,sequence:active.sequence,planDigest,request}); }
      catch { pending.reject(failure()); }
    });
    const ownedSession = this.app.nativeProxyGuard(action);
    const assertCurrent = async () => {
      if (this.closed || this.active !== active || active.cancelled) throw failure();
      await ownedSession();
      if (this.closed || this.active !== active || active.cancelled) throw failure();
    };
    const proxyAdapter = operationAdapter({app:this.app,launchId:this.launchId,operationId:active.id,action,helper,observe:this.observe,assertCurrent});
    try {
      if (action === 'connect') {
        if (this.app.store.state.settings.mode !== 'sysproxy') throw failure('UNSUPPORTED_MODE');
        await this.app.connect({proxyAdapter});
      } else await this.app.disconnect({proxyAdapter});
      if (this.active === active && !this.closed) this.#complete(active.id,true);
    } catch (error) {
      if (this.active === active && !this.closed) this.#complete(active.id,false,/^[A-Z_]{1,64}$/.test(error.code||'')?error.code:'RECOVERY_REQUIRED');
    } finally { active.pending?.reject(failure()); if (this.active === active) this.active = null; }
  }
  async idle() { await this.active?.task; }
  close() { this.closed = true; this.active?.pending?.reject(failure()); }
}

export function attachNativeProxyControl({app,launchId,input,output,...options}) {
  const coordinator = new NativeProxyCoordinator({app,launchId,...options,send:frame=>{
    const bytes=JSON.stringify(frame)+'\n';
    if (output.writableLength + Buffer.byteLength(bytes) > MAX_NATIVE_FRAME + 1) throw failure('NATIVE_PROTOCOL');
    output.write(bytes);
  }});
  const decoder = new NativeFrameDecoder(frame=>coordinator.handle(frame),()=>coordinator.close());
  const push = chunk=>decoder.push(chunk);
  const ended = ()=>{decoder.end();coordinator.close();};
  const close = coordinator.close.bind(coordinator);
  coordinator.close = () => {
    close(); decoder.close();
    input.off('data',push); input.off('end',ended);
    // Otherwise the still-open private stdin pipe pins an already-drained Node
    // process forever after SIGTERM. This destroys only our dedicated channel.
    input.pause(); input.destroy();
  };
  input.on('data',push);
  input.on('end',ended);
  input.on('error',()=>coordinator.close()); output.on('error',()=>coordinator.close());
  coordinator.hello();
  return coordinator;
}
