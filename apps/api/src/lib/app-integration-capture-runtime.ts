import {and,eq,asc,sql} from 'drizzle-orm';
import {appInstallations,appVersions} from '@deft/db/schema';
import {appIntegrationCapturePolicies as policies} from '../../../../packages/db/src/app-integration-capture-schema.js';
import {AppIntegrationSourceIdentitySchema,type AppIntegrationSourceIdentity,type AppIntegrationSourceTarget,type AppIntegrationSourcePurpose} from '../../../../packages/app-kit/src/app-integration-source.js';
import type {AppDataRuntimeRequest} from '../../../../packages/app-kit/src/app-data.js';
import type {AppRunKeyProvider} from './app-run-keyrings.js';
import type {AppRunTransaction as Tx} from './app-run-repository.js';
import {createAppIntegrationSource,appIntegrationSourceDigest,type AppIntegrationSourceCaller,type AppIntegrationSourceAuthority,type AppIntegrationSourceSnapshot} from './app-integration-source.js';
import {createAppIntegrationPublicationReader} from './app-integration-source-publication.js';
import {createAppIntegrationSourceDispatcher} from './app-integration-source-dispatch.js';
import {createAppIntegrationCaptureStore} from './app-integration-capture-store.js';
import {createAppIntegrationCapture} from './app-integration-capture.js';
import {appIntegrationCaptureEvidence,extractAppIntegrationKnowledge} from './app-integration-capture-model.js';
import {loadAppIntegrationCitationSources,decorateAppIntegrationKnowledgeCitations,readAppIntegrationRelatedKnowledge} from './app-integration-knowledge-citations.js';

import {enqueue,enqueueOrRearmFailed,QUEUE_NAMES,RetryLaterJobError} from './queues.js';
import {hasAnyAIProvider} from './org-ai-config.js';
import type {JobData} from '../workers/types.js';
import {assertAppIntegrationCaptureDelivery,APP_INTEGRATION_CAPTURE_JOB} from './app-integration-capture-authority.js';

export {APP_INTEGRATION_CAPTURE_JOB};
export type AppIntegrationSourceAccount=Pick<AppIntegrationSourceIdentity,'installation_id'|'account_ref'|'store_key'>;
/** Authority lane supplies the concrete delegated journal/callback gateway.
 * This adapter supplies policy/queue fences and all actual destination writes. */
export interface AppIntegrationDataGateway {
 currentAccount(caller:AppIntegrationSourceCaller,account:AppIntegrationSourceAccount,purpose:AppIntegrationSourcePurpose,tx?:Tx):Promise<AppIntegrationSourceAuthority&{resource_binding_id:string;resource_key:string}>;
 mint(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,purpose:AppIntegrationSourcePurpose,operation:'resource_read_presentation'|'resource_read_metadata',input:Record<string,string>,max_ms:30000):Promise<AppDataRuntimeRequest>;
 dispatch(request:AppDataRuntimeRequest,signal:AbortSignal):Promise<{result?:unknown}>;
}
export function createAppIntegrationCaptureRuntime(input:{transaction<T>(fn:(tx:Tx)=>Promise<T>):Promise<T>;keys:AppRunKeyProvider;
 gateway:AppIntegrationDataGateway;clock?:()=>number}){
 const now=input.clock??Date.now,publication=createAppIntegrationPublicationReader(input);
 const store=createAppIntegrationCaptureStore({...input,enqueueEmbedding:async(tx,page_id,version,org_id)=>{await enqueue(QUEUE_NAMES.AGENT_JOBS,'embed-content',{source_type:'wiki_page',source_id:page_id,org_id},{orgId:org_id,dedupeKey:`app-integration-knowledge-embed:${page_id}:${version}`,executor:tx});}});
 const denied=()=>new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
 const policyGuard=async(tx:Tx,caller:AppIntegrationSourceCaller,target:AppIntegrationSourceAccount,job?:JobData)=>{
  const delivery=caller.capture_delivery;
  if(caller.kind!=='capture_policy'||!delivery||job&&(delivery.job_id!==job.id||delivery.lock_token!==job.lockToken||delivery.policy_revision!==job.data.policy_revision))throw denied();
  if(job&&job.name!==APP_INTEGRATION_CAPTURE_JOB)throw denied();return assertAppIntegrationCaptureDelivery(tx,caller,target,now());
 };
 const components=(job?:JobData,content:'presentation'|'metadata'='presentation')=>{
  const runtime=createAppIntegrationSourceDispatcher(input.gateway,content),resolveRuntime=createAppIntegrationSourceDispatcher(input.gateway,'metadata');
  const authority=async(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,purpose:AppIntegrationSourcePurpose,tx?:Tx):Promise<AppIntegrationSourceAuthority>=>{
   const check=async(transaction:Tx)=>{
    if((purpose==='knowledge_capture')!==(caller.kind==='capture_policy')
     ||(purpose==='notification_projection')!==(caller.kind==='notification_policy'))throw denied();
    const current=await input.gateway.currentAccount(caller,target,purpose,transaction);
    if(current.resource_binding_id!==target.resource_binding_id||current.resource_key!==target.ref.resource_key)throw denied();
    const policy=caller.kind==='capture_policy'?await policyGuard(transaction,caller,target,job):null;
    return {identity:policy?appIntegrationSourceDigest([current.identity,policy.policy.id,policy.policy.revision,job!.id,job!.lockToken]):current.identity,expires_at:Math.min(current.expires_at,policy?.expires??Infinity)};
   };return tx?check(tx):input.transaction(check);
  };
  const source=createAppIntegrationSource({authority,publication,runtime,clock:now});
  const resolve=async(caller:AppIntegrationSourceCaller,raw:AppIntegrationSourceIdentity,purpose:AppIntegrationSourcePurpose='read',signal?:AbortSignal)=>{
   const identity=AppIntegrationSourceIdentitySchema.parse(raw),current=await input.gateway.currentAccount(caller,identity,purpose);
   if(current.resource_key!==identity.ref.resource_key||current.expires_at<=now())throw denied();
   // A current scoped exact public read supplies the signed opaque sync identity.
   // No header, Message-ID, address or historical binding is a locator authority.
   const provisional={...identity,resource_binding_id:current.resource_binding_id,projection_id:'00000000-0000-4000-8000-000000000000'};
   if(caller.kind==='capture_policy')await input.transaction(tx=>policyGuard(tx,caller,identity,job));
   const fresh=await resolveRuntime(caller,provisional,purpose,signal);
   const target=await publication.resolve(caller,identity,current.resource_binding_id,fresh.resource);
   await authority(caller,target,purpose);return target;
  };
  return {source,resolve};
 };
 const human=components(),metadata=components(undefined,'metadata');
 const readIdentity=async(caller:AppIntegrationSourceCaller,identity:AppIntegrationSourceIdentity)=>human.source.read(caller,await human.resolve(caller,identity),'read');
 const schedule=async(policy:{org_id:string;id:string;revision:number},tx?:Tx)=>enqueueOrRearmFailed(QUEUE_NAMES.SCHEDULED_JOBS,APP_INTEGRATION_CAPTURE_JOB,{policy_id:policy.id,policy_revision:policy.revision},{orgId:policy.org_id,dedupeKey:appIntegrationSourceDigest([APP_INTEGRATION_CAPTURE_JOB,policy.id,policy.revision]),maxAttempts:5,executor:tx});
 let repairAfter:string|null=null;
 const openSnapshot=async(caller:AppIntegrationSourceCaller,snapshot:AppIntegrationSourceSnapshot)=>{
   const purpose=snapshot.purpose;if(purpose!=='read'&&purpose!=='transfer')throw denied();
   const navigation=await input.transaction(async tx=>{await human.source.guard(tx,caller,snapshot,purpose);const [row]=await tx.select({manifest:appVersions.manifest}).from(appInstallations).innerJoin(appVersions,and(eq(appVersions.id,appInstallations.active_version_id),eq(appVersions.org_id,caller.org_id),eq(appVersions.state,'active'))).where(and(eq(appInstallations.org_id,caller.org_id),eq(appInstallations.id,snapshot.publication.target.installation_id),eq(appInstallations.state,'active'))).limit(1);
    const manifest=row?.manifest as {record_stores?:Array<{key:string;source_projection?:{navigation_entry_key?:string}}>;experiences?:Array<{key:string}>}|undefined;
    const entry=manifest?.record_stores?.find(store=>store.key===snapshot.publication.target.store_key)?.source_projection?.navigation_entry_key;if(!entry||!manifest?.experiences?.some(value=>value.key===entry))throw denied();return entry;});
   return `/apps/${encodeURIComponent(snapshot.publication.target.installation_id)}/${encodeURIComponent(navigation)}?account_ref=${encodeURIComponent(snapshot.publication.target.account_ref)}&source_store_key=${encodeURIComponent(snapshot.publication.target.store_key)}&source_resource_key=${encodeURIComponent(snapshot.publication.target.ref.resource_key)}&source_record_id=${encodeURIComponent(snapshot.publication.target.ref.record_id)}&source_digest=${encodeURIComponent(snapshot.publication.target.ref.content_digest)}`;
 };
 const openIdentity=async(caller:AppIntegrationSourceCaller,identity:AppIntegrationSourceIdentity)=>openSnapshot(caller,await readIdentity(caller,identity));
 return {
  policyAuthority:async(caller:AppIntegrationSourceCaller,account:AppIntegrationSourceAccount,tx?:Tx)=>{const check=async(transaction:Tx)=>{const value=await policyGuard(transaction,caller,account);return {identity:appIntegrationSourceDigest([value.policy.id,value.policy.revision,caller.capture_delivery]),expires_at:value.expires};};return tx?check(tx):input.transaction(check);},
  source:human.source,resolve:human.resolve,readIdentity,metadataSource:metadata.source,resolveMetadata:metadata.resolve,
  async resolveOpaque(caller:AppIntegrationSourceCaller,account:AppIntegrationSourceAccount,logical_id:string,purpose:AppIntegrationSourcePurpose='tool_read',signal?:AbortSignal){
   if(typeof logical_id!=='string'||!logical_id||logical_id.length>256||purpose==='knowledge_capture')throw denied();
   const current=await input.gateway.currentAccount(caller,account,purpose);
   if(current.expires_at<=now())throw denied();
   const target=await publication.resolveProjectionIdentity(caller,{...account,resource_key:current.resource_key},current.resource_binding_id,logical_id);
   // The opaque App scalar nominates one encrypted published row; disclosure
   // still requires the exact current Runtime UUID/digest and independent grant.
   const snapshot=await human.source.read(caller,target,purpose,signal);
   const after=await input.gateway.currentAccount(caller,account,purpose);
   if(after.resource_binding_id!==current.resource_binding_id||after.resource_key!==current.resource_key||after.identity!==current.identity||after.expires_at<=now())throw denied();
   return snapshot;
  },
  async settings(caller:AppIntegrationSourceCaller,identity:AppIntegrationSourceIdentity){const snapshot=await metadata.source.read(caller,await metadata.resolve(caller,identity),'read');return input.transaction(async tx=>{await metadata.source.guard(tx,caller,snapshot,'read');const result=await store.settings(tx,caller,snapshot.publication.target);await metadata.source.guard(tx,caller,snapshot,'read');return result;});},
  async write(caller:AppIntegrationSourceCaller,identity:AppIntegrationSourceIdentity,policy:unknown){const snapshot=await metadata.source.read(caller,await metadata.resolve(caller,identity),'read');return store.writePolicy(caller,snapshot.publication.target,policy,tx=>metadata.source.guard(tx,caller,snapshot,'read'),async(tx,value)=>{if(value.enabled)await schedule({org_id:caller.org_id,id:value.id,revision:value.revision},tx);});},
  async related(caller:AppIntegrationSourceCaller,identity:AppIntegrationSourceIdentity){const snapshot=await readIdentity(caller,identity);return input.transaction(tx=>readAppIntegrationRelatedKnowledge(tx,caller,snapshot,()=>human.source.guard(tx,caller,snapshot,'read')));},
  async citations<T extends {source_type:string;source_id:string}>(caller:AppIntegrationSourceCaller,citations:T[]){const records=await input.transaction(tx=>loadAppIntegrationCitationSources(tx,caller,citations.filter(row=>row.source_type==='app_integration').slice(0,32).map(row=>row.source_id)));return decorateAppIntegrationKnowledgeCitations({caller,citations,records,read:readIdentity});},
  openIdentity,openSnapshot,
  async open(caller:AppIntegrationSourceCaller,id:string){const [record]=await input.transaction(tx=>loadAppIntegrationCitationSources(tx,caller,[id]));if(!record||record.owner_user_id!==caller.user_id)throw denied();
   const href=await openIdentity(caller,record.target as AppIntegrationSourceIdentity);
   const [current]=await input.transaction(tx=>loadAppIntegrationCitationSources(tx,caller,[id]));if(!current||current.owner_user_id!==caller.user_id)throw denied();return href;
  },
  async repair(){const rows=await input.transaction(tx=>tx.select().from(policies).where(and(eq(policies.enabled,true),repairAfter?sql`${policies.id}>${repairAfter}`:undefined)).orderBy(asc(policies.id)).limit(100));for(const row of rows)await schedule(row);repairAfter=rows.length===100?rows.at(-1)!.id:null;},
  async run(job:JobData){if(!job.lockToken||job.name!==APP_INTEGRATION_CAPTURE_JOB||typeof job.data.policy_id!=='string'||!Number.isSafeInteger(job.data.policy_revision))throw denied();
   const [row]=await input.transaction(tx=>tx.select().from(policies).where(and(eq(policies.id,job.data.policy_id),eq(policies.revision,job.data.policy_revision),eq(policies.enabled,true))).limit(1));if(!row)return;
   const caller:AppIntegrationSourceCaller={org_id:row.org_id,user_id:row.owner_user_id,kind:'capture_policy',principal_id:row.id,capture_delivery:{job_id:job.id,lock_token:job.lockToken,policy_revision:row.revision}};await input.transaction(tx=>policyGuard(tx,caller,row,job));
   // Missing workspace AI is recoverable setup, not a failed message claim.
   // Wait before reserving budget or consuming an observation so configuring a
   // provider can resume the same source without losing its capture attempt.
   if(!await hasAnyAIProvider(row.org_id))throw new RetryLaterJobError('App Knowledge needs an AI provider',60000);
   const current=await input.gateway.currentAccount(caller,row,'knowledge_capture'),batch=await publication.candidates(caller,{...row,resource_key:current.resource_key},current.resource_binding_id,{checkpoint_id:row.scan_checkpoint_id,after:row.scan_after_projection_id});
   const capture=components(job),service=createAppIntegrationCapture({...store,source:capture.source,evidence:appIntegrationCaptureEvidence,extract:extractAppIntegrationKnowledge});
   const result=batch.target?await service.process(caller,batch.target,row.revision,job.signal):{state:'idle'};
   await input.transaction(async tx=>{await policyGuard(tx,caller,row,job);await tx.update(policies).set({scan_checkpoint_id:batch.checkpoint_id,scan_after_projection_id:batch.target?.projection_id??null}).where(and(eq(policies.org_id,row.org_id),eq(policies.id,row.id),eq(policies.revision,row.revision),eq(policies.enabled,true)));});
   throw new RetryLaterJobError('App Knowledge '+result.state,result.state==='idle'?30000:1000);
  },
 };
}
