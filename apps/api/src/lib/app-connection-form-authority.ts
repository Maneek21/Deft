import {appConsentDeadline} from '@deft/app-kit';
import {isDeepStrictEqual} from 'node:util';
import {AppConnectionFormAuthorityRequestSchema,AppConnectionFormAuthorityResultSchema} from '../../../../packages/app-kit/src/connection-form.js';
import {db} from './db.js';
import {AppError} from './app-errors.js';
import {currentAppConnectionFormAuthority,retainedWebGuard} from './app-connection-session-authority.js';
import {getAppConnectionSessionRegistry} from './app-connection-session-registry.js';
import {PostgresAppConnectionFormStore} from './app-connection-form-store.js';
import {AppConnectionFormRecordSchema} from '../../../../packages/app-kit/src/connection-form.js';
import type {FormCaller,FormPorts,FormAuthority} from './app-connection-form-service.js';
import type {WebAuthorityGuard} from './app-resource-sync-web-authority.js';
import {appConnectionFormPredecessorIsAvailable} from './app-connection-form-fence.js';
const denied=()=>new AppError('Credential setup access ended','APP_ACCESS_DENIED',403);
async function authority(caller:FormCaller,nomination:{installation_id:string;target_key:string},guard:WebAuthorityGuard):Promise<FormAuthority>{
 const value=await currentAppConnectionFormAuthority(caller,nomination,guard),registry=await getAppConnectionSessionRegistry();
 if(registry.protocol(value.scope,value.profile)!=='credential_form.v1')throw denied();
 return {...value,connection_protocol:'credential_form.v1',authorization_origin:value.profile.authorization_origin,
  transport_digest:registry.transportDigest(value.scope.org_id,value.scope.installation_id,value.profile)};
}
/** The existing current owner resource admission and independently reviewed
 * action bindings are reconstructed; configuration is an additional pin only. */
export function productionAppConnectionFormPorts(caller:FormCaller,guard:WebAuthorityGuard):FormPorts{
 const profile=async(record:{scope:{installation_id:string;target_key:string}})=>(await currentAppConnectionFormAuthority(caller,record.scope,guard)).profile;
 return {store:new PostgresAppConnectionFormStore(db,profile),sourceAvailable:record=>db.transaction(tx=>appConnectionFormPredecessorIsAvailable(tx,{org_id:record.scope.org_id,owner_user_id:record.scope.owner_user_id,session_id:record.session_id})),current:(active,nomination)=>authority(active,nomination,guard),
  request:async(record,input,signal)=>(await getAppConnectionSessionRegistry()).formRuntime(record.scope,await profile(record)).request(input,signal)};
}
/** Operator-only exact durable form identity. Submit is the only60s operation;
 * all current member/session/consent/action checks remain online. */
export async function appConnectionFormRuntimeAuthority(raw:unknown,authorization:string|undefined){
 const input=AppConnectionFormAuthorityRequestSchema.parse(raw),registry=await getAppConnectionSessionRegistry();registry.authenticate(input.scope,authorization);
 const store=new PostgresAppConnectionFormStore(db,async()=>{throw denied();}),q={org_id:input.scope.org_id,owner_user_id:input.scope.owner_user_id,session_id:input.session_id};
 const row=await store.metadata(q);if(!row)throw denied();const record=AppConnectionFormRecordSchema.parse(row.record);
 if(!await db.transaction(tx=>appConnectionFormPredecessorIsAvailable(tx,q)))throw denied();
 if(!record.begin_consumed||!isDeepStrictEqual(record.scope,input.scope)||!isDeepStrictEqual(record.source,input.source)
  ||!isDeepStrictEqual(record.action_consents,input.action_consents)||record.input_expires_at!==input.setup_expires_at
  ||input.operation!=='begin'&&input.runtime_session_ref!==null&&record.runtime_session_ref!==input.runtime_session_ref)throw denied();
 if(input.operation==='begin'&&(record.state!=='starting'||record.runtime_session_ref!==null)
  ||input.operation==='status'&&!['checking','awaiting_input'].includes(record.state)
  ||input.operation==='disconnect'&&record.state!=='disconnecting'
  ||input.operation==='submit'&&(record.input_consumed||!record.runtime_session_ref||!['awaiting_input','checking','indeterminate'].includes(record.state)))throw denied();
 const caller={org_id:q.org_id,user_id:q.owner_user_id,sid:row.web_session_id,access_expires_at:row.access_expires_at.getTime()},current=await authority(caller,{installation_id:record.scope.installation_id,target_key:record.scope.target_key},retainedWebGuard(caller));
 if(!isDeepStrictEqual(current.scope,record.scope)||current.transport_digest!==record.transport_digest||current.authorization_origin!==record.authorization_origin)throw denied();
 if(['begin','submit'].includes(input.operation)&&!isDeepStrictEqual(current.action_consents,record.action_consents))throw denied();
 const deadline=Math.min(Date.parse(input.expires_at),current.expires_at,appConsentDeadline(record.scope.consent_expires_at, record.scope.consent_lifetime),Date.now()+(input.operation==='submit'?60000:30000),
  ['begin','submit'].includes(input.operation)?Date.parse(record.input_expires_at):Infinity,
  ...(['begin','submit'].includes(input.operation)?record.action_consents.map(c=>appConsentDeadline(c.expires_at,c.consent_lifetime)):[]));
 const after=await store.metadata(q);if(!after||after.revision!==row.revision||deadline<=Date.now())throw denied();
 (await getAppConnectionSessionRegistry()).authenticate(current.scope,authorization);
 return AppConnectionFormAuthorityResultSchema.parse({...input,allowed:true,expires_at:new Date(deadline).toISOString()});
}
