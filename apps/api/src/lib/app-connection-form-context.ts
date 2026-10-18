import {and,desc,eq,sql} from 'drizzle-orm';
import {isDeepStrictEqual} from 'node:util';
import {AppConnectionFormContextSchema,AppConnectionFormRecordSchema,AppConnectionFormSessionViewSchema} from '../../../../packages/app-kit/src/connection-form.js';
import {appConnectionForms} from '../../../../packages/db/src/schema/app-connection-forms.js';
import {currentConnectionBindingLocators} from './app-connection-current-locators.js';
import {currentAppConnectionMetadataAuthority} from './app-connection-session-authority.js';
import {appConnectionFormPredecessorIsAvailable} from './app-connection-form-fence.js';
import {db} from './db.js';
import {AppError} from './app-errors.js';
import type {FormCaller} from './app-connection-form-service.js';
import type {WebAuthorityGuard} from './app-resource-sync-web-authority.js';
/** Metadata discovery cannot disclose a form ticket, runtime ref or credentials.
 * A source nomination grants no authority and is revalidated in atomic Begin. */
export async function appConnectionFormContext(caller:FormCaller,installationId:string,guard:WebAuthorityGuard){
 const bindings=await currentConnectionBindingLocators(db,caller,{installation_id:installationId}).limit(33);
 if(bindings.length>32)throw new AppError('Setup context exceeds bound','APP_PROVIDER_UNAVAILABLE',503);
 const targets=[];
 for(const target_key of [...new Set(bindings.map(row=>row.target_key))].sort())try{
  const current=await currentAppConnectionMetadataAuthority(caller,{installation_id:installationId,target_key},guard);
  if(current.connection_protocol!=='credential_form.v1')continue;
  const owned=and(eq(appConnectionForms.org_id,caller.org_id),eq(appConnectionForms.owner_user_id,caller.user_id),
   sql`${appConnectionForms.record}->'scope'->>'installation_id'=${installationId}`,sql`${appConnectionForms.record}->'scope'->>'target_key'=${target_key}`);
  const [row]=await db.select().from(appConnectionForms).where(and(owned,sql`${appConnectionForms.record}->'scope'=${JSON.stringify(current.scope)}::jsonb`)).orderBy(desc(appConnectionForms.created_at),desc(appConnectionForms.session_id)).limit(1);
  const record=row?AppConnectionFormRecordSchema.parse(row.record):null;
  if(record&&record.revision!==row!.revision)throw new AppError('Setup changed','APP_ACCESS_DENIED',403);
  const [prior]=await db.select().from(appConnectionForms).where(and(owned,sql`${appConnectionForms.record}->>'state'='connected'`,
   sql`${appConnectionForms.record}->'scope'->>'resource_key'=${current.scope.resource_key}`,sql`${appConnectionForms.record}->'scope'->>'operator_user_id'=${current.scope.operator_user_id}`))
   .orderBy(desc(appConnectionForms.created_at),desc(appConnectionForms.session_id)).limit(1);
  const source=prior?AppConnectionFormRecordSchema.parse(prior.record):null;
  const available=source&&source.revision===prior!.revision&&await db.transaction(tx=>appConnectionFormPredecessorIsAvailable(tx,{org_id:caller.org_id,owner_user_id:caller.user_id,session_id:source.session_id}));
  const blocked=record&&!['connected','not_connected','disconnected'].includes(record.state);
  const candidate=!blocked&&available&&source?.account?{source_session_id:source.session_id,account:source.account}:null;
  const after=await currentAppConnectionMetadataAuthority(caller,{installation_id:installationId,target_key},guard);
  if(!isDeepStrictEqual(current.scope,after.scope)||after.connection_protocol!=='credential_form.v1')continue;
  const session=record?AppConnectionFormSessionViewSchema.parse(Object.fromEntries(Object.entries({...record,schema_version:'deft.app_connection_form_session.v1'}).filter(([key])=>!['action_consents','source','transport_digest','authorization_origin','runtime_session_ref'].includes(key)))):null;
  targets.push({target_key,profile:{key:current.profile.key,label:current.profile.provider_id,authorization_origin:current.profile.authorization_origin},scope:current.scope,runtime_ready:current.runtime_ready,
   action_keys:('action_consents' in current?current.action_consents:[]).map(value=>value.action_key),session,candidate});
 }catch(error){if(error instanceof AppError&&error.code==='APP_ACCESS_DENIED')continue;throw error;}
 await db.transaction(tx=>guard(tx));
 return AppConnectionFormContextSchema.parse({schema_version:'deft.app_connection_form_context.v1',installation_id:installationId,org_id:caller.org_id,owner_user_id:caller.user_id,targets});
}
