import {randomUUID} from 'node:crypto';
import {and,eq,or,sql,desc} from 'drizzle-orm';
import {orgs,orgMembers,users,spaces,spaceMembers,wikiPages,wikiPageVersions,wikiCitations,appRuntimeSessions,appRuntimeBindings,appResourceBindings} from '@deft/db/schema';
import {appIntegrationCapturePolicies as policies,appIntegrationCaptureClaims as claims,appIntegrationCaptureThreads as threads,appIntegrationCaptureSources as sources} from '../../../../packages/db/src/app-integration-capture-schema.js';
import {AppIntegrationCapturePolicyInputSchema,type AppIntegrationSourceTarget} from '../../../../packages/app-kit/src/app-integration-source.js';
import type {AppRunTransaction as Tx} from './app-run-repository.js';
import type {AppIntegrationSourceCaller} from './app-integration-source.js';
import type {AppIntegrationCapturePolicy,AppIntegrationCapturePorts} from './app-integration-capture.js';
import {createNativeKnowledge} from './native-context-create.js';
import {reserveKnowledgeCaptureBudget} from './native-knowledge-budget.js';
import {APP_RUNTIME_SESSION_RESUME_GRACE_MS} from './app-runtime-contract.js';

const scope=(caller:AppIntegrationSourceCaller,target:Pick<AppIntegrationSourceTarget,'installation_id'|'account_ref'|'store_key'>)=>({org_id:caller.org_id,owner_user_id:caller.user_id,installation_id:target.installation_id,account_ref:target.account_ref,store_key:target.store_key});

/** App-neutral background lease health, derived from `until_revoked` runtime
 * sessions. `paused` means a lapsed lease still inside the grace window;
 * `ended` means outside it or revoked. `null` means no background lease. */
export type BackgroundHealthState='healthy'|'paused'|'ended';
export type BackgroundHealth=Readonly<{state:BackgroundHealthState;since:string;reason:string}>;
type BackgroundSessionRow=Readonly<{expires_at:Date;revoked_at:Date|null;updated_at:Date}>;
const BACKGROUND_STATE_RANK:Record<BackgroundHealthState,number>={healthy:0,paused:1,ended:2};
function sessionBackgroundState(session:BackgroundSessionRow,now:Date,graceMs:number):Readonly<{state:BackgroundHealthState;since:Date;reason:string}>{
 if(session.revoked_at)return{state:'ended',since:session.revoked_at,reason:'revoked'};
 if(session.expires_at>now)return{state:'healthy',since:session.updated_at,reason:'live'};
 const gap=now.getTime()-session.expires_at.getTime();
 if(gap<=graceMs)return{state:'paused',since:session.expires_at,reason:'lapsed'};
 return{state:'ended',since:new Date(session.expires_at.getTime()+graceMs),reason:'expired'};
}
/** Worst-state-wins aggregate; `since`/`reason` follow the most severe lease. */
export function deriveBackgroundHealth(sessions:readonly BackgroundSessionRow[],now:Date,graceMs=APP_RUNTIME_SESSION_RESUME_GRACE_MS):BackgroundHealth|null{
 let result:Readonly<{state:BackgroundHealthState;since:Date;reason:string}>|null=null;
 for(const session of sessions){const current=sessionBackgroundState(session,now,graceMs);
  if(!result||BACKGROUND_STATE_RANK[current.state]>BACKGROUND_STATE_RANK[result.state]
   ||(BACKGROUND_STATE_RANK[current.state]===BACKGROUND_STATE_RANK[result.state]&&current.since<result.since))result=current;}
 return result?{state:result.state,since:result.since.toISOString(),reason:result.reason}:null;
}
/** Minimal-baseline tolerant: absent runtime tables yield null background.
 *  Health follows the connection owner whose grant/consent the `until_revoked`
 *  lease runs on — never the runtime operator. The owner is the resource
 *  binding's `owner_user_id`, reached directly for resource-sync sessions and
 *  through the runtime binding's `owner_resource_binding_id` for action sessions. */
export async function readBackgroundHealth(tx:Tx,caller:{org_id:string;user_id:string},installationId:string,nowMs:number,targetKey?:string):Promise<BackgroundHealth|null>{
 const probe=await tx.execute(sql`SELECT to_regclass('app_runtime_sessions') IS NOT NULL AS present`);
 if(!probe.rows[0]?.present)return null;
 const sessions=await tx.select({expires_at:appRuntimeSessions.expires_at,revoked_at:appRuntimeSessions.revoked_at,updated_at:appRuntimeSessions.updated_at})
  .from(appRuntimeSessions)
  .leftJoin(appRuntimeBindings,and(eq(appRuntimeBindings.org_id,appRuntimeSessions.org_id),eq(appRuntimeBindings.id,appRuntimeSessions.runtime_binding_id)))
  .leftJoin(appResourceBindings,and(eq(appResourceBindings.org_id,appRuntimeSessions.org_id),
   or(eq(appResourceBindings.id,appRuntimeSessions.resource_binding_id),eq(appResourceBindings.id,appRuntimeBindings.owner_resource_binding_id))))
  .where(and(eq(appRuntimeSessions.org_id,caller.org_id),eq(appResourceBindings.owner_user_id,caller.user_id),eq(appRuntimeSessions.renewal_lifetime,'until_revoked'),
   sql`(${appRuntimeBindings.app_installation_id}=${installationId} OR ${appResourceBindings.app_installation_id}=${installationId})`,
   targetKey===undefined?undefined:eq(appResourceBindings.target_key,targetKey)))
  .orderBy(desc(appRuntimeSessions.created_at));
 return deriveBackgroundHealth(sessions,new Date(nowMs));
}
const where=(table:typeof policies|typeof claims|typeof threads|typeof sources,caller:AppIntegrationSourceCaller,target:Pick<AppIntegrationSourceTarget,'installation_id'|'account_ref'|'store_key'>)=>{
 const s=scope(caller,target);return and(eq(table.org_id,s.org_id),eq(table.owner_user_id,s.owner_user_id),eq(table.installation_id,s.installation_id),eq(table.account_ref,s.account_ref),eq(table.store_key,s.store_key));
};
const key=(policy:AppIntegrationCapturePolicy)=>policy.destination.scope==='user'?'user':`space:${policy.destination.space_id}`;
const denied=()=>new Error('APP_INTEGRATION_CAPTURE_CHANGED_OR_DENIED');
const identity=(target:AppIntegrationSourceTarget)=>{const {resource_binding_id:unusedBinding,projection_id:unusedProjection,...value}=target;void unusedBinding;void unusedProjection;return value;};
export function createAppIntegrationCaptureStore(input:{
 transaction<T>(fn:(tx:Tx)=>Promise<T>):Promise<T>;
 enqueueEmbedding(tx:Tx,page_id:string,version:number,org_id:string):Promise<void>;
 clock?:()=>number;
}){
 const now=input.clock??Date.now;
 const policy=async(tx:Tx,caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget)=>{
  const [row]=await tx.select().from(policies).where(where(policies,caller,target)).limit(1).for('share');
  if(!row)throw denied();
  const parsed=AppIntegrationCapturePolicyInputSchema.parse({...row.input,expected_revision:row.revision});
  if(parsed.enabled!==row.enabled)throw denied();return {...parsed,id:row.id,revision:row.revision,history_since:row.history_since.toISOString()};
 };
 const destination=async(tx:Tx,caller:AppIntegrationSourceCaller,p:AppIntegrationCapturePolicy)=>{
  const [member]=await tx.select({id:orgMembers.user_id}).from(orgMembers).innerJoin(users,eq(users.id,orgMembers.user_id))
   .where(and(eq(orgMembers.org_id,caller.org_id),eq(orgMembers.user_id,caller.user_id),eq(orgMembers.is_active,true),eq(users.kind,'human'),eq(users.is_agent,false))).limit(1).for('share');
  if(!member)throw denied();
  if(p.destination.scope==='space'){
   const [space]=await tx.select({id:spaces.id}).from(spaces).innerJoin(spaceMembers,eq(spaceMembers.space_id,spaces.id)).where(and(
    eq(spaces.org_id,caller.org_id),eq(spaces.id,p.destination.space_id!),eq(spaces.is_archived,false),eq(spaceMembers.user_id,caller.user_id))).limit(1).for('share');
   if(!space)throw denied();
  }
 };
 const readThread=async(tx:Tx,caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,p:AppIntegrationCapturePolicy,thread_key:string)=>{
   // Empty threads need a lock too: two different observations must not create
   // competing pages before the unique lineage row exists.
   const lock=['app-integration-capture',caller.org_id,caller.user_id,target.installation_id,target.account_ref,target.store_key,thread_key,key(p)].join(':');
   await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock},0))`);
   // Final commit compares the observed thread/page under these locks; the
   // unique claim independently arbitrates concurrent duplicate deliveries.
   const [row]=await tx.select({thread:threads,page:wikiPages}).from(threads).innerJoin(wikiPages,and(eq(wikiPages.id,threads.page_id),eq(wikiPages.org_id,caller.org_id)))
    .where(and(where(threads,caller,target),eq(threads.thread_key,thread_key),eq(threads.destination_key,key(p)))).limit(1).for('update');
   return row?{page_id:row.page.id,page_version:row.thread.page_version,live_version:row.page.version,is_deleted:row.page.is_deleted,content:row.page.content,last_observed_at:row.thread.last_observed_at.toISOString()}:null;
  };
 const ports={transaction:input.transaction,policy,destination,thread:readThread,
  async claim(tx:Tx,caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,p:AppIntegrationCapturePolicy,evidence:{thread_key?:string;body_digest?:string}){
   const [row]=await tx.insert(claims).values({id:randomUUID(),...scope(caller,target),policy_id:p.id,policy_revision:p.revision,
    thread_key:evidence.thread_key!,body_digest:evidence.body_digest!,target:identity(target),state:'processing'}).onConflictDoNothing().returning({id:claims.id});return row?.id??null;
  },
  async skipped(tx:Tx,claim_id:string,caller:AppIntegrationSourceCaller,reason:string){await tx.update(claims).set({state:reason==='protected'?'protected':'skipped',error_code:reason,updated_at:new Date(now())})
   .where(and(eq(claims.org_id,caller.org_id),eq(claims.owner_user_id,caller.user_id),eq(claims.id,claim_id),eq(claims.state,'processing')));},
  async reserveBudget(tx:Tx,caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,tokens:number){
   return reserveKnowledgeCaptureBudget(tx,{org_id:caller.org_id,user_id:caller.user_id,
    installation_id:target.installation_id,account_ref:target.account_ref,tokens,at:new Date(now())});
  },
  async commit(tx:Tx,operation:Parameters<AppIntegrationCapturePorts<Tx>['commit']>[1]){
   const {caller,snapshot,policy:p,evidence,extracted,prior,claim_id}=operation,target=snapshot.publication.target;
   const [claim]=await tx.select().from(claims).where(and(where(claims,caller,target),eq(claims.id,claim_id),eq(claims.state,'processing'),eq(claims.policy_id,p.id),eq(claims.policy_revision,p.revision))).limit(1).for('update');
   if(!claim||claim.body_digest!==evidence.body_digest||claim.thread_key!==evidence.thread_key)throw denied();
   await destination(tx,caller,p);
   const current=await readThread(tx,caller,target,p,evidence.thread_key!);
   if((current?.page_id??null)!==(prior?.page_id??null)||current&&(current.is_deleted||current.live_version!==current.page_version||current.page_version!==prior?.page_version)){
    await tx.update(claims).set({state:'protected',updated_at:new Date(now())}).where(eq(claims.id,claim_id));return {state:'protected'};
   }
   if(!extracted.capture){await tx.update(claims).set({state:'skipped',updated_at:new Date(now())}).where(eq(claims.id,claim_id));return {state:'skipped'};}
   let page_id=current?.page_id,version=(current?.page_version??0)+1;
   const content=`Source: ${evidence.sender??'Unknown sender'} (${evidence.received_at??'date unavailable'}). Partial observed source; attachment text not processed.\n\n${extracted.content}`;
   if(current){
    const [page]=await tx.select().from(wikiPages).where(and(eq(wikiPages.org_id,caller.org_id),eq(wikiPages.id,current.page_id),eq(wikiPages.version,current.page_version),eq(wikiPages.is_deleted,false))).limit(1).for('update');
    if(!page)throw denied();
    await tx.insert(wikiPageVersions).values({page_id:page.id,version:page.version,title:page.title,content:page.content,summary:page.summary,edited_by:caller.user_id}).onConflictDoNothing();
    const [updated]=await tx.update(wikiPages).set({title:extracted.title,content,previous_content:page.content,version,embedding:null,updated_at:new Date(now())})
     .where(and(eq(wikiPages.org_id,caller.org_id),eq(wikiPages.id,page.id),eq(wikiPages.version,page.version),eq(wikiPages.is_deleted,false))).returning({id:wikiPages.id});if(!updated)throw denied();
   }else if(p.destination.scope==='space'){
    const page=await createNativeKnowledge(tx,{id:caller.user_id,org_id:caller.org_id},{space_id:p.destination.space_id!,type:extracted.type,title:extracted.title,content,
     created_via:'app_integration_capture',metadata:{app_capture:{partial:true,attachments_processed:false}}});page_id=page.id;
   }else{
    page_id=randomUUID();await tx.insert(wikiPages).values({id:page_id,org_id:caller.org_id,user_id:caller.user_id,origin_user_id:caller.user_id,
     scope:'user',space_id:null,type:extracted.type,title:extracted.title,slug:`source-${page_id}`,content,created_via:'app_integration_capture',confidence:0.9,metadata:{app_capture:{partial:true,attachments_processed:false}}});
   }
   const source_id=randomUUID();
   await tx.insert(sources).values({id:source_id,...scope(caller,target),claim_id,page_id:page_id!,target:identity(target),publication:snapshot.publication,
    thread_key:evidence.thread_key!,body_digest:evidence.body_digest!,observed_at:new Date(snapshot.publication.observed_at),partial:true});
   await tx.insert(wikiCitations).values({org_id:caller.org_id,page_id:page_id!,source_type:'app_integration',source_id,source_user_id:caller.user_id,source_space_id:p.destination.space_id,excerpt:extracted.excerpt});
   await tx.insert(threads).values({id:randomUUID(),...scope(caller,target),thread_key:evidence.thread_key!,destination_key:key(p),page_id:page_id!,page_version:version,last_observed_at:new Date(snapshot.publication.observed_at)})
    .onConflictDoUpdate({target:[threads.org_id,threads.owner_user_id,threads.installation_id,threads.account_ref,threads.store_key,threads.thread_key,threads.destination_key],set:{page_version:version,last_observed_at:new Date(snapshot.publication.observed_at),updated_at:new Date(now())}});
   await tx.update(claims).set({state:current?'updated':'captured',page_id:page_id!,updated_at:new Date(now())}).where(and(eq(claims.org_id,caller.org_id),eq(claims.id,claim_id)));
   await input.enqueueEmbedding(tx,page_id!,version,caller.org_id);return {state:current?'updated':'captured',page_id};
  },
  async failed(claim_id:string,caller:AppIntegrationSourceCaller,error:string){await input.transaction(async tx=>{await tx.update(claims).set({state:'failed',error_code:error,updated_at:new Date(now())})
   .where(and(eq(claims.org_id,caller.org_id),eq(claims.owner_user_id,caller.user_id),eq(claims.id,claim_id),eq(claims.state,'processing')));});},
 } satisfies Pick<AppIntegrationCapturePorts<Tx>,'transaction'|'policy'|'destination'|'thread'|'claim'|'skipped'|'reserveBudget'|'commit'|'failed'>;
 const readHealth=async(tx:Tx,caller:AppIntegrationSourceCaller,target:Pick<AppIntegrationSourceTarget,'installation_id'|'account_ref'|'store_key'>,grantActive:boolean)=>{
  const [row]=await tx.select({enabled:policies.enabled,retired_reason:policies.retired_reason,retired_at:policies.retired_at,last_error:policies.last_error}).from(policies).where(where(policies,caller,target)).limit(1).for('share');
  const [counts]=await tx.select({failed:sql<number>`count(*) FILTER(WHERE state='failed')::int`,last_success_at:sql<string|null>`max(updated_at) FILTER(WHERE state IN ('captured','updated'))`}).from(claims).where(where(claims,caller,target));
  const enabled=row?.enabled??false,retired_reason=row?.retired_reason??null;
  const state:('healthy'|'grant_ended'|'never_enabled'|'retrying')=!enabled?retired_reason==='grant_ended'?'grant_ended':'never_enabled':retired_reason==='grant_ended'||!grantActive?'grant_ended':(counts?.failed??0)>0?'retrying':'healthy';
  const background=await readBackgroundHealth(tx,caller,target.installation_id,now());
  return {account_grant_active:grantActive,state,last_error:row?.last_error??null,last_success_at:counts?.last_success_at?new Date(counts.last_success_at).toISOString():null,retired_reason,retired_at:row?.retired_at?new Date(row.retired_at).toISOString():null,background};
 };
 return {...ports,
  async settings(tx:Tx,caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,grantActive=true){
   const [row]=await tx.select({id:policies.id}).from(policies).where(where(policies,caller,target)).limit(1).for('share');
   const values=row?await policy(tx,caller,target):{enabled:false,destination:{scope:'user' as const,space_id:null},history_days:30,include_bulk:false,excluded_senders:[],excluded_folders:[],expected_revision:0,id:null,revision:0,history_since:null};
   const [counts]=await tx.select({processed:sql<number>`count(*)::int`,captured:sql<number>`count(*) FILTER(WHERE state IN ('captured','updated'))::int`,skipped:sql<number>`count(*) FILTER(WHERE state IN ('skipped','protected'))::int`,failed:sql<number>`count(*) FILTER(WHERE state='failed')::int`}).from(claims).where(where(claims,caller,target));
   return {...values,progress:counts??{processed:0,captured:0,skipped:0,failed:0},health:await readHealth(tx,caller,target,grantActive)};
  },
  async health(tx:Tx,caller:AppIntegrationSourceCaller,target:Pick<AppIntegrationSourceTarget,'installation_id'|'account_ref'|'store_key'>,grantActive:boolean){return readHealth(tx,caller,target,grantActive);},
  async writePolicy(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,raw:unknown,authorize:(tx:Tx)=>Promise<void>,afterWrite?:(tx:Tx,policy:AppIntegrationCapturePolicy)=>Promise<void>){
   if(caller.kind!=='human')throw denied();const parsed=AppIntegrationCapturePolicyInputSchema.parse(raw);
   return input.transaction(async tx=>{
    await authorize(tx);await destination(tx,caller,{...parsed,id:'',revision:parsed.expected_revision,history_since:new Date(now()).toISOString()});
    const [row]=await tx.select().from(policies).where(where(policies,caller,target)).limit(1).for('update');
    if((row?.revision??0)!==parsed.expected_revision)throw new Error('APP_INTEGRATION_CAPTURE_STALE');
    const {expected_revision,...values}=parsed,revision=expected_revision+1;
    const history_since=row&&row.input.history_days===values.history_days?row.history_since:new Date(now()-values.history_days*86400000);
    if(row)await tx.update(policies).set({input:values,enabled:values.enabled,revision,history_since,scan_checkpoint_id:null,scan_after_projection_id:null,updated_at:new Date(now())}).where(and(where(policies,caller,target),eq(policies.id,row.id)));
    else {const [inserted]=await tx.insert(policies).values({id:randomUUID(),...scope(caller,target),input:values,enabled:values.enabled,revision,history_since}).onConflictDoNothing().returning({id:policies.id});if(!inserted)throw new Error('APP_INTEGRATION_CAPTURE_STALE');}
    const result=await policy(tx,caller,target);await afterWrite?.(tx,result);await authorize(tx);return result;
   });
  },
 };
}
