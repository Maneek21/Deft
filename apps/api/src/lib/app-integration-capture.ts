import {z} from 'zod';
import {AppIntegrationCapturePolicyInputSchema,type AppIntegrationCapturePolicyInput,type AppIntegrationSourceTarget} from '../../../../packages/app-kit/src/app-integration-source.js';
import {appIntegrationSourceDigest,type AppIntegrationSourceCaller,type AppIntegrationSourceSnapshot} from './app-integration-source.js';

export type AppIntegrationCapturePolicy=AppIntegrationCapturePolicyInput&{id:string;revision:number;history_since:string};
export type AppIntegrationCaptureEvidence={eligible:boolean;reason?:string;body?:string;sender?:string;
 received_at?:string|null;thread_key?:string;body_digest?:string;partial:true;attachments_processed:false};
export type AppIntegrationCaptureThread={page_id:string;page_version:number;live_version:number;is_deleted:boolean;content:string;last_observed_at:string};
export const AppIntegrationCaptureExtractionSchema=z.strictObject({capture:z.boolean(),title:z.string().max(160),
 type:z.enum(['decision','procedure','resource','concept','fact']),content:z.string().max(10000),excerpt:z.string().max(1200)});
export type AppIntegrationCaptureExtraction=z.infer<typeof AppIntegrationCaptureExtractionSchema>;
export interface AppIntegrationCapturePorts<Tx> {
 transaction<T>(fn:(tx:Tx)=>Promise<T>):Promise<T>;
 source:{read(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,purpose:'knowledge_capture',signal?:AbortSignal):Promise<AppIntegrationSourceSnapshot>;
 guard(tx:Tx,caller:AppIntegrationSourceCaller,snapshot:AppIntegrationSourceSnapshot,purpose:'knowledge_capture'):Promise<void>};
 policy(tx:Tx,caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget):Promise<AppIntegrationCapturePolicy>;
 destination(tx:Tx,caller:AppIntegrationSourceCaller,policy:AppIntegrationCapturePolicy):Promise<void>;
 evidence(snapshot:AppIntegrationSourceSnapshot,policy:AppIntegrationCapturePolicy):Promise<AppIntegrationCaptureEvidence>;
 thread(tx:Tx,caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,policy:AppIntegrationCapturePolicy,key:string):Promise<AppIntegrationCaptureThread|null>;
 claim(tx:Tx,caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,policy:AppIntegrationCapturePolicy,evidence:AppIntegrationCaptureEvidence):Promise<string|null>;
 skipped(tx:Tx,claim_id:string,caller:AppIntegrationSourceCaller,reason:string):Promise<void>;
 reserveBudget(tx:Tx,caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,tokens:number):Promise<Record<string,unknown>>;
 extract(input:{org_id:string;org_config:Record<string,unknown>;body:string;sender:string;date:string|null;previous:string|null}):Promise<unknown>;
 commit(tx:Tx,input:{claim_id:string;caller:AppIntegrationSourceCaller;snapshot:AppIntegrationSourceSnapshot;policy:AppIntegrationCapturePolicy;
 evidence:AppIntegrationCaptureEvidence;extracted:AppIntegrationCaptureExtraction;prior:AppIntegrationCaptureThread|null}):Promise<{state:string;page_id?:string}>;
 failed(claim_id:string,caller:AppIntegrationSourceCaller,error:string):Promise<void>;
}
const denied=()=>new Error('APP_INTEGRATION_CAPTURE_CHANGED_OR_DENIED');
export function createAppIntegrationCapture<Tx>(ports:AppIntegrationCapturePorts<Tx>){
 return {async process(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,revision:number,signal?:AbortSignal):Promise<{state:string;page_id?:string;reason?:string}>{
  if(caller.kind!=='capture_policy')throw denied();
  const snapshot=await ports.source.read(caller,target,'knowledge_capture',signal);
  const current=async(tx:Tx)=>{
   await ports.source.guard(tx,caller,snapshot,'knowledge_capture');
   const policy=await ports.policy(tx,caller,target);
   const {id:unusedId,revision:unusedRevision,history_since:unusedSince,...policyInput}=policy;void unusedId;void unusedRevision;void unusedSince;
   AppIntegrationCapturePolicyInputSchema.parse(policyInput);
   if(!policy.enabled||policy.id!==caller.principal_id||policy.revision!==revision)throw denied();
   await ports.destination(tx,caller,policy);signal?.throwIfAborted();return policy;
  };
  const policy=await ports.transaction(current);let evidence=await ports.evidence(snapshot,policy);
  if(evidence.received_at&&Date.parse(evidence.received_at)<Date.parse(policy.history_since))evidence={...evidence,eligible:false,reason:'before_history_window'};
  if(!evidence.eligible){
   const reason=evidence.reason??'ineligible';
   await ports.transaction(async tx=>{await current(tx);const claim_id=await ports.claim(tx,caller,target,policy,{...evidence,
    thread_key:appIntegrationSourceDigest(target.ref.record_id),body_digest:appIntegrationSourceDigest(target.ref.content_digest)});
    if(claim_id)await ports.skipped(tx,claim_id,caller,reason);});return {state:'skipped',reason};
  }
  if(!evidence.body||evidence.body.length<40||evidence.body.length>16000||!evidence.thread_key||!evidence.body_digest
   ||evidence.body_digest!==appIntegrationSourceDigest(evidence.body)||!evidence.partial||evidence.attachments_processed)throw denied();
  const prepared=await ports.transaction(async tx=>{
   await current(tx);
   const prior=await ports.thread(tx,caller,target,policy,evidence.thread_key!);
   if(prior&&(prior.is_deleted||prior.live_version!==prior.page_version)){
    const claim_id=await ports.claim(tx,caller,target,policy,evidence);if(claim_id)await ports.skipped(tx,claim_id,caller,'protected');return {state:'protected' as const};
   }
   if(prior&&snapshot.publication.observed_at<prior.last_observed_at){
    const claim_id=await ports.claim(tx,caller,target,policy,evidence);if(claim_id)await ports.skipped(tx,claim_id,caller,'older_evidence');return {state:'older_evidence' as const};
   }
   const claim_id=await ports.claim(tx,caller,target,policy,evidence);if(!claim_id)return {state:'duplicate' as const};
   // Both account and org reservations and the unique claim commit together.
   // A model failure retains this reservation and cannot trigger another call.
   const org_config=await ports.reserveBudget(tx,caller,target,Buffer.byteLength(evidence.body!+(prior?.content.slice(0,10000)??''),'utf8')+4248);
   await current(tx);return {state:'ready' as const,claim_id,prior,org_config};
  });
  if(prepared.state!=='ready')return {state:prepared.state};
  try{
   signal?.throwIfAborted();
   const extracted=AppIntegrationCaptureExtractionSchema.parse(await ports.extract({org_id:caller.org_id,org_config:prepared.org_config,
    body:evidence.body,sender:evidence.sender??'Unknown sender',date:evidence.received_at??null,previous:prepared.prior?.content.slice(0,10000)??null}));
   if(extracted.capture&&(!extracted.title.trim()||!extracted.content.trim()||extracted.excerpt.length<20||!evidence.body.includes(extracted.excerpt)))throw new Error('APP_INTEGRATION_CAPTURE_INVALID_EVIDENCE');
   // New exact public Runtime read after extraction, outside destination locks.
   const fresh=await ports.source.read(caller,target,'knowledge_capture',signal);
   return await ports.transaction(async tx=>{
    await ports.source.guard(tx,caller,fresh,'knowledge_capture');
    await current(tx);
    const result=await ports.commit(tx,{claim_id:prepared.claim_id,caller,snapshot:fresh,policy,evidence,extracted,prior:prepared.prior});
    await current(tx);await ports.source.guard(tx,caller,fresh,'knowledge_capture');signal?.throwIfAborted();return result;
   });
  }catch(error){
   const code=error instanceof Error&&/^APP_INTEGRATION_[A-Z_]+$/u.test(error.message)?error.message:'APP_INTEGRATION_CAPTURE_MODEL_OR_SOURCE_UNAVAILABLE';
   await ports.failed(prepared.claim_id,caller,code);throw error;
  }
 }};
}
