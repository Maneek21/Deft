import {and,eq,inArray,gt,asc} from 'drizzle-orm';
import {appConsentDeadline} from '@deft/app-kit/core';
import {appResourceProjections,appSyncCheckpoints} from '@deft/db/schema';
import {AppResourceSyncSecretService} from './app-resource-sync-secrets.js';
import type {AppRunKeyProvider} from './app-run-keyrings.js';
import type {AppRunTransaction} from './app-run-repository.js';
import {loadLiveAttachmentSyncBindingAuthority,attachmentSyncParticipantsAreHuman} from './app-attachment-sync-authority.js';
import {decodePrivateProjection} from './app-resource-private-projection.js';
import {AppIntegrationSourceMappingSchema,AppIntegrationSourceIdentitySchema,type AppIntegrationSourceIdentity,type AppIntegrationSourceTarget} from '../../../../packages/app-kit/src/app-integration-source.js';
import {AppDataResourceMetaSchema} from '../../../../packages/app-kit/src/app-data.js';
import {appIntegrationPublishedProjection,appIntegrationExactLocatorCandidate,appIntegrationProjectedIdentity,AppIntegrationSourcePendingError} from './app-integration-source-projection.js';
import type {AppIntegrationSourceCaller} from './app-integration-source.js';

/** Exact projection only. Uses established live signed-binding checks, secret
 * decoder and lock order; no scan, provider IDs or native mailbox tables. */
export function createAppIntegrationPublicationReader(input:{keys:AppRunKeyProvider;
 transaction<T>(fn:(tx:AppRunTransaction)=>Promise<T>):Promise<T>;clock?:()=>number}){
 const secrets=new AppResourceSyncSecretService(input.keys),clock=input.clock??Date.now;
 const read=async(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,tx:AppRunTransaction)=>{
  const authority=await loadLiveAttachmentSyncBindingAuthority(tx,{org_id:caller.org_id,resource_binding_id:target.resource_binding_id,clock:()=>new Date(clock())});
  if(!authority||authority.binding.owner_user_id!==caller.user_id||authority.installation.id!==target.installation_id
   ||authority.binding.resource_key!==target.ref.resource_key)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
  const manifest=authority.version.manifest as {record_stores?:Array<{key:string;resource_key:string;source_projection?:unknown}>};
  const store=manifest.record_stores?.find(row=>row.key===target.store_key&&row.resource_key===target.ref.resource_key);
  const mapping=AppIntegrationSourceMappingSchema.parse(store?.source_projection);
  const [checkpoint]=await tx.select().from(appSyncCheckpoints).where(and(eq(appSyncCheckpoints.org_id,caller.org_id),
   eq(appSyncCheckpoints.resource_binding_id,target.resource_binding_id),eq(appSyncCheckpoints.state,'active'))).limit(1).for('share');
  if(!checkpoint)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
  const [row]=await tx.select().from(appResourceProjections).where(and(eq(appResourceProjections.org_id,caller.org_id),
   eq(appResourceProjections.id,target.projection_id),eq(appResourceProjections.resource_binding_id,target.resource_binding_id),
   eq(appResourceProjections.checkpoint_id,checkpoint.id),eq(appResourceProjections.generation,checkpoint.generation),eq(appResourceProjections.state,'live'))).limit(1).for('share');
  if(!row)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
  const {attachments:unused,...descriptor}=authority.descriptor;void unused;
  const record=decodePrivateProjection(secrets,row,{...descriptor,schema_version:'deft.app_sync_descriptor.v1'});
  const result=appIntegrationPublishedProjection({target,mapping,descriptor_key:authority.descriptor.key,checkpoint,row,record});
  if(!await attachmentSyncParticipantsAreHuman(tx,authority.binding.owner_user_id,authority.registration.operator_user_id)
   ||appConsentDeadline(authority.binding.consent_expires_at,authority.binding.consent_lifetime??undefined)<=clock())throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
  return result;
 };
 const reader=(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,tx?:AppRunTransaction)=>tx?read(caller,target,tx):input.transaction(tx=>read(caller,target,tx));
 const resolveProjectionIdentity=async(caller:AppIntegrationSourceCaller,scope:{installation_id:string;store_key:string;account_ref:string;resource_key:string},resource_binding_id:string,value:string|ReturnType<typeof AppDataResourceMetaSchema.parse>,expected?:AppIntegrationSourceIdentity)=>input.transaction(async tx=>{
   const authority=await loadLiveAttachmentSyncBindingAuthority(tx,{org_id:caller.org_id,resource_binding_id,clock:()=>new Date(clock())});
   if(!authority||authority.binding.owner_user_id!==caller.user_id||authority.installation.id!==scope.installation_id||authority.binding.resource_key!==scope.resource_key)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
   const manifest=authority.version.manifest as {record_stores?:Array<{key:string;resource_key:string;source_projection?:unknown}>};
   const mapping=AppIntegrationSourceMappingSchema.parse(manifest.record_stores?.find(row=>row.key===scope.store_key&&row.resource_key===scope.resource_key)?.source_projection);
   const logical=typeof value==='string'?value:value.data[mapping.projection_identity_field];
   if(typeof logical!=='string'||!logical||logical.length>256)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
   const [checkpoint]=await tx.select().from(appSyncCheckpoints).where(and(eq(appSyncCheckpoints.org_id,caller.org_id),eq(appSyncCheckpoints.resource_binding_id,resource_binding_id),eq(appSyncCheckpoints.state,'active'))).limit(1).for('share');
   if(!checkpoint)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
   const versions=await tx.selectDistinct({version:appResourceProjections.resource_id_hmac_key_version}).from(appResourceProjections).where(and(eq(appResourceProjections.org_id,caller.org_id),eq(appResourceProjections.resource_binding_id,resource_binding_id),eq(appResourceProjections.checkpoint_id,checkpoint.id))).limit(33);
   if(versions.length>32)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
   if(!versions.length)throw new AppIntegrationSourcePendingError();
   const locators=secrets.locatorCandidates(logical,{org_id:caller.org_id,resource_binding_id,checkpoint_id:checkpoint.id},versions.map(row=>row.version));
   if(locators.length>32||!locators.length)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
   const rows=await tx.select().from(appResourceProjections).where(and(eq(appResourceProjections.org_id,caller.org_id),eq(appResourceProjections.resource_binding_id,resource_binding_id),eq(appResourceProjections.checkpoint_id,checkpoint.id),eq(appResourceProjections.generation,checkpoint.generation),eq(appResourceProjections.state,'live'),inArray(appResourceProjections.resource_id_hmac_key_version,locators.map(row=>row.key_version)),inArray(appResourceProjections.resource_id_hmac,locators.map(row=>row.fingerprint)))).limit(33).for('share');
   const exact=appIntegrationExactLocatorCandidate(rows,locators);
   const providerIdentity=secrets.openJson({schema_version:exact.provider_id_envelope_version,algorithm:exact.provider_id_algorithm,key_version:exact.provider_id_key_version,nonce_b64:exact.provider_id_nonce_b64,ciphertext_b64:exact.provider_id_ciphertext_b64,auth_tag_b64:exact.provider_id_auth_tag_b64},{org_id:caller.org_id,resource_binding_id,checkpoint_id:checkpoint.id,payload_kind:'projection',generation:exact.generation,projection_id:exact.id,slot:'provider_id'});
   if(providerIdentity!==logical)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
   const {attachments:unused,...descriptor}=authority.descriptor;void unused;
   const record=decodePrivateProjection(secrets,exact,{...descriptor,schema_version:'deft.app_sync_descriptor.v1'});
   const identity=appIntegrationProjectedIdentity(scope,mapping,record,logical);
   if(expected&&(identity.ref.record_id!==expected.ref.record_id||identity.ref.content_digest!==expected.ref.content_digest))throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
   const target={...identity,resource_binding_id,projection_id:exact.id};
   await read(caller,target,tx);return target;
 });
 return Object.assign(reader,{async candidates(caller:AppIntegrationSourceCaller,scope:{installation_id:string;store_key:string;account_ref:string;resource_key:string},resource_binding_id:string,cursor:{checkpoint_id:string|null;after:string|null}){
  return input.transaction(async tx=>{
   const authority=await loadLiveAttachmentSyncBindingAuthority(tx,{org_id:caller.org_id,resource_binding_id,clock:()=>new Date(clock())});
   if(!authority||authority.binding.owner_user_id!==caller.user_id||authority.installation.id!==scope.installation_id||authority.binding.resource_key!==scope.resource_key)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
   const manifest=authority.version.manifest as {record_stores?:Array<{key:string;resource_key:string;source_projection?:unknown}>};
   const mapping=AppIntegrationSourceMappingSchema.parse(manifest.record_stores?.find(row=>row.key===scope.store_key&&row.resource_key===scope.resource_key)?.source_projection);
   const [checkpoint]=await tx.select().from(appSyncCheckpoints).where(and(eq(appSyncCheckpoints.org_id,caller.org_id),eq(appSyncCheckpoints.resource_binding_id,resource_binding_id),eq(appSyncCheckpoints.state,'active'))).limit(1).for('share');
   if(!checkpoint)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
   const after=cursor.checkpoint_id===checkpoint.id?cursor.after:null;
   // One scoped encrypted projection per delivery; durable policy progress is
   // scheduling metadata only and resets after a checkpoint/App replacement.
   const [row]=await tx.select().from(appResourceProjections).where(and(eq(appResourceProjections.org_id,caller.org_id),eq(appResourceProjections.resource_binding_id,resource_binding_id),eq(appResourceProjections.checkpoint_id,checkpoint.id),eq(appResourceProjections.generation,checkpoint.generation),eq(appResourceProjections.state,'live'),after?gt(appResourceProjections.id,after):undefined)).orderBy(asc(appResourceProjections.id)).limit(1).for('share');
   if(!row)return {checkpoint_id:checkpoint.id,target:null};
   const {attachments:unused,...descriptor}=authority.descriptor;void unused;
   const record=decodePrivateProjection(secrets,row,{...descriptor,schema_version:'deft.app_sync_descriptor.v1'});
   const target={installation_id:scope.installation_id,account_ref:scope.account_ref,store_key:scope.store_key,resource_binding_id,projection_id:row.id,ref:{resource_key:scope.resource_key,record_id:String(record.data[mapping.record_id_field]),content_digest:String(record.data[mapping.content_digest_field])}};
   appIntegrationPublishedProjection({target,mapping,descriptor_key:authority.descriptor.key,checkpoint,row,record});
   return {checkpoint_id:checkpoint.id,target};
  });
 },async resolve(caller:AppIntegrationSourceCaller,raw:AppIntegrationSourceIdentity,resource_binding_id:string,rawResource:unknown){
  const identity=AppIntegrationSourceIdentitySchema.parse(raw),resource=AppDataResourceMetaSchema.parse(rawResource);
  if(resource.tombstone||resource.record_id!==identity.ref.record_id||resource.content_digest!==identity.ref.content_digest)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
  return resolveProjectionIdentity(caller,{...identity,resource_key:identity.ref.resource_key},resource_binding_id,resource,identity);
 },resolveProjectionIdentity});
}
