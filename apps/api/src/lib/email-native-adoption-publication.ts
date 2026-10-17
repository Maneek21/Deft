import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {and,eq,sql} from 'drizzle-orm';
import {AppConnectionSessionScopeSchema,canonicalAppDataJson} from '@deft/app-kit';
import {appConnectionSessions} from '@deft/db/schema';
import {db} from './db.js';
import {AppError} from './app-errors.js';
import type {ExperienceCaller} from './app-experience-service.js';
import type {WebAuthorityGuard} from './app-resource-sync-web-authority.js';
import type {AppRunTransaction as Tx} from './app-run-repository.js';
import {currentAppConnectionReadAuthority} from './app-connection-session-authority.js';
import {AppConnectionSessionRecordSchema} from './app-connection-session-service.js';
import {connectionSessionAdmissionFence} from './app-connection-session-store.js';
const Hash=z.string().regex(/^[a-f0-9]{64}$/u),Id=z.string().uuid(),Account=z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u);
const Scope=z.strictObject({org_id:Id,owner_user_id:Id,account_id:Account});
export const NativeAdoptionAdmissionSchema=z.strictObject({schema_version:z.literal('email.native_activation_admission.v1'),adoption_id:Id,scope:Scope,snapshot_digest:Hash,source_principal_digest:Hash,destination_scope:AppConnectionSessionScopeSchema,
 destination_binding:z.strictObject({scope:z.strictObject({org_id:Id,owner_id:Id,installation_id:Id}),account_id:Account,provider:z.literal('gmail'),connection_target:z.string(),resource_binding_id:Id,action_binding_id:z.null(),authority_epoch:z.number().int().positive(),capabilities:z.tuple([z.literal('read'),z.literal('search'),z.literal('thread')])}),session_id:Id});
export const NativeAdoptionReceiptSchema=z.strictObject({schema_version:z.literal('email.native_activation_receipt.v1'),adoption_id:Id,admission_digest:Hash,snapshot_digest:Hash,session_id:Id,runtime_session_ref:z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u),custody_generation:z.number().int().positive(),principal_digest:Hash,account:z.strictObject({account_ref:Account,label:z.string().min(1).max(320)}),receipt_digest:Hash});
type Admission=z.infer<typeof NativeAdoptionAdmissionSchema>;
const digest=(value:unknown)=>createHash('sha256').update(canonicalAppDataJson(value)).digest('hex');
const denied=()=>new AppError('Native adoption authority changed','APP_ACCESS_DENIED',403);
const conflict=()=>new AppError('Native adoption publication changed','APP_STATE_CONFLICT',409);
async function authority(tx:Tx,caller:ExperienceCaller,admission:Admission,guard:WebAuthorityGuard){
 const s=admission.scope,d=admission.destination_scope,b=admission.destination_binding;
 if(s.org_id!==caller.org_id||s.owner_user_id!==caller.user_id||d.org_id!==s.org_id||d.owner_user_id!==s.owner_user_id||b.account_id!==s.account_id||b.connection_target!==d.target_key||b.resource_binding_id!==d.resource_binding_id||!isDeepStrictEqual(b.scope,{org_id:s.org_id,owner_id:s.owner_user_id,installation_id:d.installation_id}))throw denied();
 const current=await currentAppConnectionReadAuthority(caller,{installation_id:d.installation_id,target_key:d.target_key},guard,'none',tx);
 if(!isDeepStrictEqual(current.scope,d)||current.action_consent||current.action_consents?.length||current.expires_at<=Date.now())throw denied();return current;
}
async function marker(tx:Tx,admission:Admission){const s=admission.scope;const rows=await tx.execute(sql`SELECT * FROM native_email_adoptions WHERE org_id=${s.org_id} AND owner_user_id=${s.owner_user_id} AND account_id=${s.account_id} FOR UPDATE`);const row=rows.rows[0];
 if(!row||row.adoption_id!==admission.adoption_id||row.source_principal_digest!==admission.source_principal_digest)throw denied();return row;}
/** Operator-only, invoked after matched export/import proof. This is not an HTTP
 * caller-nominated account endpoint and carries no native grant into the target. */
export async function prepareNativeAdoptionDestination(caller:ExperienceCaller,raw:unknown,guard:WebAuthorityGuard){
 const admission=NativeAdoptionAdmissionSchema.parse(raw);return db.transaction(async tx=>{
  const current=await authority(tx,caller,admission,guard),row=await marker(tx,admission),s=admission.scope;
  const prior=(await tx.execute(sql`SELECT admission,profile FROM native_email_adoption_destinations WHERE org_id=${s.org_id} AND owner_user_id=${s.owner_user_id} AND account_id=${s.account_id}`)).rows[0];
  if(prior){if(!isDeepStrictEqual(prior.admission,admission)||!isDeepStrictEqual(prior.profile,current.profile)||row.state!=='runtime_prepared')throw conflict();return {admission_digest:digest(admission),state:'runtime_prepared'};}
  if(row.state!=='native_frozen')throw conflict();
  await tx.execute(sql`INSERT INTO native_email_adoption_destinations(org_id,owner_user_id,account_id,adoption_id,session_id,admission,profile,created_at) VALUES(${s.org_id},${s.owner_user_id},${s.account_id},${admission.adoption_id},${admission.session_id},${JSON.stringify(admission)}::jsonb,${JSON.stringify(current.profile)}::jsonb,clock_timestamp())`);
  await tx.execute(sql`UPDATE native_email_adoptions SET state='runtime_prepared',revision=revision+1,snapshot_digest=${admission.snapshot_digest},destination_binding_digest=${digest(admission.destination_binding)},destination_admission_digest=${digest(admission)},updated_at=clock_timestamp() WHERE org_id=${s.org_id} AND owner_user_id=${s.owner_user_id} AND account_id=${s.account_id}`);
  await authority(tx,caller,admission,guard);return {admission_digest:digest(admission),state:'runtime_prepared'};
 });
}
/** Commit the exact prepared Runtime receipt and ordinary Host connected session
 * atomically. Runtime visibility still requires its separate publish CAS. */
export async function publishNativeAdoptionDestination(caller:ExperienceCaller,raw:unknown,rawReceipt:unknown,guard:WebAuthorityGuard){
 const admission=NativeAdoptionAdmissionSchema.parse(raw),receipt=NativeAdoptionReceiptSchema.parse(rawReceipt),{receipt_digest,...pins}=receipt;
 if(digest(pins)!==receipt_digest||receipt.adoption_id!==admission.adoption_id||receipt.admission_digest!==digest(admission)||receipt.snapshot_digest!==admission.snapshot_digest||receipt.session_id!==admission.session_id||receipt.principal_digest!==admission.source_principal_digest||receipt.account.account_ref!==admission.scope.account_id)throw denied();
 return db.transaction(async tx=>{
  const current=await authority(tx,caller,admission,guard),row=await marker(tx,admission),s=admission.scope,d=admission.destination_scope;
  const prior=(await tx.execute(sql`SELECT admission,profile,receipt FROM native_email_adoption_destinations WHERE org_id=${s.org_id} AND owner_user_id=${s.owner_user_id} AND account_id=${s.account_id} FOR UPDATE`)).rows[0];
  if(!prior||!isDeepStrictEqual(prior.admission,admission)||!isDeepStrictEqual(prior.profile,current.profile))throw conflict();
  if(row.snapshot_digest!==admission.snapshot_digest||row.destination_binding_digest!==digest(admission.destination_binding)||row.destination_admission_digest!==digest(admission))throw conflict();
  if(row.state==='runtime_active'){
   if(!isDeepStrictEqual(prior.receipt,receipt)||row.runtime_receipt_digest!==receipt_digest)throw conflict();
   const [published]=await tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,s.org_id),eq(appConnectionSessions.owner_user_id,s.owner_user_id),eq(appConnectionSessions.session_id,admission.session_id))).for('share');
   if(!published)throw conflict();const record=AppConnectionSessionRecordSchema.parse(published.record);
   if(record.state!=='connected'||record.revision!==1||!isDeepStrictEqual(record.scope,d)||!isDeepStrictEqual(record.profile,current.profile)||!isDeepStrictEqual(record.account,receipt.account)||record.runtime_session_ref!==receipt.runtime_session_ref||record.action_consents?.length||record.callback_state_hash!==digest(['native-adoption',admission.adoption_id,admission.session_id])||!record.callback_consumed)throw conflict();
   await authority(tx,caller,admission,guard);return {session_id:admission.session_id,state:'runtime_active'};
  }
  if(row.state!=='runtime_prepared'||prior.receipt!==null)throw conflict();
  const domain=[d.org_id,d.owner_user_id,d.installation_id,d.target_key].join(':');await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('deft.app_connection_session.target.v1'),hashtext(${domain}))`);
  const [competing]=await tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions).where(connectionSessionAdmissionFence(d,new Date())).limit(1).for('update');if(competing)throw conflict();
  const now=new Date().toISOString(),record=AppConnectionSessionRecordSchema.parse({session_id:admission.session_id,revision:1,scope:d,profile:current.profile,state:'connected',callback_state_hash:digest(['native-adoption',admission.adoption_id,admission.session_id]),callback_consumed:true,callback_expires_at:now,runtime_session_ref:receipt.runtime_session_ref,account:receipt.account,created_at:now,updated_at:now,action_consents:[]});
  const starting={...record,revision:0,state:'starting' as const,callback_consumed:false,runtime_session_ref:null,account:null};
  await tx.insert(appConnectionSessions).values({org_id:s.org_id,owner_user_id:s.owner_user_id,session_id:admission.session_id,revision:0,web_session_id:caller.sid,access_expires_at:new Date(current.expires_at),record:starting,created_at:new Date(now),updated_at:new Date(now)});
  await tx.update(appConnectionSessions).set({revision:1,record,updated_at:new Date(now)}).where(and(eq(appConnectionSessions.org_id,s.org_id),eq(appConnectionSessions.owner_user_id,s.owner_user_id),eq(appConnectionSessions.session_id,admission.session_id)));
  await tx.execute(sql`UPDATE native_email_adoption_destinations SET receipt=${JSON.stringify(receipt)}::jsonb,published_at=${now}::timestamptz WHERE org_id=${s.org_id} AND owner_user_id=${s.owner_user_id} AND account_id=${s.account_id}`);
  await tx.execute(sql`UPDATE native_email_adoptions SET state='runtime_active',revision=revision+1,runtime_receipt_digest=${receipt_digest},updated_at=${now}::timestamptz WHERE org_id=${s.org_id} AND owner_user_id=${s.owner_user_id} AND account_id=${s.account_id}`);
  await authority(tx,caller,admission,guard);return {session_id:admission.session_id,state:'runtime_active'};
 });
}
