import {and,eq,inArray,notInArray,or,sql} from 'drizzle-orm';
import type {db} from './db.js';
import {randomBytes} from 'node:crypto';
import {appConnectionCredentialRepairReservation} from './app-connection-credential-repair-fence.js';
import {isDeepStrictEqual} from 'node:util';
import {appConnectionSessions,appRuns,appRunAttempts,appRuntimeBindings,appDataInvocations} from '@deft/db/schema';
import {appConnectionForms} from '../../../../packages/db/src/schema/app-connection-forms.js';
import {AppConnectionFormRecordSchema,type AppConnectionFormRecord} from '../../../../packages/app-kit/src/connection-form.js';
import type {AppConnectionProfile} from '../../../../packages/app-kit/src/connection-session.js';
import {FormCarrierSchema,projectFormCarrier,validateFormCarrierPair,validateFormPredecessor,type FormCarrier} from './app-connection-form-carrier.js';
import type {FormStore,FormCaller,FormLocator} from './app-connection-form-service.js';

type Database=Pick<typeof db,'select'|'transaction'>;
type Transaction=Parameters<Parameters<Database['transaction']>[0]>[0];
const formWhere=(q:FormLocator)=>and(eq(appConnectionForms.org_id,q.org_id),eq(appConnectionForms.owner_user_id,q.owner_user_id),eq(appConnectionForms.session_id,q.session_id));
const carrierWhere=(q:FormLocator)=>and(eq(appConnectionSessions.org_id,q.org_id),eq(appConnectionSessions.owner_user_id,q.owner_user_id),eq(appConnectionSessions.session_id,q.session_id));
const locator=(r:AppConnectionFormRecord):FormLocator=>({org_id:r.scope.org_id,owner_user_id:r.scope.owner_user_id,session_id:r.session_id});
const admitted=(r:AppConnectionFormRecord,c:FormCaller)=>c.org_id===r.scope.org_id&&c.user_id===r.scope.owner_user_id&&Number.isFinite(c.access_expires_at)&&c.access_expires_at>Date.now();
class Conflict extends Error{}
async function pair(tx:Transaction,q:FormLocator,lock=false){
 const carriers=tx.select().from(appConnectionSessions).where(carrierWhere(q)).limit(1);
 const forms=tx.select().from(appConnectionForms).where(formWhere(q)).limit(1);
 const [carrier]=await(lock?carriers.for('update'):carriers),[form]=await(lock?forms.for('update'):forms);
 if(!form)return null;if(!carrier||carrier.web_session_id!==form.web_session_id||carrier.access_expires_at.getTime()!==form.access_expires_at.getTime())throw new Error('APP_CONNECTION_FORM_SPLIT_STATE');
 return {...validateFormCarrierPair(form.record,carrier.record),metadata:form};
}
async function noEffects(tx:Transaction,r:AppConnectionFormRecord){
 const resources=[r.scope.resource_binding_id,...(r.source?[r.source.scope.resource_binding_id]:[])];
 const bindings=await tx.select({id:appRuntimeBindings.id}).from(appRuntimeBindings).where(and(eq(appRuntimeBindings.org_id,r.scope.org_id),eq(appRuntimeBindings.app_installation_id,r.scope.installation_id),inArray(appRuntimeBindings.owner_resource_binding_id,resources)));
 const domain=and(eq(appRuns.org_id,r.scope.org_id),eq(appRuns.origin_app_installation_id,r.scope.installation_id),or(inArray(appRuns.origin_resource_binding_id,resources),bindings.length?inArray(appRuns.origin_runtime_binding_id,bindings.map(x=>x.id)):undefined));
 const [run]=await tx.select({id:appRuns.id}).from(appRuns).where(and(domain,inArray(appRuns.state,['pending','pending_approval','running','waiting_external','unknown_outcome']))).limit(1);
 const [attempt]=await tx.select({id:appRunAttempts.id}).from(appRunAttempts).innerJoin(appRuns,and(eq(appRuns.org_id,appRunAttempts.org_id),eq(appRuns.id,appRunAttempts.run_id))).where(and(domain,notInArray(appRuns.state,['succeeded','failed','cancelled','expired']),inArray(appRunAttempts.state,['pending','claimed','provider_call_started','unknown_outcome']))).limit(1);
 const [data]=await tx.select({id:appDataInvocations.request_id}).from(appDataInvocations).where(and(eq(appDataInvocations.org_id,r.scope.org_id),eq(appDataInvocations.owner_user_id,r.scope.owner_user_id),inArray(appDataInvocations.connection_session_id,[r.session_id,...(r.source?[r.source.session_id]:[])]),inArray(appDataInvocations.state,['inflight','indeterminate']),notInArray(appDataInvocations.operation,['connection_metadata','record_read','record_list','file_read','request_status','read_prepared','read_prepared_resource_action','resource_list','resource_read_presentation','resource_list_files','resource_read_source','resource_read_file','resource_read_image','resource_refresh']))).limit(1);
 if(run||attempt||data)throw new Conflict();
}
async function targetLock(tx:Transaction,r:AppConnectionFormRecord){await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('deft.app_connection_session.target.v1'),hashtext(${[r.scope.org_id,r.scope.owner_user_id,r.scope.installation_id,r.scope.target_key].join(':')}))`);}
async function sourceCurrent(tx:Transaction,r:AppConnectionFormRecord){if(!r.source)return;
 const prior=await pair(tx,{...locator(r),session_id:r.source.session_id},true);if(!prior)throw new Conflict();validateFormPredecessor(r,prior.form);
 const [transition]=await tx.select({id:appConnectionForms.session_id}).from(appConnectionForms).where(and(eq(appConnectionForms.org_id,r.scope.org_id),eq(appConnectionForms.owner_user_id,r.scope.owner_user_id),
  sql`${appConnectionForms.record}->'source'->>'session_id'=${r.source.session_id}`,sql`${appConnectionForms.session_id}<>${r.session_id}`,
  sql`${appConnectionForms.record}->'begin_consumed'='true'::jsonb`,sql`NOT (${appConnectionForms.record}->>'state'='not_connected' AND ${appConnectionForms.record}->'input_consumed'='false'::jsonb)`)).limit(1);
 if(transition)throw new Conflict();
}
/** One transaction and target advisory lock cover both metadata carriers. The
 * source row lock intersects existing data/Run/observation admission share locks. */
export class PostgresAppConnectionFormStore implements FormStore{
 constructor(private readonly database:Database,private readonly profile:(r:AppConnectionFormRecord)=>Promise<AppConnectionProfile>){}
 async create(raw:AppConnectionFormRecord,caller:FormCaller){const r=AppConnectionFormRecordSchema.parse(raw);if(!admitted(r,caller)||r.revision!==1)return false;const profile=await this.profile(r);
  try{return await this.database.transaction(async tx=>{await targetLock(tx,r);if(await appConnectionCredentialRepairReservation(tx,{org_id:r.scope.org_id,resource_binding_id:r.scope.resource_binding_id}))throw new Conflict();await sourceCurrent(tx,r);await noEffects(tx,r);
   const [competing]=await tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,r.scope.org_id),eq(appConnectionSessions.owner_user_id,r.scope.owner_user_id),
    sql`${appConnectionSessions.record}->'scope'=${JSON.stringify(r.scope)}::jsonb`,r.source?sql`${appConnectionSessions.session_id}<>${r.source.session_id}`:undefined,
    sql`${appConnectionSessions.record}->>'state' NOT IN ('disconnected','not_connected')`,sql`NOT (${appConnectionSessions.record}->>'state' IN ('starting','awaiting_callback') AND ${appConnectionSessions.record}->'callback_consumed'='false'::jsonb AND ${appConnectionSessions.record}->'account'='null'::jsonb AND (${appConnectionSessions.record}->>'callback_expires_at')::timestamptz<=now())`)).limit(1).for('update');if(competing)return false;
   const carrier=FormCarrierSchema.parse({session_id:r.session_id,revision:1,scope:r.scope,profile,state:'starting',callback_state_hash:randomBytes(32).toString('hex'),callback_consumed:true,callback_expires_at:r.input_expires_at,runtime_session_ref:null,account:null,action_consents:r.action_consents,created_at:r.created_at,updated_at:r.updated_at});
   validateFormCarrierPair(r,carrier);
   const initial={...carrier,revision:0,callback_consumed:false};
   const rows=await tx.insert(appConnectionSessions).values({org_id:r.scope.org_id,owner_user_id:r.scope.owner_user_id,session_id:r.session_id,revision:0,record:initial,web_session_id:caller.sid,access_expires_at:new Date(caller.access_expires_at),created_at:new Date(r.created_at),updated_at:new Date(r.updated_at)}).onConflictDoNothing().returning({id:appConnectionSessions.session_id});if(rows.length!==1)throw new Conflict();
   await tx.update(appConnectionSessions).set({revision:1,record:carrier}).where(carrierWhere(locator(r)));
   const inserted=await tx.insert(appConnectionForms).values({org_id:r.scope.org_id,owner_user_id:r.scope.owner_user_id,session_id:r.session_id,revision:1,record:r,web_session_id:caller.sid,access_expires_at:new Date(caller.access_expires_at),created_at:new Date(r.created_at),updated_at:new Date(r.updated_at)}).onConflictDoNothing().returning({id:appConnectionForms.session_id});if(inserted.length!==1)throw new Conflict();return true;
  });}catch(error){if(error instanceof Conflict)return false;throw error;}
 }
 async read(q:FormLocator){return this.database.transaction(async tx=>(await pair(tx,q))?.form??null);}
 async metadata(q:FormLocator){return this.database.transaction(async tx=>(await pair(tx,q))?.metadata??null);}
 async compareAndSet(prior:AppConnectionFormRecord,raw:AppConnectionFormRecord,caller:FormCaller){const next=AppConnectionFormRecordSchema.parse(raw);if(!admitted(next,caller)||next.session_id!==prior.session_id||next.revision!==prior.revision+1)return false;
  try{return await this.database.transaction(async tx=>{await targetLock(tx,next);const before=await pair(tx,locator(prior),true);if(!before||!isDeepStrictEqual(before.form,prior))return false;
   if(await appConnectionCredentialRepairReservation(tx,{org_id:next.scope.org_id,resource_binding_id:next.scope.resource_binding_id}))return false;
   if(!prior.begin_consumed&&next.begin_consumed){await sourceCurrent(tx,next);await noEffects(tx,next);}
   if(next.receipt&&next.source)await sourceCurrent(tx,next);
   const carrier=projectFormCarrier(next,before.carrier);validateFormCarrierPair(next,carrier);
   const common=await tx.update(appConnectionSessions).set({revision:next.revision,record:carrier,web_session_id:caller.sid,access_expires_at:new Date(caller.access_expires_at),updated_at:new Date(next.updated_at)}).where(and(carrierWhere(locator(prior)),eq(appConnectionSessions.revision,prior.revision))).returning({id:appConnectionSessions.session_id});if(common.length!==1)throw new Conflict();
   const changed=await tx.update(appConnectionForms).set({revision:next.revision,record:next,web_session_id:caller.sid,access_expires_at:new Date(caller.access_expires_at),updated_at:new Date(next.updated_at)}).where(and(formWhere(locator(prior)),eq(appConnectionForms.revision,prior.revision))).returning({id:appConnectionForms.session_id});if(changed.length!==1)throw new Conflict();return true;
  });}catch(error){if(error instanceof Conflict)return false;throw error;}
 }
}
