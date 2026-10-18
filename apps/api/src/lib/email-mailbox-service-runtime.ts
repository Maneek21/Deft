import {getEmailMailboxAuthority} from './email-account-authority-router.js';
import { syncEmailMailboxPage, type EmailScope, type EmailCapability, type EmailMailboxStore, type EmailMailboxProvider } from './email-mailbox-service.js';
import { inspectEmailMailboxConnection } from './email-mailbox-connected-authority.js';
import type { RegisteredEmailMailboxProvider } from './email-mailbox-provider.js';
import type { NativeEmailSyncJobScope, NativeEmailSyncRunLease } from './email-mailbox-job.js';

type CurrentSql=(scope:EmailScope,lease:NativeEmailSyncRunLease,transaction?:unknown,signal?:AbortSignal)=>Promise<EmailCapability>;
type Components={store:EmailMailboxStore;provider:EmailMailboxProvider & Pick<RegisteredEmailMailboxProvider,'assertConnected'>};

/** A queue delivery uses account consent and its actual lease. Human logout is
 * unrelated; revocation, disconnect and a lost lease still stop every page. */
export function createEmailMailboxServicePageRunner(dependencies:{currentSql:CurrentSql;
  components:(current:(scope:EmailScope,transaction?:unknown,signal?:AbortSignal)=>Promise<EmailCapability>)=>Promise<Components>;now?:()=>number}) {
  return async(input:NativeEmailSyncJobScope,lease:NativeEmailSyncRunLease,signal?:AbortSignal)=>{
    const scope=Object.freeze({org_id:input.org_id,owner_user_id:input.owner_user_id,account_id:input.account_id});
    const delivery=Object.freeze({...lease});
    const currentSql=(account:EmailScope,transaction?:unknown,abort?:AbortSignal)=>dependencies.currentSql(account,delivery,transaction,abort);
    const {store,provider}=await dependencies.components(currentSql);
    const current=async(transaction?:unknown,abort?:AbortSignal)=>(await inspectEmailMailboxConnection(scope,
      ()=>currentSql(scope,transaction,abort),provider,abort,dependencies.now)).capability;
    await current(undefined,signal);
    const checkpoint=await store.readCheckpoint(scope,signal);
    await current(undefined,signal);
    return syncEmailMailboxPage(scope,{expected_checkpoint_revision:checkpoint.revision,cursor:checkpoint.cursor,
      page_id:`sync:${delivery.job_id}:${checkpoint.revision}`},{current,store,provider,now:dependencies.now},signal);
  };
}

export async function runNativeEmailSyncPage(scope:NativeEmailSyncJobScope,lease:NativeEmailSyncRunLease,signal?:AbortSignal){
  const [{db},{PostgresEmailMailboxAuthority},{getEmailMailboxComponents}]=await Promise.all([
    import('./db.js'),import('./email-mailbox-authority.js'),import('./email-mailbox-runtime.js')]);
  const base=await getEmailMailboxAuthority(db);
  return createEmailMailboxServicePageRunner({currentSql:(account,delivery,tx,abort)=>base.currentService(account,delivery,tx,abort),
    components:getEmailMailboxComponents})(scope,lease,signal);
}
