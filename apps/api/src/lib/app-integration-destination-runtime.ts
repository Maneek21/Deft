import {db} from './db.js';
import {createAppIntegrationDestination} from './app-integration-destination.js';
import {appIntegrationDestinationPostgres} from './app-integration-destination-postgres.js';
import {appIntegrationTaskAdapter,afterAppIntegrationTaskCommit} from './app-integration-task.js';
import {getAppIntegrationCaptureRuntime} from './app-integration-capture-service.js';
import {appIntegrationDestinationReceipts as receipts} from '../../../../packages/db/src/app-integration-destination-schema.js';
import {AppIntegrationSourceIdentitySchema} from '../../../../packages/app-kit/src/app-integration-source.js';
import {and,eq} from 'drizzle-orm';
import {tasks,attentionItems} from '@deft/db/schema';
import {appIntegrationNotificationPolicies as notificationPolicies} from '../../../../packages/db/src/app-integration-notification-schema.js';
import type {AppRunTransaction} from './app-run-repository.js';
import type {AppIntegrationSourceCaller} from './app-integration-source.js';
import {nativeChatForwardBroadcast} from './native-chat-forward.js';
import {getIO} from '../socket.js';
let singleton:ReturnType<typeof createRuntime>|undefined;
async function createRuntime(){const shared=await getAppIntegrationCaptureRuntime(),service=createAppIntegrationDestination<AppRunTransaction>({
 transaction:fn=>db.transaction(fn),source:{resolve:(caller,identity)=>shared.resolve(caller,identity,'transfer'),read:shared.source.read,guard:shared.source.guard},
 ...appIntegrationDestinationPostgres({task:appIntegrationTaskAdapter}),
 afterCommit:async result=>{if(result.destination_kind==='chat'){const value=await nativeChatForwardBroadcast(db,result.destination_id);if(value)getIO()?.to('space:'+value.space_id).emit('message:new',value);}
  if(result.destination_kind==='task'){const [row]=await db.select().from(tasks).where(eq(tasks.id,result.destination_id));if(row)await afterAppIntegrationTaskCommit(row);}},
});return {...service,async openAttention(caller:AppIntegrationSourceCaller,id:string){
 if(caller.kind!=='human')throw Error('APP_INTEGRATION_DESTINATION_CHANGED_OR_DENIED');
 const predicate=and(eq(attentionItems.org_id,caller.org_id),eq(attentionItems.user_id,caller.user_id),eq(attentionItems.id,id));
 const [row]=await db.select().from(attentionItems).where(predicate).limit(1);
 if(!row||row.source_type!=='app_integration_source'||row.resolved_at||row.state==='resolved')throw Error('APP_INTEGRATION_DESTINATION_CHANGED_OR_DENIED');
 const identity=AppIntegrationSourceIdentitySchema.parse(row.metadata.app_integration_source);
 const target=await shared.resolve(caller,identity,'read'),snapshot=await shared.source.read(caller,target,'read');
 await db.transaction(async tx=>{const [current]=await tx.select().from(attentionItems).where(predicate).for('share');const [policy]=await tx.select().from(notificationPolicies).where(and(eq(notificationPolicies.id,String(row.metadata.policy_id)),eq(notificationPolicies.org_id,caller.org_id),eq(notificationPolicies.owner_user_id,caller.user_id),eq(notificationPolicies.installation_id,identity.installation_id),eq(notificationPolicies.account_ref,identity.account_ref),eq(notificationPolicies.store_key,identity.store_key),eq(notificationPolicies.enabled,true))).for('share');if(!policy||policy.revision!==row.metadata.policy_revision||!current||current.version!==row.version||current.resolved_at||current.source_type!==row.source_type)throw Error('APP_INTEGRATION_DESTINATION_CHANGED_OR_DENIED');await shared.source.guard(tx,caller,snapshot,'read');});
 return shared.openIdentity(caller,identity);
 },async openSource(caller:AppIntegrationSourceCaller,id:string){const [row]=await db.select().from(receipts).where(and(eq(receipts.org_id,caller.org_id),eq(receipts.owner_user_id,caller.user_id),eq(receipts.request_id,id))).limit(1);if(!row)throw Error('APP_INTEGRATION_DESTINATION_CHANGED_OR_DENIED');if(row.destination.kind==='calendar'){await(await import('./app-integration-calendar.js')).getAppIntegrationCalendar().then(calendar=>calendar.status(caller,id));return shared.openIdentity(caller,AppIntegrationSourceIdentitySchema.parse(row.source));}const checked=await service.statusWithSource(caller,id);return shared.openSnapshot(caller,checked.snapshot);}};}
export function getAppIntegrationDestinationRuntime(){return singleton??=createRuntime();}
