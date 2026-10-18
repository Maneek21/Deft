import {appConsentDeadline} from '@deft/app-kit';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {AppRecordChangeAuthoritiesSchema,AppPreparedRecordChangeSchema,canonicalAppDataJson,type AppRecordPrepareChangeInput,type AppPreparedRecordChange} from '@deft/app-kit';
import type {CurrentAppDataAuthority} from './app-data-authority.js';
import {AppError} from './app-errors.js';
const denied=()=>{throw new AppError('App data access ended','APP_ACCESS_DENIED',403);};
export function recordChangeDigest(value:unknown){return 'sha256:'+createHash('sha256').update(canonicalAppDataJson(value)).digest('hex');}
export function recordChangeAuthorities(destination:CurrentAppDataAuthority,source:CurrentAppDataAuthority,input:AppRecordPrepareChangeInput,now=Date.now()){
 if(!isDeepStrictEqual(destination.scope,source.scope)||!isDeepStrictEqual(destination.connection,source.connection)
  ||destination.store.key!==input.store_key||source.store.key!==input.source.store_key
  ||!destination.store.record_changes?.some(change=>change.key===input.operation_key&&change.source_store_key===input.source.store_key)
  ||!destination.consent||!source.consent||Math.min(destination.expires_at,source.expires_at)<=now)denied();
 return AppRecordChangeAuthoritiesSchema.parse([destination,source].map((value,index)=>({role:index?'source':'destination',store_key:value.store.key,
  consent_id:value.consent!.consent_id,consent_digest:value.consent!.consent_digest,data_policy_digest:value.data_policy_digest,consent_expires_at:value.consent!.expires_at?.toISOString()??null,...(value.consent!.consent_lifetime?{consent_lifetime:value.consent!.consent_lifetime}:{})})));
}
export function sameRecordChangeAuthority(before:CurrentAppDataAuthority,after:CurrentAppDataAuthority,now=Date.now()){
 if(!isDeepStrictEqual(before.scope,after.scope)||!isDeepStrictEqual(before.connection,after.connection)||!isDeepStrictEqual(before.store,after.store)
  ||before.data_policy_digest!==after.data_policy_digest||!before.consent||!after.consent||before.consent.consent_id!==after.consent.consent_id
  ||before.consent.consent_digest!==after.consent.consent_digest||appConsentDeadline(before.consent.expires_at,before.consent.consent_lifetime)!==appConsentDeadline(after.consent.expires_at,after.consent.consent_lifetime)||after.expires_at<=now)denied();
}
export function verifyPreparedRecordChange(raw:unknown,destination:CurrentAppDataAuthority,source:CurrentAppDataAuthority,input:AppRecordPrepareChangeInput,now=Date.now()):AppPreparedRecordChange{
 const value=AppPreparedRecordChangeSchema.parse(raw),proofs=recordChangeAuthorities(destination,source,input,now),ref=input.source,operation_key=input.operation_key;
 const target={store_key:input.store_key,record_id:input.record_id,expected_revision:input.expected_revision,expected_content_digest:input.expected_content_digest};
 const {prepared_digest,...snapshot}=value;
 if(value.prepared_digest!==recordChangeDigest(snapshot)||value.authorization_digest!==recordChangeDigest({scope:destination.scope,connection:destination.connection,record_authorities:proofs})
  ||value.invocation_mode!==input.invocation_mode||value.schema_version!==(input.parameters===undefined?'deft.app_prepared_record_change.v1':'deft.app_prepared_record_change.v2')||value.schema_version==='deft.app_prepared_record_change.v2'&&!isDeepStrictEqual(value.parameters,input.parameters)||value.operation_key!==operation_key||value.account_ref!==destination.connection.account_ref||!isDeepStrictEqual(value.source,ref)||!isDeepStrictEqual(value.destination,target)
  ||Date.parse(value.expires_at)<=now||Date.parse(value.expires_at)>Math.min(now+300000,appConsentDeadline(destination.scope.consent_expires_at, destination.scope.consent_lifetime),...proofs.map(proof=>appConsentDeadline(proof.consent_expires_at, proof.consent_lifetime)))
  ||Buffer.byteLength(canonicalAppDataJson(value.value))>destination.store.max_record_bytes)denied();
 return value;
}
