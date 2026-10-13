import {and,eq,sql,desc} from 'drizzle-orm';
import {appConnectionSessions} from '@deft/db/schema';
import {appResourceObservationConsents} from '../../../../packages/db/src/resource-observation-schema.js';
import {ResourceObservationSnapshotSchema,ResourceObservationReviewRequestSchema,ResourceObservationActivateRequestSchema,
 ResourceObservationReferenceSchema,ResourceObservationReviewSchema,ResourceObservationStatusSchema,ResourceObservationContextSchema,type ResourceObservationSnapshot}
 from '../../../../packages/app-kit/src/resource-observation.js';
import {db} from './db.js';
import {AppError} from './app-errors.js';
import {digestAppGrantValue} from './app-grant-service.js';
import {AppConnectionSessionRecordSchema} from './app-connection-session-service.js';
import {attachmentFinalAuthorityIsCurrent,assertAttachmentBrokerEnabled} from './app-attachment-authority.js';
import {resourceObservationBindingAuthority,loadObservationConnection,observationPolicyDigest,observationSnapshotIsCurrent,observationDenied,assertResourceObservationEnabled}
 from './app-resource-observation-authority.js';
import type {ModuleActor} from '@deft/shared/modules';
import type {WebAuthorityGuard} from './app-resource-sync-web-authority.js';
const conflict=()=>new AppError('Observation review changed','APP_STATE_CONFLICT',409);
export class AppResourceObservationService{
 constructor(private readonly database:typeof db=db,private readonly clock=()=>new Date()){}
 private assertHuman(actor:ModuleActor){if(actor.kind!=='human'||actor.role==='guest'||!['ui','rest'].includes(actor.source))throw observationDenied();}
 private async own(tx:Parameters<Parameters<typeof db.transaction>[0]>[0],actor:ModuleActor,id:string){
  const [row]=await tx.select().from(appResourceObservationConsents).where(and(eq(appResourceObservationConsents.org_id,actor.org_id),
   eq(appResourceObservationConsents.owner_user_id,actor.actor_id),eq(appResourceObservationConsents.consent_id,id))).limit(1);
  if(!row)throw observationDenied();return row;
 }
 private reviewView(row:typeof appResourceObservationConsents.$inferSelect,account:{account_ref:string;label:string}){
  const snapshot=ResourceObservationSnapshotSchema.parse(row.snapshot);
  return ResourceObservationReviewSchema.parse({schema_version:'deft.app_resource_observation_review.v1',consent_id:row.consent_id,
   review_digest:row.consent_digest,attachment_mode:'unsupported',scope:snapshot.scope,connection_session_id:snapshot.connection.session_id,account:{account_ref:snapshot.connection.account_ref,label:account.account_ref===snapshot.connection.account_ref?account.label:'Previously connected account'},
   expected_custody_generation:snapshot.connection.expected_custody_generation,interval_seconds:snapshot.interval_seconds,expires_at:snapshot.expires_at});
 }
 async context(actor:ModuleActor,installationId:string,guard:WebAuthorityGuard){
  assertAttachmentBrokerEnabled();this.assertHuman(actor);assertResourceObservationEnabled();
  // Latest own connected session per target only; all authority is reconstructed,
  // so old-version histories and revoked/foreign targets cannot be disclosed.
  return this.database.transaction(async tx=>{
   const targetKey=sql`${appConnectionSessions.record}->'scope'->>'target_key'`;
   const rows=await tx.selectDistinctOn([targetKey]).from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,actor.org_id),
    eq(appConnectionSessions.owner_user_id,actor.actor_id),sql`${appConnectionSessions.record}->'scope'->>'installation_id'=${installationId}`,
    sql`${appConnectionSessions.record}->>'state'='connected'`)).orderBy(targetKey,desc(appConnectionSessions.updated_at)).limit(33);
   if(rows.length>32)throw observationDenied();
   const targets:unknown[]=[],seen=new Set<string>();
   for(const row of rows){const record=AppConnectionSessionRecordSchema.parse(row.record);
    try{const authority=await resourceObservationBindingAuthority(tx,actor.org_id,record.scope.resource_binding_id,this.clock);
     const current=await loadObservationConnection(tx,authority,record.session_id);
     if(seen.has(current.scope.target_key))continue;
     const consents=await tx.select().from(appResourceObservationConsents).where(and(eq(appResourceObservationConsents.org_id,actor.org_id),
      eq(appResourceObservationConsents.owner_user_id,actor.actor_id),eq(appResourceObservationConsents.resource_binding_id,current.scope.resource_binding_id)))
      .orderBy(sql`CASE WHEN ${appResourceObservationConsents.state}='active' THEN 0 ELSE 1 END`,desc(appResourceObservationConsents.created_at)).limit(1);
     const consent=consents[0];let state=consent?.state;
     if(consent){try{await observationSnapshotIsCurrent(tx,ResourceObservationSnapshotSchema.parse(consent.snapshot),authority,this.clock);}catch(error){if(!(error instanceof AppError))throw error;state='unavailable';}}
     targets.push({target_key:current.scope.target_key,scope:current.scope,connection_session_id:current.session_id,account:current.account,
      min_interval_seconds:Math.max(60,authority.binding.min_interval_seconds),attachment_mode:'unsupported',consent:consent?{consent_id:consent.consent_id,state}:null});seen.add(current.scope.target_key);
    }catch(error){if(!(error instanceof AppError))throw error;}
   }
   await guard(tx);assertResourceObservationEnabled();
   return ResourceObservationContextSchema.parse({schema_version:'deft.app_resource_observation_context.v1',installation_id:installationId,
    org_id:actor.org_id,owner_user_id:actor.actor_id,targets});
  });
 }

 async review(actor:ModuleActor,raw:unknown,guard:WebAuthorityGuard){
  assertAttachmentBrokerEnabled();this.assertHuman(actor);assertResourceObservationEnabled();const input=ResourceObservationReviewRequestSchema.parse(raw);
  return this.database.transaction(async tx=>{
   const [locator]=await tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,actor.org_id),
    eq(appConnectionSessions.owner_user_id,actor.actor_id),eq(appConnectionSessions.session_id,input.connection_session_id))).limit(1);
   if(!locator)throw observationDenied();
   const nomination=AppConnectionSessionRecordSchema.parse(locator.record);
   const authority=await resourceObservationBindingAuthority(tx,actor.org_id,nomination.scope.resource_binding_id,this.clock);
   if(authority.binding.owner_user_id!==actor.actor_id||input.request_id===authority.binding.id)throw observationDenied();
   const record=await loadObservationConnection(tx,authority,input.connection_session_id);
   const expiry=Math.min(Date.parse(input.expires_at),Date.parse(record.scope.consent_expires_at));
   if(!Number.isFinite(expiry)||expiry<=this.clock().getTime()||input.interval_seconds<authority.binding.min_interval_seconds)throw observationDenied();
   const receipt=record.connection_receipt;
   const snapshot=ResourceObservationSnapshotSchema.parse({schema_version:'deft.app_resource_observation_consent.v1',consent_id:input.request_id,
    scope:record.scope,connection:{session_id:record.session_id,runtime_session_ref:record.runtime_session_ref,account_ref:record.account!.account_ref,
     expected_custody_generation:receipt?.custody_generation??null,receipt_digest:receipt?.receipt_digest??null},
    resource_policy_digest:await observationPolicyDigest(authority),interval_seconds:input.interval_seconds,expires_at:new Date(expiry).toISOString()});
   await observationSnapshotIsCurrent(tx,snapshot,authority,this.clock);
   if(!await attachmentFinalAuthorityIsCurrent(tx,[actor.actor_id,authority.registration.operator_user_id],{guard,clock:this.clock}))throw observationDenied();
   const digest=digestAppGrantValue(snapshot),existing=await tx.select().from(appResourceObservationConsents).where(and(
    eq(appResourceObservationConsents.org_id,actor.org_id),eq(appResourceObservationConsents.consent_id,input.request_id))).limit(1);
   if(existing.length){if(existing[0]!.owner_user_id!==actor.actor_id||existing[0]!.consent_digest!==digest)throw conflict();return this.reviewView(existing[0]!,record.account!);}
   const now=this.clock();const [row]=await tx.insert(appResourceObservationConsents).values({org_id:actor.org_id,owner_user_id:actor.actor_id,
    consent_id:input.request_id,resource_binding_id:authority.binding.id,connection_session_id:record.session_id,state:'proposed',consent_digest:digest,
    snapshot,expires_at:new Date(expiry),created_at:now,updated_at:now}).returning();
   assertResourceObservationEnabled();return this.reviewView(row!,record.account!);
  });
 }
 async activate(actor:ModuleActor,raw:unknown,guard:WebAuthorityGuard){
  assertAttachmentBrokerEnabled();this.assertHuman(actor);assertResourceObservationEnabled();const input=ResourceObservationActivateRequestSchema.parse(raw);
  return this.database.transaction(async tx=>{
   const row=await this.own(tx,actor,input.consent_id),snapshot=ResourceObservationSnapshotSchema.parse(row.snapshot);
   const authority=await resourceObservationBindingAuthority(tx,actor.org_id,row.resource_binding_id,this.clock);
   const record=await observationSnapshotIsCurrent(tx,snapshot,authority,this.clock);
   await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('deft.resource_observation.activate.v1'),hashtext(${actor.org_id+':'+row.resource_binding_id}))`);
   const [locked]=await tx.select().from(appResourceObservationConsents).where(and(eq(appResourceObservationConsents.org_id,actor.org_id),
    eq(appResourceObservationConsents.consent_id,input.consent_id))).limit(1).for('update');
   if(!locked||locked.state!=='proposed'||locked.consent_digest!==input.review_digest||row.consent_digest!==input.review_digest)throw conflict();
   if(!await attachmentFinalAuthorityIsCurrent(tx,[actor.actor_id,authority.registration.operator_user_id],{guard,clock:this.clock}))throw observationDenied();
   await tx.update(appResourceObservationConsents).set({state:'revoked',updated_at:this.clock()}).where(and(eq(appResourceObservationConsents.org_id,actor.org_id),
    eq(appResourceObservationConsents.resource_binding_id,row.resource_binding_id),eq(appResourceObservationConsents.state,'active')));
   const [active]=await tx.update(appResourceObservationConsents).set({state:'active',updated_at:this.clock()}).where(and(
    eq(appResourceObservationConsents.org_id,actor.org_id),eq(appResourceObservationConsents.consent_id,input.consent_id),eq(appResourceObservationConsents.state,'proposed'))).returning();
   assertResourceObservationEnabled();return ResourceObservationStatusSchema.parse({schema_version:'deft.app_resource_observation_status.v1',consent_id:row.consent_id,state:'active',review:this.reviewView(active!,record.account!)});
  });
 }
 async revoke(actor:ModuleActor,raw:unknown,guard:WebAuthorityGuard){
  assertAttachmentBrokerEnabled();this.assertHuman(actor);assertResourceObservationEnabled();const input=ResourceObservationReferenceSchema.parse(raw);
  return this.database.transaction(async tx=>{
   const row=await this.own(tx,actor,input.consent_id);await guard(tx);
   await tx.update(appResourceObservationConsents).set({state:'revoked',updated_at:this.clock()}).where(and(eq(appResourceObservationConsents.org_id,actor.org_id),eq(appResourceObservationConsents.consent_id,row.consent_id)));
   return {consent_id:row.consent_id,state:'revoked' as const};
  });
 }
 async status(actor:ModuleActor,raw:unknown,guard:WebAuthorityGuard){
  assertAttachmentBrokerEnabled();this.assertHuman(actor);assertResourceObservationEnabled();const input=ResourceObservationReferenceSchema.parse(raw);
  return this.database.transaction(async tx=>{
   const row=await this.own(tx,actor,input.consent_id),snapshot=ResourceObservationSnapshotSchema.parse(row.snapshot);
   const [source]=await tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,actor.org_id),eq(appConnectionSessions.owner_user_id,actor.actor_id),eq(appConnectionSessions.session_id,row.connection_session_id))).limit(1);
   if(!source)throw observationDenied();const record=AppConnectionSessionRecordSchema.parse(source.record);
   let state=row.state;try{const authority=await resourceObservationBindingAuthority(tx,actor.org_id,row.resource_binding_id,this.clock);
    await observationSnapshotIsCurrent(tx,snapshot,authority,this.clock);}catch(error){if(!(error instanceof AppError))throw error;state='unavailable';}
   await guard(tx);return ResourceObservationStatusSchema.parse({schema_version:'deft.app_resource_observation_status.v1',consent_id:row.consent_id,state,
    review:this.reviewView(row,record.account??{account_ref:snapshot.connection.account_ref,label:'Previously connected account'})});
  });
 }
}
