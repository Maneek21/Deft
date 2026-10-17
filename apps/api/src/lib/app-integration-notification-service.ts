import {randomUUID} from 'node:crypto';import {and,eq,sql} from 'drizzle-orm';import {z} from 'zod';
import {db} from './db.js';import {enqueueOrRearmFailed,QUEUE_NAMES} from './queues.js';import {attentionItems} from '@deft/db/schema';
import {appIntegrationNotificationPolicies as policies} from '../../../../packages/db/src/app-integration-notification-schema.js';
import {AppIntegrationSourceIdentitySchema,type AppIntegrationSourceIdentity} from '../../../../packages/app-kit/src/app-integration-source.js';
import {appIntegrationSourceDigest,type AppIntegrationSourceCaller} from './app-integration-source.js';
import {getAppIntegrationDataGateway} from './app-integration-runtime-gateway.js';
import {getAppIntegrationCaptureRuntime} from './app-integration-capture-service.js';
import {assertAppIntegrationNotificationDelivery,APP_INTEGRATION_NOTIFICATION_JOB} from './app-integration-notification-authority.js';
import {createAppIntegrationNotifications,type AppIntegrationNotificationCaller} from './app-integration-notification.js';
import {upsertAttentionItem} from './attention.js';import type {AppRunTransaction as Tx} from './app-run-repository.js';import type {JobData} from '../workers/types.js';
const Account=z.strictObject({installation_id:z.uuid(),account_ref:z.string().min(1).max(512),store_key:z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u)});
export const AppIntegrationNotificationSettingSchema=Account.extend({enabled:z.boolean(),expected_revision:z.number().int().min(0).max(2147483646)});
const deny=()=>Error('APP_INTEGRATION_NOTIFICATION_CHANGED_OR_DENIED');
const predicate=(caller:AppIntegrationSourceCaller,account:z.infer<typeof Account>)=>and(eq(policies.org_id,caller.org_id),eq(policies.owner_user_id,caller.user_id),eq(policies.installation_id,account.installation_id),eq(policies.account_ref,account.account_ref),eq(policies.store_key,account.store_key));
export function createAppIntegrationNotificationSettings(input:{transaction<T>(fn:(tx:Tx)=>Promise<T>):Promise<T>;current(caller:AppIntegrationSourceCaller,account:z.infer<typeof Account>,tx?:Tx):Promise<{identity:string;expires_at:number}>;clock?:()=>number}){
 const now=input.clock??Date.now;const guard=async(caller:AppIntegrationSourceCaller,account:z.infer<typeof Account>,tx:Tx,expected?:string)=>{if(caller.kind!=='human')throw deny();const current=await input.current(caller,account,tx);if(!current.identity||current.expires_at<=now()||expected&&expected!==current.identity)throw deny();return current;};
 return {async read(caller:AppIntegrationSourceCaller,raw:unknown){const account=Account.parse(raw);return input.transaction(async tx=>{await guard(caller,account,tx);const [row]=await tx.select().from(policies).where(predicate(caller,account)).limit(1).for('share');return {enabled:row?.enabled??false,revision:row?.revision??0};});},
 async save(caller:AppIntegrationSourceCaller,raw:unknown){const {enabled,expected_revision,...account}=AppIntegrationNotificationSettingSchema.parse(raw);return input.transaction(async tx=>{
  const before=await guard(caller,account,tx);await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${appIntegrationSourceDigest([caller.org_id,caller.user_id,account])},0))`);
  const [old]=await tx.select().from(policies).where(predicate(caller,account)).limit(1).for('update');if((old?.revision??0)!==expected_revision)throw deny();
  const at=new Date(now()),revision=expected_revision+1;const [row]=old?await tx.update(policies).set({enabled,revision,updated_at:at}).where(predicate(caller,account)).returning():await tx.insert(policies).values({id:randomUUID(),org_id:caller.org_id,owner_user_id:caller.user_id,...account,enabled,revision,created_at:at,updated_at:at}).returning();
  await guard(caller,account,tx,before.identity);if(!row)throw deny();return {enabled:row.enabled,revision:row.revision};
 });}};
}
/** Called from the committed sync publication transaction. Only exact original
 * UUID/digest metadata enters the existing queue; there is no mailbox body. */
export async function enqueueAppIntegrationNotifications(tx:Tx,owner:{org_id:string;user_id:string},raw:AppIntegrationSourceIdentity){
 const source=AppIntegrationSourceIdentitySchema.parse(raw);const rows=await tx.select().from(policies).where(predicate({org_id:owner.org_id,user_id:owner.user_id,kind:'human',principal_id:owner.user_id},source)).for('share');
 for(const policy of rows.filter(row=>row.enabled))await enqueueOrRearmFailed(QUEUE_NAMES.SCHEDULED_JOBS,APP_INTEGRATION_NOTIFICATION_JOB,{policy_id:policy.id,policy_revision:policy.revision,source},{orgId:policy.org_id,dedupeKey:appIntegrationSourceDigest([APP_INTEGRATION_NOTIFICATION_JOB,policy.id,policy.revision,source]),maxAttempts:3,executor:tx});
}
export async function handleAppIntegrationNotification(job:JobData){
 if(job.name!==APP_INTEGRATION_NOTIFICATION_JOB||!job.lockToken)throw deny();const source=AppIntegrationSourceIdentitySchema.parse(job.data.source);
 const [policy]=await db.select().from(policies).where(eq(policies.id,String(job.data.policy_id))).limit(1);if(!policy?.enabled||policy.revision!==job.data.policy_revision)return;
 const caller:AppIntegrationNotificationCaller={org_id:policy.org_id,user_id:policy.owner_user_id,kind:'notification_policy',principal_id:policy.id,notification_delivery:{job_id:job.id,lock_token:job.lockToken,policy_revision:policy.revision}};
 const shared=await getAppIntegrationCaptureRuntime(),effects=new Map<string,()=>Promise<void>>();
 const service=createAppIntegrationNotifications<Tx>({transaction:fn=>db.transaction(fn),policy:async(tx,c,s)=>{const current=await assertAppIntegrationNotificationDelivery(tx,c,s);return current.policy;},
  source:{read:async(c,s,signal)=>shared.metadataSource.read(c,await shared.resolveMetadata(c,s,'notification_projection',signal),'notification_projection',signal),guard:(tx,c,s)=>shared.metadataSource.guard(tx,c,s,'notification_projection')},
  eligible:snapshot=>snapshot.resource.data.seen===false&&snapshot.resource.data.deleted!==true,
  project:async(tx,draft)=>{let after:(()=>Promise<void>)|undefined;const item=await upsertAttentionItem(draft,{executor:tx,deliver:true,afterCommit:effect=>{after=effect;}});if(!item)throw deny();const href='/apps/source/attention/'+item.id;await tx.update(attentionItems).set({link:href}).where(and(eq(attentionItems.id,item.id),eq(attentionItems.org_id,draft.orgId),eq(attentionItems.user_id,draft.userId)));item.link=href;if(after)effects.set(item.id,after);return {id:item.id,created:!!after};},
  afterCommit:async id=>{const fresh=await shared.metadataSource.read(caller,await shared.resolveMetadata(caller,source,'notification_projection',job.signal),'notification_projection',job.signal);await db.transaction(async tx=>{await assertAppIntegrationNotificationDelivery(tx,caller,source);await shared.metadataSource.guard(tx,caller,fresh,'notification_projection');});await effects.get(id)?.();},
 });await service.project(caller,source,job.signal);
}
export function getAppIntegrationNotificationSettings(){return createAppIntegrationNotificationSettings({transaction:fn=>db.transaction(fn),current:(caller,account,tx)=>getAppIntegrationDataGateway().currentAccount(caller,account,'read',tx)});}
