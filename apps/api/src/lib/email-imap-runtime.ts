import {and,eq} from 'drizzle-orm';
import {emailAccounts,emailImapCredentials} from '@deft/db/schema';
import {AppConnectionPinsSchema,type AppConnectionPins,type NativeEmailAccount,type NativeEmailConnectionContext,type NativeEmailImapHostFactory} from './app-connection-contract.js';
import {EmailImapCredentialCustody,type EmailImapCredentialRecord} from './email-imap-custody.js';
import {createEmailImapHost,type EmailImapHostAccount} from './email-imap-host.js';
import {createEmailSmtpHost} from './email-smtp-host.js';
import type {AppRunKeyProvider} from './app-run-keyrings.js';

type Constructors=Parameters<NativeEmailImapHostFactory>[0];
const registeredConstructors=new Map<string,Constructors>();
const registryKey=(pins:AppConnectionPins)=>JSON.stringify(AppConnectionPinsSchema.parse(pins));
export function getRegisteredEmailImapConstructors(pins:AppConnectionPins){const constructors=registeredConstructors.get(registryKey(pins));if(!constructors)throw Error('EMAIL_IMAP_SETUP_UNAVAILABLE');return constructors;}
type Row={provider:string;state:string;authority_revision:number;principal_digest:string|null;credential:EmailImapCredentialRecord};
type Ports={read(context:NativeEmailConnectionContext):Promise<Row|null>;keys():Promise<AppRunKeyProvider>};
const denied=():never=>{throw Error('EMAIL_ACCESS_DENIED');};

/** The registry captures exact reviewed pins. Profile reads take no new locks:
 * adoption already holds its account write lock, and the trusted context checks
 * authority before and after each read. Credential CAS uses its separate setup
 * transaction; no adapter can write credentials through this host. */
export function createPinnedEmailImapHost(rawPins:AppConnectionPins,constructors:Constructors,ports:Ports){
 const pins=Object.freeze(AppConnectionPinsSchema.parse(rawPins));
 const check=async(context:NativeEmailConnectionContext)=>{
  if(context.org_id!==pins.org_id||context.owner_user_id!==pins.owner_user_id||context.installation_id!==pins.installation_id||context.resource_binding_id!==pins.resource_binding_id
   ||typeof context.account_id!=='string'||!context.account_id||context.account_id.length>256||context.expires_at<=Date.now()||typeof context.recheck!=='function')return denied();
  context.signal?.throwIfAborted();await context.recheck();context.signal?.throwIfAborted();
 };
 const read=async(context:NativeEmailConnectionContext)=>{
  await check(context);const row=await ports.read(context);await check(context);
  if(!row||row.provider!=='imap_smtp'||!(context.lifecycle_inspect===true?['active','paused','disconnected','revoked']:['active','paused']).includes(row.state)||!Number.isSafeInteger(row.authority_revision)||row.authority_revision<1
   ||row.principal_digest!==row.credential.principal_digest||row.credential.org_id!==context.org_id||row.credential.owner_user_id!==context.owner_user_id||row.credential.account_id!==context.account_id)return denied();
  return row;
 };
 const custody=async(context:NativeEmailConnectionContext)=>new EmailImapCredentialCustody(await ports.keys(),{
  read:async scope=>{if(scope.org_id!==context.org_id||scope.owner_user_id!==context.owner_user_id||scope.account_id!==context.account_id)return denied();return (await read(context)).credential;},
  compareAndSwap:async()=>denied(),
 });
 const current=async(context:NativeEmailConnectionContext,purpose:'read'|'modify'|'send'='read'):Promise<EmailImapHostAccount>=>{
  if(context.lifecycle_inspect!==undefined&&(context.lifecycle_inspect!==true||purpose!=='read'))return denied();
  const caps=context.owner_capabilities;
  if(caps!==undefined&&(!Array.isArray(caps)||!caps.includes('read')||caps.length>3||new Set(caps).size!==caps.length||caps.some(cap=>!['read','modify','send'].includes(cap))))return denied();
  const row=await read(context),description=await(await custody(context)).describe(context);
  if(description.connection_revision!==row.credential.connection_revision||description.principal_digest!==row.principal_digest)return denied();
  const modify=!!pins.action_binding_id&&(caps===undefined||caps.includes('modify'));const send=description.has_smtp&&pins.action_key==='send_message'&&!!pins.action_binding_id&&(caps===undefined||caps.includes('send'));
  if(purpose==='send'&&!send||purpose==='modify'&&!modify)return denied();
  return {org_id:pins.org_id,owner_user_id:pins.owner_user_id,installation_id:pins.installation_id,account_id:context.account_id,provider:'imap_smtp',resource_binding_id:pins.resource_binding_id,
   authority_epoch:row.authority_revision,connection_revision:description.connection_revision,principal_digest:description.principal_digest,health:'connected',
   capabilities:['read',...(modify?['modify' as const]:[]),...(send?['send' as const]:[])],primary_address:description.primary_address,display_label:description.display_label,
   connection_target:pins.target_key,...(pins.action_binding_id?{action_binding_id:pins.action_binding_id}:{}),verified_sender_identities:send?[description.primary_address]:[]};
 };
 const imap=createEmailImapHost({current,ImapFlow:constructors.ImapFlow,custody:{withVerifiedProfile:async(context,expected,work)=>(await custody(context)).withVerifiedProfile(context,expected,work)}});
 const smtp=createEmailSmtpHost({current,createTransport:constructors.createTransport,custody:{withVerifiedSmtpProfile:async(context,expected,work)=>(await custody(context)).withVerifiedSmtpProfile(context,expected,work)}});
 return Object.freeze({...imap,...smtp,sentCopyMode:async(context:NativeEmailConnectionContext,expected:NativeEmailAccount)=>{
  const before=await current(context,'read');if(before.account_id!==expected.account_id||before.connection_revision!==expected.connection_revision||before.principal_digest!==expected.principal_digest||before.authority_epoch!==expected.authority_epoch)return denied();
  const description=await(await custody(context)).describe(context);await check(context);
  if(description.connection_revision!==expected.connection_revision||description.principal_digest!==expected.principal_digest)return denied();return description.sent_copy_mode;
 }});
}

export async function createRegisteredEmailImapHost(pins:AppConnectionPins,constructors:Constructors){
 registeredConstructors.set(registryKey(pins),constructors);
 const {db}=await import('./db.js');
 return createPinnedEmailImapHost(pins,constructors,{keys:async()=>(await(await import('./app-run-runtime.js')).getAppRunRuntime()).keys,
  read:async context=>{
   const [row]=await db.select({account:emailAccounts,credential:emailImapCredentials}).from(emailAccounts).innerJoin(emailImapCredentials,
    and(eq(emailAccounts.org_id,emailImapCredentials.org_id),eq(emailAccounts.owner_user_id,emailImapCredentials.owner_user_id),eq(emailAccounts.account_id,emailImapCredentials.account_id)))
    .where(and(eq(emailAccounts.org_id,context.org_id),eq(emailAccounts.owner_user_id,context.owner_user_id),eq(emailAccounts.account_id,context.account_id),eq(emailAccounts.resource_binding_id,pins.resource_binding_id))).limit(1);
   if(!row)return null;return {provider:row.account.provider,state:row.account.state,authority_revision:row.account.authority_revision,principal_digest:row.account.principal_digest,
    credential:{schema_version:'deft.email.imap.credentials.v1',org_id:row.credential.org_id,owner_user_id:row.credential.owner_user_id,account_id:row.credential.account_id,
     principal_digest:row.credential.principal_digest,connection_revision:row.credential.connection_revision,envelope:row.credential.envelope as EmailImapCredentialRecord['envelope']}};
  }});
}
