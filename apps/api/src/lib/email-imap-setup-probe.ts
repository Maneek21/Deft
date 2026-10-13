import {AppConnectionPinsSchema,type AppConnectionPins,type NativeEmailConnectionContext,type NativeEmailImapHostFactory} from './app-connection-contract.js';
import {EmailImapCredentialCustody,EmailImapSetupProfileSchema,type EmailImapCredentialRecord,type EmailImapProfileInput} from './email-imap-custody.js';
import {createEmailImapHost,type EmailImapHostAccount,type EmailImapHostDependencies} from './email-imap-host.js';
import {createEmailSmtpHost} from './email-smtp-host.js';
import type {AppRunKeyProvider} from './app-run-keyrings.js';

type Input={context:NativeEmailConnectionContext;pins:AppConnectionPins;profile:unknown;keys:AppRunKeyProvider;
 constructors:Parameters<NativeEmailImapHostFactory>[0];lookup?:EmailImapHostDependencies['lookup'];now?:()=>Date};

/** Host-only preflight. No persistent credential writes, messages, mailbox
 * reads, or provider mutations. The caller must save the returned profile with
 * a fresh owner/session guard and expected-revision CAS. Never JSON-serialize
 * the return value to a browser: it contains the supplied credentials. SMTP
 * AUTH proves connection credentials, not permission to use every From alias. */
export async function verifyEmailImapSetup(input:Input):Promise<EmailImapProfileInput>{
 const pins=AppConnectionPinsSchema.parse(input.pins),profile=EmailImapSetupProfileSchema.parse(input.profile),context=input.context;
 const deny=():never=>{throw Error('EMAIL_ACCESS_DENIED');};
 const check=async()=>{
  if(context.org_id!==pins.org_id||context.owner_user_id!==pins.owner_user_id||context.installation_id!==pins.installation_id
   ||context.resource_binding_id!==pins.resource_binding_id||context.expires_at<=Date.now()||!context.account_id)return deny();
  context.signal?.throwIfAborted();await context.recheck();context.signal?.throwIfAborted();
 };
 let record:EmailImapCredentialRecord|null=null;
 try{
  await check();if(profile.smtp&&(!pins.action_binding_id||pins.action_key!=='send_message'))return deny();
  const custody=new EmailImapCredentialCustody(input.keys,{read:async()=>{await check();return record;},
   compareAndSwap:async request=>{await check();if(record||request.expected_revision!==0)return false;record=request.record;return true;}});
  const scope={org_id:context.org_id,owner_user_id:context.owner_user_id,account_id:context.account_id};
  const saved=await custody.saveProfile(scope,0,profile,check,context.signal);
  const account:EmailImapHostAccount={...scope,installation_id:pins.installation_id,resource_binding_id:pins.resource_binding_id,
   provider:'imap_smtp',authority_epoch:1,connection_revision:saved.connection_revision,principal_digest:saved.principal_digest,
   health:'connected',capabilities:profile.smtp?['read','send']:['read'],primary_address:profile.identity.primary_address,display_label:profile.identity.display_label,
   connection_target:pins.target_key,...(pins.action_binding_id?{action_binding_id:pins.action_binding_id}:{}),verified_sender_identities:profile.smtp?[profile.identity.primary_address]:[]};
  const {org_id:_org,owner_user_id:_owner,installation_id:_install,connection_target:_target,action_binding_id:_action,verified_sender_identities:_senders,...expected}=account;
  const current=async()=>{await check();return account;};
  const imap=createEmailImapHost({custody,current,ImapFlow:input.constructors.ImapFlow,lookup:input.lookup});
  await imap.withAuthorizedClient({...context,recheck:check},expected,async()=>undefined);
  if(profile.smtp){
   const smtp=createEmailSmtpHost({custody,current,createTransport:input.constructors.createTransport,lookup:input.lookup});
   await smtp.withAuthorizedSmtp({...context,recheck:check},expected,async transport=>{
    if(!transport.verify)throw Error('EMAIL_SMTP_UNAVAILABLE');await transport.verify();
   });
  }
  await check();const verifiedAt=(input.now??(()=>new Date()))();
  if(!Number.isFinite(verifiedAt.getTime())||verifiedAt.getTime()>Date.now())throw Error('EMAIL_IMAP_PROFILE_INVALID');
  return {...profile,...(profile.smtp?{smtp:{...profile.smtp}}:{}),identity:{...profile.identity},verified_at:verifiedAt.toISOString()};
 }finally{profile.password='';if(profile.smtp)profile.smtp.password='';record=null;}
}
