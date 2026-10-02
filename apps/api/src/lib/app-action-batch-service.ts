import { randomUUID } from 'node:crypto';
import { sql, and, eq } from 'drizzle-orm';
import { appExperienceConsentGrants, agentEmployees, mcpTokens, oauthAccessTokens, oauthGrants, agentActions, appVersions, appGrantSnapshots, appRuntimeAgentPolicies } from '@deft/db/schema';
import { RuntimeObjectSchema, parseRuntimeObjectInput } from '@deft/app-kit';
import { AppRunError } from './app-run-errors.js';
import { getAppRunRuntime, type AppRunRuntime } from './app-run-runtime.js';
import type { AppRunTransaction } from './app-run-repository.js';
import { assertExperienceWeb, verifiedExperienceBundle, type ExperienceCaller } from './app-experience-service.js';
import { ExperienceConsentScopeSchema, experienceConsentDigest } from './app-experience-consent-contract.js';
import { humanActionDigest, sealHumanActionTicket, openHumanActionTicket } from './app-experience-human-action-contract.js';
import { ActionBatchProposalSchema, ActionBatchApproveSchema, type ActionBatchCaller } from './app-action-batch-contract.js';

type Batch = { id:string;org_id:string;owner_user_id:string;runtime_binding_id:string;source:ActionBatchCaller['source'];employee_id:string|null;
 token_id:string|null;token_kind:'mcp'|'oauth'|null;token_version:number|null;content_digest:string;title:string;consent_grant_id:string;consent_epoch:number;policy_revision:number;state:string };
type Item = {item_key:string;label:string;run_id:string;input_digest:string;state:string};
const stale = () => new AppRunError('APP_RUN_AUTHORIZATION_STALE');
const deny = () => new AppRunError('APP_RUN_ACCESS_DENIED');
export class AppActionBatchService {
 constructor(private readonly runtime: AppRunRuntime) {}
 private async web(tx:AppRunTransaction,caller:ExperienceCaller,deadline?:string) {
  const web=await assertExperienceWeb(tx,caller);
  const sampled=await tx.execute(sql`SELECT clock_timestamp() AS now`),now=Math.max(Date.now(),new Date(sampled.rows[0]!.now as Date).getTime());
  if(web.expires_at.getTime()<=now || (caller.access_expires_at??Infinity)<=now || (deadline && Date.parse(deadline)<=now))throw stale();
  return {web,now};
 }
 private async caller(tx:AppRunTransaction, caller:ActionBatchCaller, requiredScopes:readonly string[]=['read:apps','invoke:apps']) {
  const employeeId=caller.employee_id ?? caller.agent_employee_id;
  if(caller.source==='employee_mcp' && !employeeId || caller.source==='personal_mcp' && employeeId)throw deny();
  let owner=caller.user_id;
  if(employeeId) { const [employee]=await tx.select().from(agentEmployees).where(and(eq(agentEmployees.org_id,caller.org_id),eq(agentEmployees.id,employeeId))).limit(1).for('share');
   if(!employee || !employee.is_active || employee.is_deleted || employee.unhealthy)throw deny(); owner=employee.user_id; }
  let tokenVersion:number|null=null;
  if(caller.source!=='defty') {
   if(!caller.token_id || !caller.token_kind)throw deny();
   if(caller.token_kind==='oauth') { const [token]=await tx.select().from(oauthAccessTokens).where(and(eq(oauthAccessTokens.org_id,caller.org_id),eq(oauthAccessTokens.id,caller.token_id))).limit(1).for('share');
    if(!token || token.revoked_at || token.expires_at<=new Date() || token.user_id!==owner || employeeId || !requiredScopes.every(scope=>token.scopes.includes(scope)))throw deny();
    const [grant]=await tx.select().from(oauthGrants).where(eq(oauthGrants.id,token.grant_id)).limit(1).for('share');if(!grant || grant.revoked_at || grant.org_id!==caller.org_id || grant.user_id!==owner || grant.client_id!==token.client_id || !requiredScopes.every(scope=>grant.scopes.includes(scope)))throw deny();tokenVersion=token.app_run_authorization_version;
   } else { const [token]=await tx.select().from(mcpTokens).where(and(eq(mcpTokens.org_id,caller.org_id),eq(mcpTokens.id,caller.token_id))).limit(1).for('share');
    if(!token || token.revoked_at || !requiredScopes.every(scope=>token.scopes.includes(scope)) || (employeeId ? token.agent_employee_id!==employeeId || token.principal_kind!=='agent' : token.user_id!==owner || token.principal_kind!=='human'))throw deny(); tokenVersion=token.app_run_authorization_version; }
  }
  return {...caller,user_id:owner,employee_id:employeeId,token_version:tokenVersion};
 }
 private async capture(tx:AppRunTransaction,caller:ActionBatchCaller,binding:string) {
  return caller.employee_id ? this.runtime.liveAuthorization.captureReviewedRuntimeAgentInTransaction(tx,{org_id:caller.org_id,agent_employee_id:caller.employee_id,runtime_binding_id:binding})
   : this.runtime.liveAuthorization.captureReviewedRuntimeInTransaction(tx,{org_id:caller.org_id,user_id:caller.user_id,runtime_binding_id:binding});
 }
 private async consent(tx:AppRunTransaction,caller:ActionBatchCaller,binding:string,id?:string,epoch?:number) {
  const capture=await this.capture(tx,caller,binding); if(capture.protocol_version!=='7')throw deny();
  const [policy]=await tx.select().from(appRuntimeAgentPolicies).where(and(eq(appRuntimeAgentPolicies.org_id,caller.org_id),eq(appRuntimeAgentPolicies.owner_user_id,caller.user_id),eq(appRuntimeAgentPolicies.runtime_binding_id,binding))).limit(1).for('share');
  if(!policy || policy.mode!=='require_approval')throw deny();
  const [version]=await tx.select().from(appVersions).where(eq(appVersions.id,capture.binding.app_version_id)).limit(1);
  const [snapshot]=await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id,caller.org_id),eq(appGrantSnapshots.id,capture.binding.grant_snapshot_id))).limit(1);
  if(!version || !snapshot)throw stale();
  const candidates=await tx.select().from(appExperienceConsentGrants).where(and(eq(appExperienceConsentGrants.org_id,caller.org_id),eq(appExperienceConsentGrants.owner_user_id,caller.user_id),eq(appExperienceConsentGrants.app_installation_id,capture.binding.app_installation_id),eq(appExperienceConsentGrants.app_version_id,capture.binding.app_version_id))).for('share');
  for(const grant of candidates) { if(grant.revoked_at || (id && (grant.id!==id || grant.epoch!==epoch)))continue;
   const parsed=ExperienceConsentScopeSchema.safeParse(grant.snapshot); if(!parsed.success)continue; const scope=parsed.data;
   if(grant.scope_digest!==experienceConsentDigest(scope) || scope.org_id!==caller.org_id || scope.owner_user_id!==caller.user_id
    || scope.installation_id!==capture.binding.app_installation_id || scope.app_version_id!==capture.binding.app_version_id
    || scope.grant_snapshot_id!==capture.binding.grant_snapshot_id || scope.grant_snapshot_digest!==snapshot.snapshot_digest
    || scope.package_digest!==version.package_digest || scope.manifest_digest!==version.manifest_digest
    || scope.lifecycle_epoch!==capture.installation_lifecycle_epoch || scope.grant_epoch!==capture.installation_grant_epoch)continue;
   const bundle=await verifiedExperienceBundle(version,scope.experience_key);
   if(bundle.reference.artifact_digest!==scope.artifact_digest || !bundle.bundle.action_keys.includes(capture.action.action_key))continue;
   return {capture,grant,scope,policy};
  } throw stale();
 }
 private async load(tx:AppRunTransaction,org:string,id:string) { const result=await tx.execute(sql<Batch>`SELECT * FROM app_action_batches WHERE org_id=${org} AND id=${id} FOR UPDATE`); if(!result.rows[0])throw deny();return result.rows[0] as Batch; }
 private async items(tx:AppRunTransaction,b:Batch) { return (await tx.execute(sql<Item>`SELECT i.item_key,i.label,i.run_id,i.input_digest,r.state FROM app_action_batch_items i JOIN app_runs r ON r.org_id=i.org_id AND r.id=i.run_id WHERE i.org_id=${b.org_id} AND i.batch_id=${b.id} ORDER BY i.ordinal`)).rows as Item[]; }
 private view(b:Batch,items:Item[]) { return {batch:{id:b.id,title:b.title,state:b.state,runtime_binding_id:b.runtime_binding_id,item_count:items.length,review_url:`/apps/action-batches/${b.id}`},items:items.map(i=>({key:i.item_key,label:i.label,run_id:i.run_id,state:i.state}))}; }
 private assertMembership(b:Batch,items:Item[]) {
  if(items.length<1 || items.length>10 || humanActionDigest({runtime_binding_id:b.runtime_binding_id,title:b.title,
   items:items.map(i=>({key:i.item_key,label:i.label,input_digest:i.input_digest}))})!==b.content_digest)throw stale();
 }
 private batchCaller(b:Batch):ActionBatchCaller {return {org_id:b.org_id,user_id:b.owner_user_id,source:b.source,...(b.employee_id?{employee_id:b.employee_id}:{}),...(b.token_id?{token_id:b.token_id,token_kind:b.token_kind!}:{})};}
 private async current(tx:AppRunTransaction,b:Batch) {const caller=await this.caller(tx,this.batchCaller(b));if(caller.user_id!==b.owner_user_id || caller.token_version!==b.token_version)throw stale();const current=await this.consent(tx,caller,b.runtime_binding_id,b.consent_grant_id,b.consent_epoch);if(current.policy.revision!==b.policy_revision || b.policy_revision<0)throw stale();return current;}
 async propose(caller:ActionBatchCaller,raw:unknown) {
  const request=ActionBatchProposalSchema.parse(raw);
  return this.runtime.repository.transaction(async tx=>{
   const trusted=await this.caller(tx,caller),authority=await this.consent(tx,trusted,request.runtime_binding_id);
   const items=request.items.map(i=>({...i,input:parseRuntimeObjectInput(RuntimeObjectSchema.parse(authority.capture.action.input_schema),i.input)}));
   const digest=humanActionDigest({runtime_binding_id:request.runtime_binding_id,title:request.title,items:items.map(i=>({key:i.key,label:i.label,input_digest:humanActionDigest(i.input)}))}), key=humanActionDigest({key:request.idempotency_key,employee:trusted.employee_id??null,token:trusted.token_id??null});
   await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${caller.org_id}:${trusted.user_id}:${caller.source}:${key}`},0))`);
   const existingRaw=await tx.execute(sql<Batch>`SELECT * FROM app_action_batches WHERE org_id=${caller.org_id} AND owner_user_id=${trusted.user_id} AND source=${caller.source} AND idempotency_digest=${key} FOR UPDATE`);
   const existing={rows:existingRaw.rows as Batch[]};
   if(existing.rows[0]) {if(existing.rows[0].content_digest!==digest)throw new AppRunError('APP_RUN_IDEMPOTENCY_CONFLICT'); return this.view(existing.rows[0],await this.items(tx,existing.rows[0]));}
   const id=randomUUID();
   await tx.execute(sql`INSERT INTO app_action_batches(id,org_id,owner_user_id,runtime_binding_id,source,employee_id,token_id,token_kind,token_version,idempotency_digest,content_digest,title,consent_grant_id,consent_epoch,policy_revision) VALUES (${id},${caller.org_id},${trusted.user_id},${request.runtime_binding_id},${caller.source},${trusted.employee_id??null},${trusted.token_id??null},${trusted.token_kind??null},${trusted.token_version},${key},${digest},${request.title},${authority.grant.id},${authority.grant.epoch},${authority.policy.revision})`);
   for(const [ordinal,item] of items.entries()) {
    const submission={runtime_binding_id:request.runtime_binding_id,input:item.input,idempotency_key:`batch:${id}:${ordinal}`};
    const guard=async(executor:AppRunTransaction)=>{await this.consent(executor,trusted,request.runtime_binding_id,authority.grant.id,authority.grant.epoch);await this.caller(executor,trusted);};
    const run=trusted.employee_id?await this.runtime.service.submitReviewedRuntimeAgent({org_id:caller.org_id,agent_employee_id:trusted.employee_id},submission,tx)
     :await this.runtime.service.submitReviewedRuntime(trusted,submission,undefined,guard,tx);
    if(run.state!=='pending_approval')throw stale();
    await tx.execute(sql`INSERT INTO app_action_batch_items(org_id,batch_id,item_key,label,ordinal,run_id,input_digest) VALUES(${caller.org_id},${id},${item.key},${item.label},${ordinal},${run.id},${humanActionDigest(item.input)})`);
   }
   const batch=await this.load(tx,caller.org_id,id);await this.current(tx,batch);return this.view(batch,await this.items(tx,batch));
  });
 }
 async get(caller:ActionBatchCaller,id:string) {return this.runtime.repository.transaction(async tx=>{const trusted=await this.caller(tx,caller,['read:app-runs']),b=await this.load(tx,caller.org_id,id);if(b.owner_user_id!==trusted.user_id)throw deny();return this.view(b,await this.items(tx,b));});}
 async review(caller:ExperienceCaller,id:string) {return this.runtime.repository.transaction(async tx=>{
  await this.web(tx,caller);const b=await this.load(tx,caller.org_id,id);if(b.owner_user_id!==caller.user_id)throw deny();if(b.state!=='pending_approval')throw stale();
  const authority=await this.current(tx,b),items=await this.items(tx,b);this.assertMembership(b,items);const inputs=[];
  for(const item of items) {const run=await this.runtime.repository.lockRun(tx,b.org_id,item.run_id);if(!run || run.state!=='pending_approval')throw stale();
   const input=parseRuntimeObjectInput(RuntimeObjectSchema.parse(authority.capture.action.input_schema),await this.runtime.secretRepository.readInput(b.org_id,item.run_id,tx));if(humanActionDigest(input)!==item.input_digest)throw stale();inputs.push({...item,input});}
  const {web,now}=await this.web(tx,caller);const expires_at=new Date(Math.min(now+120_000,web.expires_at.getTime(),caller.access_expires_at??Infinity)).toISOString();
  const ticket=sealHumanActionTicket(this.runtime.keys,{org_id:b.org_id,user_id:b.owner_user_id,sid:caller.sid,session_id:b.id,action_key:'batch',runtime_binding_id:b.runtime_binding_id,authority_digest:humanActionDigest(authority.capture.authorization_snapshot),input:{},input_digest:b.content_digest,idempotency_key:b.id,expires_at});
  return {...this.view(b,items),items:inputs.map(i=>({key:i.item_key,label:i.label,run_id:i.run_id,state:i.state,input:i.input})),ticket,digest:b.content_digest,expires_at,app_label:authority.scope.app_name,action_label:authority.capture.action.action_key};
 });}
 async approve(caller:ExperienceCaller,id:string,raw:unknown) {const request=ActionBatchApproveSchema.parse(raw),ticket=openHumanActionTicket(this.runtime.keys,request.ticket);
  if(ticket.org_id!==caller.org_id || ticket.user_id!==caller.user_id || ticket.sid!==caller.sid || ticket.session_id!==id || ticket.action_key!=='batch' || ticket.input_digest!==request.expected_digest || Date.parse(ticket.expires_at)<=Date.now())throw stale();
  return this.runtime.repository.transaction(async tx=>{await this.web(tx,caller,ticket.expires_at);const b=await this.load(tx,caller.org_id,id);if(b.owner_user_id!==caller.user_id || b.content_digest!==ticket.input_digest || ticket.runtime_binding_id!==b.runtime_binding_id)throw stale();
   if(b.state==='approved')return this.view(b,await this.items(tx,b));if(b.state!=='pending_approval')throw stale();
   const guard=async(executor:AppRunTransaction)=>{const current=await this.current(executor,b);if(ticket.authority_digest!==humanActionDigest(current.capture.authorization_snapshot))throw stale();await this.web(executor,caller,ticket.expires_at);};
   const items=await this.items(tx,b);this.assertMembership(b,items);
   // The release fence observes this only inside this transaction until every
   // item has approved successfully. Any failed item rolls the whole batch back.
   await guard(tx);
   await tx.execute(sql`UPDATE app_action_batches SET state='approved',approved_at=clock_timestamp() WHERE org_id=${b.org_id} AND id=${b.id}`);
   for(const item of items) {const [approval]=await tx.select({id:agentActions.id}).from(agentActions).where(and(eq(agentActions.org_id,b.org_id),eq(agentActions.app_run_id,item.run_id),eq(agentActions.user_id,caller.user_id),eq(agentActions.source,'app_run'))).limit(1);if(!approval)throw stale();
    const result=await this.runtime.approvalResolver.approveInTransaction(tx,approval.id,caller.user_id,guard);if(result.status!=='approved')throw stale();}
   const releasedItems=await this.items(tx,b);await guard(tx);b.state='approved';return this.view(b,releasedItems);
  });
 }
 async cancel(caller:ActionBatchCaller,id:string) {return this.runtime.repository.transaction(async tx=>{const trusted=await this.caller(tx,caller,['read:app-runs','invoke:apps']),b=await this.load(tx,caller.org_id,id);if(b.owner_user_id!==trusted.user_id)throw deny();
  await tx.execute(sql`UPDATE app_action_batches SET state='cancelled',cancelled_at=clock_timestamp() WHERE org_id=${b.org_id} AND id=${b.id}`);b.state='cancelled';
  return this.view(b,await this.items(tx,b));});}
}
export async function getAppActionBatchService() {return new AppActionBatchService(await getAppRunRuntime());}
