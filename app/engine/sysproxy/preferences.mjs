// Private IPC to the bundled, unprivileged macOS SCPreferences helper.
// Raw dictionaries remain opaque property lists: never expose them in API/UI/errors.
import { execFile } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute } from 'node:path';
const failure = () => Object.assign(new Error('系统代理事务未获完整验证；恢复日志已保留，请检查原设置'), {code:'RECOVERY_REQUIRED'});
// Only a verified pre-write denial may receive this actionable classification.
// This describes this operation, not the state left by any earlier transaction.
const responseFailure = result => result?.ok === false && result.code === 'AUTHORIZATION_REQUIRED' && result.committed === false
  ? Object.assign(new Error('系统代理授权尚未接入；本次操作未写入系统设置。若有待恢复记录，请保留并检查原设置。'), {code:'SYS_PROXY_AUTHORIZATION_REQUIRED'})
  : failure();
export function validateRawSnapshot(value) {
  if (!value || value.schema !== 3 || !Array.isArray(value.services) || !value.services.length || value.services.length > 128) throw failure();
  const ids=new Set();
  for(const service of value.services) {
    if(!service || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(service.id) || ids.has(service.id.toLowerCase()) ||
      !['name','device'].every(k=>typeof service[k]==='string' && service[k].length>0 && service[k].length<1024 && !/[\x00-\x1f]/.test(service[k]))) throw failure();
    ids.add(service.id.toLowerCase()); const p=service.proxies;
    if(!p || typeof p.present!=='boolean' || (!p.present && p.blob!==null) || (p.present && (typeof p.blob!=='string' || p.blob.length>1048576 || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.blob)))) throw failure();
  }
  return value;
}
export function createPreferencesInvoker(helperPath) {
  return request => new Promise((resolve,reject)=>{
    if(typeof helperPath!=='string' || !isAbsolute(helperPath)) return reject(failure());
    const env={...process.env};delete env.JMS_API_TOKEN;delete env.JMS_INSTANCE_ID;
    const child=execFile(helperPath,[],{env,timeout:10000,maxBuffer:4*1024*1024,encoding:'utf8'},(error,stdout)=>{
      // Never propagate child stdout/stderr or request payload into logs/errors.
      if(error) return reject(failure());
      try{resolve(JSON.parse(stdout));}catch{reject(failure());}
    });
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));
  });
}
export function createDarwinPreferencesAdapter({invoke=createPreferencesInvoker(process.env.JMS_PROXY_HELPER),readPublic}={}) {
  let restorationProof=null;
  const call=async(request,allowAuthorization=true)=>{let result;try{result=await invoke(request);}catch{throw failure();}if(!result || result.ok!==true) throw allowAuthorization ? responseFailure(result) : failure();return result;};
  const snapshotRaw=async(allowAuthorization=true)=>validateRawSnapshot((await call({operation:'snapshot'},allowAuthorization)).snapshot);
  const validateEntry=entry=>{
    if(!entry || entry.version!==2 || entry.platform!=='darwin' || entry.darwin?.schema!==3) throw failure();
    validateRawSnapshot(entry.previousBase);validateRawSnapshot(entry.darwin.targetBase);
    if(!isDeepStrictEqual(entry.previousBase,entry.darwin.originalBase)) throw failure();
    const identities=b=>b.services.map(({proxies,...s})=>s);
    if(!isDeepStrictEqual(identities(entry.previousBase),identities(entry.darwin.targetBase))) throw failure();
    return entry;
  };
  const transact=async(journal,restore)=>{
    restorationProof=null;
    const entry=validateEntry(journal?.read());const current=await snapshotRaw();
    if(!isDeepStrictEqual(current,entry.previousBase) && !isDeepStrictEqual(current,entry.darwin.targetBase)) throw failure();
    const desired=restore?entry.previousBase:entry.darwin.targetBase;
    // Intent is durable before every CAS, including retry after commit but before Apply.
    journal.updateDarwin({...entry.darwin,intent:restore?'restore':'apply',outcome:'pending'});
    let result;
    try{result=await invoke({operation:'compareAndSet',expected:current,desired});}catch{throw failure();}
    if(!result || result.ok!==true || result.committed!==true || result.applied!==true || !isDeepStrictEqual(result.snapshot,desired)) {
      journal.updateDarwin({...entry.darwin,intent:restore?'restore':'apply',outcome:'unverified',committed:result?.committed===true?true:result?.committed===false?false:'unknown',applied:result?.applied===true});
      throw responseFailure(result);
    }
    if(!isDeepStrictEqual(await snapshotRaw(false),desired)) throw failure();
    journal.updateDarwin({...entry.darwin,intent:restore?'restore':'apply',outcome:'verified',committed:true,applied:true});
    if(restore) restorationProof=structuredClone(desired);
  };
  return {
    platform:'darwin',transactionVersion:3,
    async read(){if(typeof readPublic!=='function')throw failure();return readPublic();},
    async snapshot(){const base=await snapshotRaw();const summary=typeof readPublic==='function'?await readPublic():{mode:'off'};return{...summary,base};},
    async prepareTransaction(snap,target){
      const response=await call({operation:'prepare',target:{host:target.host,port:target.port,bypass:target.bypass??['localhost','127.0.0.1','::1']}});
      validateRawSnapshot(response.original);validateRawSnapshot(response.target);
      if(!isDeepStrictEqual(snap.base,response.original))throw failure();
      return{schema:3,originalBase:response.original,targetBase:response.target};
    },
    async apply(_target,{journal}={}){await transact(journal,false);},
    async restore(base,{journal}={}){const entry=validateEntry(journal?.read());if(!isDeepStrictEqual(base,entry.previousBase))throw failure();await transact(journal,true);},
    async verifyRestored(entry){validateEntry(entry);return isDeepStrictEqual(restorationProof,entry.previousBase)&&isDeepStrictEqual(await snapshotRaw(false),entry.previousBase);}
  };
}
