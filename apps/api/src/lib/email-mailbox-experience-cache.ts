import { and, eq } from 'drizzle-orm';
import { appResourceBindings, emailAccounts } from '@deft/db/schema';
import type { db } from './db.js';
import type { ConnectedEmailMailboxAuthority } from './email-mailbox-connected-authority.js';
import { EmailMailboxError, type EmailActor, type EmailMailboxStore } from './email-mailbox-service.js';
import { NATIVE_EMAIL_CACHE_CURSOR_PREFIX, type NativeMailboxExperiencePage } from './app-experience-provider-browse.js';

type Database=Pick<typeof db,'select'>;
type Runtime={authority:Pick<ConnectedEmailMailboxAuthority,'inspect'>;store:Pick<EmailMailboxStore,'readPage'>};
const denied=():never=>{throw new EmailMailboxError('EMAIL_ACCESS_DENIED');};
const sourceKeys='account_id,authority_epoch,conversation_id,locator,logical_message_id,provider,schema_version';

/** Private read-only bridge. The browser sees the existing governed handle DTO,
 * while cache locators remain in the host's encrypted source handles. */
export class NativeEmailMailboxExperienceCache {
  constructor(private readonly database:Database,private readonly runtime:(actor:EmailActor)=>Promise<Runtime>,private readonly now=Date.now){}
  readonly read:NativeMailboxExperiencePage=async(input,signal)=>{
    signal.throwIfAborted();
    const nativeCursor=input.cursor?.startsWith(NATIVE_EMAIL_CACHE_CURSOR_PREFIX)??false;
    // A provider continuation must keep its original traversal and semantics.
    if(input.cursor&&!nativeCursor)return null;
    if(!['all','inbox','sent','archive','spam','trash'].includes(input.folder)){if(nativeCursor)return denied();return null;}
    const p=input.projection,c=input.caller;
    const live=()=>{signal.throwIfAborted();if(!Number.isFinite(c.access_expires_at)||c.access_expires_at!<=this.now()
      ||!Number.isFinite(p.expires_at)||p.expires_at<=this.now())return denied();};
    live();
    if(p.org_id!==c.org_id||p.owner_user_id!==c.user_id||p.web_session_id!==c.sid||p.purpose!=='browse_resource'
      ||!p.allowed_operations.includes('list_summary')||!Number.isInteger(input.limit)||input.limit<1||input.limit>10)return denied();
    const rows=await this.database.select({account:emailAccounts,binding:appResourceBindings}).from(emailAccounts)
      .innerJoin(appResourceBindings,and(eq(appResourceBindings.org_id,emailAccounts.org_id),eq(appResourceBindings.id,emailAccounts.resource_binding_id),eq(appResourceBindings.owner_user_id,emailAccounts.owner_user_id)))
      .where(and(eq(emailAccounts.org_id,c.org_id),eq(emailAccounts.owner_user_id,c.user_id),eq(emailAccounts.resource_binding_id,p.resource_binding_id),
        eq(appResourceBindings.app_installation_id,p.installation_id),eq(appResourceBindings.app_version_id,p.app_version_id),
        eq(appResourceBindings.grant_snapshot_id,p.grant_snapshot_id),eq(appResourceBindings.target_key,p.target_key),eq(appResourceBindings.resource_key,p.resource_key))).limit(2);
    live();
    if(!rows.length){if(nativeCursor)return denied();return null;}
    if(rows.length!==1)return denied();
    const {account,binding}=rows[0]!;
    if(account.org_id!==c.org_id||account.owner_user_id!==c.user_id||account.resource_binding_id!==p.resource_binding_id
      ||binding.org_id!==c.org_id||binding.owner_user_id!==c.user_id||binding.id!==p.resource_binding_id
      ||binding.app_installation_id!==p.installation_id||binding.app_version_id!==p.app_version_id||binding.grant_snapshot_id!==p.grant_snapshot_id
      ||binding.target_key!==p.target_key||binding.resource_key!==p.resource_key||!account.account_id
      ||!account.principal_digest||!/^[a-f0-9]{64}$/.test(account.principal_digest))return denied();
    const actor:EmailActor=Object.freeze({user_id:c.user_id,web_session_id:c.sid,access_expires_at:c.access_expires_at!});
    const scope=Object.freeze({org_id:c.org_id,owner_user_id:c.user_id,account_id:account.account_id});
    const {authority,store}=await this.runtime(actor);
    const before=await authority.inspect(actor,scope,'human_read',undefined,signal);
    const assertAccount=(value:typeof before)=>{
      live();const a=value.account,cap=value.capability;
      if(a.account_id!==scope.account_id||a.resource_binding_id!==p.resource_binding_id||a.provider!==account.provider
        ||a.principal_digest!==account.principal_digest||a.health!=='connected'||!a.capabilities.includes('read')
        ||!Number.isSafeInteger(a.authority_epoch)||a.authority_epoch<1
        ||cap.scope.org_id!==scope.org_id||cap.scope.owner_user_id!==scope.owner_user_id||cap.scope.account_id!==scope.account_id
        ||cap.resource_binding_id!==p.resource_binding_id||!Number.isFinite(cap.expires_at)||cap.expires_at<=this.now())return denied();
    };
    assertAccount(before);
    const cursor=nativeCursor?input.cursor!.slice(NATIVE_EMAIL_CACHE_CURSOR_PREFIX.length):null;
    if(nativeCursor&&!cursor)return denied();
    const page=await store.readPage(scope,{folder:input.folder,cursor,limit:input.limit},signal);
    const recheck=async(requireFresh=true)=>{
      const after=await authority.inspect(actor,scope,'human_read',undefined,signal);
      assertAccount(after);
      if(after.capability.authority_version!==before.capability.authority_version
        ||after.account.authority_epoch!==before.account.authority_epoch||after.account.connection_revision!==before.account.connection_revision)return denied();
      if(requireFresh&&page.fresh_until!==null&&Date.parse(page.fresh_until)<=this.now())return denied();
    };
    if(page.account_id!==scope.account_id||page.items.length>input.limit||!Number.isSafeInteger(page.checkpoint_revision)||page.checkpoint_revision<0)return denied();
    const fresh=page.coverage==='complete'&&page.fresh_until!==null&&Date.parse(page.fresh_until)>this.now()
      &&page.observed_at!==null&&Number.isFinite(Date.parse(page.observed_at))&&Date.parse(page.observed_at)<=this.now();
    if(!fresh){if(nativeCursor)return denied();await recheck(false);return null;}
    const seen=new Set<string>();
    const items=page.items.map(message=>{
      const source=message.provider_source,data=message.data;
      if(message.account_id!==scope.account_id||!/^mail_[a-f0-9]{64}$/.test(message.logical_message_id)||seen.has(message.logical_message_id)
        ||Object.keys(source).sort().join(',')!==sourceKeys||source.schema_version!=='deft.email_provider_source.v1'
        ||source.account_id!==scope.account_id||source.provider!==account.provider||source.logical_message_id!==message.logical_message_id
        ||data.account_id!==scope.account_id||data.provider!==account.provider||data.logical_message_id!==message.logical_message_id
        ||data.conversation_id!==source.conversation_id||typeof source.conversation_id!=='string'||!/^conversation_[a-f0-9]{64}$/.test(source.conversation_id)
        ||!Number.isSafeInteger(source.authority_epoch)||Number(source.authority_epoch)<1||!source.locator||typeof source.locator!=='object'||Array.isArray(source.locator))return denied();
      seen.add(message.logical_message_id);
      return {revision:message.revision,label:String(data.label??data.subject??'').slice(0,200),data:data as Record<string,string|number|boolean>,
        provider_source:{...source,authority_epoch:before.account.authority_epoch}};
    });
    live();
    return {page:{schema_version:'deft.app_provider_browse_page.v1',items,next_cursor:page.next_cursor===null?null:NATIVE_EMAIL_CACHE_CURSOR_PREFIX+page.next_cursor,
      complete:page.next_cursor===null,observed_at:page.observed_at!,count:{returned:items.length,exact_total:null},failure_count:0},recheck};
  };
}

/** Feature-off default; route wiring can call this without importing DB/runtime
 * or touching custody when the native cache feature is disabled. */
export function getNativeEmailMailboxExperiencePage():NativeMailboxExperiencePage|undefined{
  if(process.env.DEFT_NATIVE_EMAIL_ENABLED!=='true')return undefined;
  return async(input,signal)=>{
    const [{db},{getEmailMailboxRuntime}]=await Promise.all([import('./db.js'),import('./email-mailbox-runtime.js')]);
    return new NativeEmailMailboxExperienceCache(db,getEmailMailboxRuntime).read(input,signal);
  };
}
