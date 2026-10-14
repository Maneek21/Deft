import {getEmailMailboxAuthority} from './email-account-authority-router.js';
import type {EmailActor,EmailScope} from './email-mailbox-service.js';
import {EmailMailboxError} from './email-mailbox-service.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailSignatureStore} from './email-signature-store.js';
import {EmailSignatureService,type SignatureIdentityAvailability} from './email-signature-service.js';
import {PostgresEmailMailboxAuthority} from './email-mailbox-authority.js';
import {ConnectedEmailMailboxAuthority} from './email-mailbox-connected-authority.js';
import {getEmailMailboxComponents} from './email-mailbox-runtime.js';
import {getAppRunRuntime} from './app-run-runtime.js';
import {db} from './db.js';
import {NativeEmailSendIdentitySchema} from './email-native-adapter-contract.js';

/** Not mounted by default. Address availability is inspected through the
 * registered adapter; saved preferences remain readable if that inspection
 * fails or the account lacks a send capability. */
export async function getEmailSignatureService(actor:EmailActor){
 const base=await getEmailMailboxAuthority(db);
 const [{provider,resolve},{keys}]=await Promise.all([
  getEmailMailboxComponents((scope,tx,signal)=>base.current(actor,scope,'human_read',tx,signal)),getAppRunRuntime()]);
 const authority=new ConnectedEmailMailboxAuthority(base,provider),store=new EmailSignatureStore(db,new EmailMailboxCrypto(keys));
 const reader=async(scope:EmailScope,signal?:AbortSignal):Promise<SignatureIdentityAvailability>=>{
  const cap=await base.current(actor,scope,'human_read',undefined,signal),recheck=async()=>{const next=await base.current(actor,scope,'human_read',undefined,signal);
   if(next.authority_version!==cap.authority_version||next.resource_binding_id!==cap.resource_binding_id)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');};
  const {adapter,context}=await resolve(scope,cap,recheck,signal,'status');
  const account=await provider.assertConnected(scope,cap,recheck,signal);
  if(!account.capabilities.includes('send')||!adapter.nativeEmailSendIdentity)return {...scope,verified_sender_identities:[]};
  const identity=NativeEmailSendIdentitySchema.parse(await adapter.nativeEmailSendIdentity(context));
  if(identity.account_id!==scope.account_id||identity.org_id!==scope.org_id||identity.owner_user_id!==scope.owner_user_id
    ||identity.resource_binding_id!==cap.resource_binding_id||identity.principal_digest!==account.principal_digest
    ||identity.authority_epoch!==account.authority_epoch||identity.connection_revision!==account.connection_revision)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
  await recheck();const after=await provider.assertConnected(scope,cap,recheck,signal);
  if(after.authority_epoch!==account.authority_epoch||after.connection_revision!==account.connection_revision||after.principal_digest!==account.principal_digest)
    throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
  return {org_id:scope.org_id,owner_user_id:scope.owner_user_id,account_id:scope.account_id,verified_sender_identities:identity.verified_sender_identities};
 };
 return new EmailSignatureService(authority,store,reader);
}
