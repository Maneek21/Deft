import {createDraftRecoveryJournal,type RecordRecoveryScope} from './app-experience-draft-recovery';
import type {ExperienceRecordRow,ExperienceRecordWriterState,RecordSaveAttempt} from './app-experience-record-writer';
export type RecordSubmissionAttempt={key:string;purpose:'send';state:'pending';submissionId:string;sessionId:string;actionKey:string;revision:number;digest:string};
export type RecordRecoverySubmission=RecordSubmissionAttempt|{key:string;purpose:'save';state:'pending';attempt:RecordSaveAttempt};
type Payload={content:Record<string,unknown>;baseDigest:string};
export type RecordRecoveryCandidate={baseRevision:number;value:Payload;submission?:RecordRecoverySubmission};
export type RecordRecoveryState={candidate:RecordRecoveryCandidate|null;notice:string;ready:boolean;submission:RecordSubmissionAttempt|null};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b),uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(v);
/** Browser evidence never authorizes a save or submission. Only fresh host ports do. */
export function createRecordBrowserRecovery(options:{scope:RecordRecoveryScope;maxBytes:number;validate:(value:Record<string,unknown>)=>void;validateRestore?:(value:Record<string,unknown>,row:ExperienceRecordRow)=>void;current:()=>boolean;allowUnsavedSeed?:boolean;prove:(signal:AbortSignal)=>Promise<{scope:RecordRecoveryScope;row:ExperienceRecordRow}>;change:(state:RecordRecoveryState)=>void;now?:()=>number;leaseMs?:number}){
 const now=options.now??Date.now;let active=true,lease=0,journal:Awaited<ReturnType<typeof createDraftRecoveryJournal<Payload,RecordRecoverySubmission>>>|null=null;
 let pending:ExperienceRecordWriterState|null=null,tail=Promise.resolve(),blocked=true,submission:RecordRecoverySubmission|undefined;
 let state:RecordRecoveryState={candidate:null,notice:'Checking browser recovery…',ready:false,submission:null};
 const current=()=>active&&options.current(),authorized=()=>current()&&now()<lease;
 const emit=()=>{if(current())options.change(structuredClone(state));};
 const validate=(value:Payload)=>{if(!value||typeof value!=='object'||typeof value.baseDigest!=='string'||!/^sha256:[a-f0-9]{64}$/u.test(value.baseDigest))throw Error('Invalid browser record');options.validate(value.content);};
 const validateSubmission=(value:unknown)=>{if(value===null)return;if(!value||typeof value!=='object')throw Error('Invalid browser status');const v=value as RecordRecoverySubmission;
  if(v.key!==options.scope.recordId||v.state!=='pending')throw Error('Invalid browser status');if(v.purpose==='save'){if(!uuid(v.attempt?.requestId)||v.attempt.previous.record_id!==v.key||!Number.isSafeInteger(v.attempt.previous.revision)||v.attempt.previous.revision<(options.allowUnsavedSeed?0:1))throw Error('Invalid browser save');options.validate(v.attempt.captured);}
  else if(v.purpose!=='send'||!uuid(v.submissionId)||!uuid(v.sessionId)||!Number.isSafeInteger(v.revision)||v.revision<1||!/^sha256:[a-f0-9]{64}$/u.test(v.digest)||!v.actionKey||v.actionKey.length>80)throw Error('Invalid browser submission');};
 const unavailable=()=>{lease=0;state={...state,ready:false,notice:'Browser recovery is unavailable or full. Your current text and older recovery copies are kept.'};emit();};
 let proofTask:Promise<ExperienceRecordRow>|null=null,proofAbort:AbortController|null=null;
 // Resolve + current record reads can legitimately take longer than eight
 // seconds. Share only an in-flight read; every later proof starts fresh.
 const prove=()=>{if(proofTask)return proofTask;const controller=new AbortController();proofAbort=controller;let timeout:ReturnType<typeof setTimeout>|undefined;
  const task=(async()=>{try{const ended=new Promise<never>((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true});timeout=setTimeout(()=>controller.abort(Error('Recovery check timed out')),30000);});const proof=await Promise.race([options.prove(controller.signal),ended]);controller.signal.throwIfAborted();if(!current()||!same(proof.scope,options.scope))throw Error('Browser recovery account changed');lease=now()+(options.leaseMs??60000);return proof.row;}finally{clearTimeout(timeout);}})();
  proofTask=task;void task.finally(()=>{if(proofTask===task){proofTask=null;proofAbort=null;}}).catch(()=>{});return task;};
 const persist=async(snapshot:ExperienceRecordWriterState,attempt?:RecordRecoverySubmission)=>{if(!journal||!authorized())throw Error('Browser recovery paused');await journal.put(snapshot.row.revision,{content:snapshot.value,baseDigest:snapshot.row.content_digest},attempt);if(!authorized())throw Error('Browser recovery paused');};
 const flush=()=>{tail=tail.then(async()=>{while(pending&&!blocked&&authorized()){const next=pending;pending=null;await persist(next,submission);state={...state,ready:true,notice:next.dirty?'Saved in this browser · unsaved on server':'Browser recovery ready'};emit();}}).catch(()=>unavailable());return tail;};
 return {
  async start(server:ExperienceRecordRow){let timeout:ReturnType<typeof setTimeout>|undefined;try{await prove();const opened=await Promise.race([(async()=>{const opened=await createDraftRecoveryJournal<Payload,RecordRecoverySubmission>(options.scope,{recordMode:true,accountId:options.scope.accountId,maxBytes:Math.min(1048576,2*options.maxBytes+16384),validate,validateSubmission,authorize:authorized});return {opened,local:await opened.read()};})(),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{lease=0;reject(Error('Browser storage timed out'));},8000);})]);journal=opened.opened;const local=opened.local;if(!authorized())throw Error('Recovery access ended');
   const candidate=local&&(local.submission||!same(local.value.content,server.value))?local:null;submission=candidate?.submission;blocked=!!candidate;state={candidate,submission:submission?.purpose==='send'?submission:null,notice:candidate?'A browser draft is available. Your saved message is kept.':'Browser recovery ready',ready:true};emit();if(!blocked)await flush();return candidate;
  }catch{unavailable();return null;}finally{clearTimeout(timeout);}},
  record(next:ExperienceRecordWriterState){if(!current())return;pending=structuredClone(next);if(!blocked)void flush();},
  beforeSave(attempt:RecordSaveAttempt,latest:ExperienceRecordWriterState){const task=tail.then(async()=>{if(blocked)throw Error('Choose the browser recovery copy first');if(!authorized())await prove();submission={key:options.scope.recordId,purpose:'save',state:'pending',attempt:{...attempt,previous:{...attempt.previous,value:{}}}};await persist(latest,submission);});tail=task.catch(()=>unavailable());return task;},
  saved(){if(submission?.purpose==='save'){submission=undefined;blocked=false;state={...state,candidate:null,notice:'Saved status confirmed'};emit();}},
  beforeSubmit(attempt:RecordSubmissionAttempt,latest:ExperienceRecordWriterState){const task=tail.then(async()=>{if(blocked)throw Error('Choose the browser recovery copy first');await prove();validateSubmission(attempt);submission=attempt;await persist(latest,submission);state={...state,submission:attempt};emit();});tail=task.catch(()=>unavailable());return task;},
  confirmed(){const task=tail.then(async()=>{submission=undefined;if(journal&&authorized())await journal.clear();state={...state,candidate:null,submission:null};emit();});tail=task.catch(()=>unavailable());return tail;},
  async restore(server:ExperienceRecordWriterState){const candidate=state.candidate;if(!candidate||candidate.submission)return null;try{const row=await prove();if(row.status!=='draft'||server.dirty||row.revision!==candidate.baseRevision||row.content_digest!==candidate.value.baseDigest||!same(row.files??[],server.row.files??[]))throw Error('Saved revision changed');validate(candidate.value);options.validateRestore?.(candidate.value.content,row);blocked=false;state={...state,candidate:null,notice:'Browser draft restored. Review it before saving.'};emit();return candidate.value.content;}catch{state={...state,notice:'The saved draft changed or access ended. Your current text and recovery copy are kept.'};emit();return null;}},
  async keepCurrent(){if(submission)return false;try{await prove();if(journal)await journal.clear();blocked=false;state={...state,candidate:null,notice:'Your current draft is kept.'};emit();await flush();return true;}catch{unavailable();return false;}},
  async renew(){try{const row=await prove();if(!journal){await this.start(row);return;}state={...state,ready:true};emit();if(!blocked)await flush();}catch{unavailable();}},
  snapshot:()=>structuredClone(state),settled:()=>tail,
  dispose(){active=false;lease=0;proofAbort?.abort(Error('Recovery scope ended'));journal?.close();journal=null;},
 };
}
