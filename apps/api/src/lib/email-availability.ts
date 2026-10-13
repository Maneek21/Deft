import type {AppConnectionEntry} from './app-connection-registry.js';
import type {AppConnectionRegistry} from './app-connection-registry.js';
import {z} from 'zod';
import type {db} from './db.js';
import {loadLiveAttachmentSyncBindingAuthority} from './app-attachment-sync-authority.js';
import type {EmailActor} from './email-mailbox-service.js';

const validId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export type EmailAvailability=Readonly<{available:boolean;legacy_installation_ids:readonly string[]}>;
export type EmailAvailabilityRegistry=Pick<AppConnectionRegistry,'retainedOwnerEntriesForOwner'>;
export type EmailAvailabilityGraphCheck=(entry:AppConnectionEntry)=>Promise<boolean>;

/** Project only actual registered native-mailbox adapter mappings whose exact
 * installation/binding/version/grant/target/resource tuple is still reviewed.
 * Names and account totals never select which navigation item is replaced. */
export async function currentLegacyEmailInstallationIds(input:{org_id:string;owner_user_id:string;registry:EmailAvailabilityRegistry;live:EmailAvailabilityGraphCheck}){
 if(!validId(input.org_id)||!validId(input.owner_user_id))return Object.freeze([] as string[]);
 const entries=input.registry.retainedOwnerEntriesForOwner({org_id:input.org_id,owner_user_id:input.owner_user_id});
 if(entries.length>32)return Object.freeze([] as string[]);
 const found=new Set<string>();
 for(const entry of entries){
  const pins=entry.pins;
  if(pins.org_id!==input.org_id||pins.owner_user_id!==input.owner_user_id||!validId(pins.installation_id)
    ||typeof entry.adapter.nativeEmailAccount!=='function'||typeof entry.adapter.nativeEmailPage!=='function')continue;
  try{if(await input.live(entry))found.add(pins.installation_id);}catch{/* one stale registry edge doesn't hide native navigation */}
 }
 return Object.freeze([...found].sort().slice(0,50));
}

/** Production live-graph check uses the existing reviewed attachment-binding
 * loader. Adapter config pins alone cannot make an installation current. */
export async function isLiveReviewedEmailBinding(database:Pick<typeof db,'transaction'>,entry:AppConnectionEntry){
 const pins=entry.pins;
 return database.transaction(async tx=>{
  const live=await loadLiveAttachmentSyncBindingAuthority(tx,{org_id:pins.org_id,resource_binding_id:pins.resource_binding_id,clock:()=>new Date()});
  if(!live)return false;const b=live.binding;
  return b.id===pins.resource_binding_id&&b.org_id===pins.org_id&&b.owner_user_id===pins.owner_user_id
   &&b.app_installation_id===pins.installation_id&&b.app_version_id===pins.app_version_id&&b.grant_snapshot_id===pins.grant_snapshot_id
   &&b.target_key===pins.target_key&&b.resource_key===pins.resource_key;
 });
}
export async function getCurrentLegacyEmailInstallationIds(orgId:string,ownerUserId:string){
 const [{db},{getAppConnectionRegistry}]=await Promise.all([import('./db.js'),import('./app-connection-registry.js')]);
 const registry=await getAppConnectionRegistry();
 return currentLegacyEmailInstallationIds({org_id:orgId,owner_user_id:ownerUserId,registry,
  live:entry=>isLiveReviewedEmailBinding(db,entry)});
}

export type EmailConnectionTarget=Readonly<{provider:'gmail'|'microsoft';primary_address:string;display_label:string;
 native_email:Readonly<{account_id:string;resource_binding_id:string;state:'available'|'active'|'unavailable'}>}>;
export type EmailConnectionTargetPage=Readonly<{targets:readonly EmailConnectionTarget[];has_more:boolean;unavailable_count:number}>;
type ConnectionStatusReader=(actor:EmailActor,entry:AppConnectionEntry,signal?:AbortSignal)=>Promise<unknown>;
type ExistingAccountReader=(scope:{org_id:string;owner_user_id:string;account_id:string;resource_binding_id:string})=>Promise<'active'|'other'|'absent'>;
const emailAddress=(v:unknown):v is string=>typeof v==='string'&&v.length<=320&&z.string().email().safeParse(v).success;
/** Bounded owner settings catalog via the existing app-owner connection status
 * bridge. That bridge revalidates the actual live binding before returning any
 * provider-derived identity. */
export async function listEmailConnectionTargets(actor:EmailActor,orgId:string,registry:EmailAvailabilityRegistry,
 readStatus:ConnectionStatusReader,existing:ExistingAccountReader,signal?:AbortSignal):Promise<EmailConnectionTargetPage>{
 const entries=registry.retainedOwnerEntriesForOwner({org_id:orgId,owner_user_id:actor.user_id});
 const candidates=entries.filter(entry=>typeof entry.adapter.nativeEmailAccount==='function'&&typeof entry.adapter.nativeEmailPage==='function')
  .sort((a,b)=>a.pins.installation_id.localeCompare(b.pins.installation_id)||a.pins.target_key.localeCompare(b.pins.target_key));
 if(candidates.length>50)throw new Error('EMAIL_CONNECTION_TARGETS_UNAVAILABLE');
 const targets:EmailConnectionTarget[]=[],seen=new Set<string>();let unavailable_count=0,next=0;
 await Promise.all(Array.from({length:Math.min(2,candidates.length)},async()=>{
  while(next<candidates.length){const entry=candidates[next++]!;signal?.throwIfAborted();
   try{
    const raw=await readStatus(actor,entry,signal);signal?.throwIfAborted();
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error();const result=raw as Record<string,any>,account=result.account as Record<string,any>|undefined,native=result.native_email as Record<string,any>|undefined;
    if(result.state!=='connected'||account?.health!=='connected'||!['gmail','microsoft'].includes(account.provider)||!emailAddress(account.primary_address)
      ||typeof account.display_label!=='string'||account.display_label.length>256||/[\u0000-\u001f\u007f-\u009f]/u.test(account.display_label)
      ||!native||native.account_id!==account.account_id||native.resource_binding_id!==entry.pins.resource_binding_id
      ||!['available','active','unavailable'].includes(native.state))throw Error();
    const key=`${native.account_id}\0${native.resource_binding_id}`;if(seen.has(key))continue;seen.add(key);
    const row=await existing({org_id:orgId,owner_user_id:actor.user_id,account_id:native.account_id,resource_binding_id:native.resource_binding_id});signal?.throwIfAborted();
    const state=native.state==='unavailable'?'unavailable':row==='active'?'active':row==='other'?'unavailable':'available';
    targets.push(Object.freeze({provider:account.provider,primary_address:account.primary_address,display_label:account.display_label,
      native_email:Object.freeze({account_id:native.account_id,resource_binding_id:native.resource_binding_id,state})}));
   }catch{signal?.throwIfAborted();unavailable_count++;}
  }
 }));
 targets.sort((a,b)=>a.provider.localeCompare(b.provider)||a.primary_address.localeCompare(b.primary_address)||a.native_email.account_id.localeCompare(b.native_email.account_id));
 return Object.freeze({targets:Object.freeze(targets),has_more:false,unavailable_count});
}

export async function getEmailConnectionTargets(actor:EmailActor,orgId:string,signal?:AbortSignal):Promise<EmailConnectionTargetPage>{
 const [{db},{getAppConnectionRegistry},{AppConnectionService},{AppExperienceExposureService},{getAppRunRuntime},{getEmailMailboxRuntime}]=await Promise.all([
  import('./db.js'),import('./app-connection-registry.js'),import('./app-connection-service.js'),import('./app-experience-exposure.js'),import('./app-run-runtime.js'),import('./email-mailbox-runtime.js')]);
 const registry=await getAppConnectionRegistry(),caller={org_id:orgId,user_id:actor.user_id,sid:actor.web_session_id,access_expires_at:actor.access_expires_at};
 const connections=new AppConnectionService(registry,new AppExperienceExposureService((await getAppRunRuntime()).keys));
 const {authority}=await getEmailMailboxRuntime(actor);
 return listEmailConnectionTargets(actor,orgId,registry,async(_actor,entry,activeSignal)=>connections.invokeRetained(caller,
  {installation_id:entry.pins.installation_id,target_key:entry.pins.target_key},{},undefined,activeSignal),async scope=>{
  const {and,eq}=await import('drizzle-orm');const {emailAccounts}=await import('@deft/db/schema');
  const rows=await db.select({state:emailAccounts.state,resource_binding_id:emailAccounts.resource_binding_id,provider:emailAccounts.provider,
    principal_digest:emailAccounts.principal_digest}).from(emailAccounts)
   .where(and(eq(emailAccounts.org_id,scope.org_id),eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,scope.account_id))).limit(2);
  if(rows.length>1)return'other';if(!rows[0])return'absent';const row=rows[0];
  if(row.resource_binding_id!==scope.resource_binding_id||row.state!=='active'||!row.principal_digest)return'other';
  try{
   const {account,capability}=await authority.inspect(actor,scope,'human_read',undefined,signal);
   if(capability.resource_binding_id!==row.resource_binding_id||account.account_id!==scope.account_id
     ||account.resource_binding_id!==row.resource_binding_id||account.provider!==row.provider
     ||account.principal_digest!==row.principal_digest||account.health!=='connected'||!account.capabilities.includes('read'))return'other';
   return'active';
  }catch{return'other';}
 },signal);
}
