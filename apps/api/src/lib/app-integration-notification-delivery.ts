import {AppIntegrationSourceIdentitySchema} from '../../../../packages/app-kit/src/app-integration-source.js';
import {getAppIntegrationCaptureRuntime} from './app-integration-capture-service.js';import {db} from './db.js';
import {assertAppIntegrationNotificationDelivery} from './app-integration-notification-authority.js';import type {JobData} from '../workers/types.js';
import type {AppIntegrationNotificationCaller} from './app-integration-notification.js';
/** Existing push worker supplies its real retained queue lease. Contentless
 * payloads still require fresh source metadata and independent current opt-in. */
export async function appIntegrationNotificationDeliveryCurrent(item:{org_id:string;user_id:string;source_type:string;metadata:Record<string,unknown>},job?:JobData){
 if(item.source_type!=='app_integration_source')return true;
 try{if(!job||job.name!=='attention-delivery'||!job.lockToken) return false;const source=AppIntegrationSourceIdentitySchema.parse(item.metadata.app_integration_source),revision=item.metadata.policy_revision;if(typeof item.metadata.policy_id!=='string'||!Number.isSafeInteger(revision))return false;
  const caller:AppIntegrationNotificationCaller={org_id:item.org_id,user_id:item.user_id,kind:'notification_policy',principal_id:item.metadata.policy_id,notification_delivery:{job_id:job.id,lock_token:job.lockToken,policy_revision:revision as number}};
  const runtime=await getAppIntegrationCaptureRuntime(),snapshot=await runtime.metadataSource.read(caller,await runtime.resolveMetadata(caller,source,'notification_projection',job.signal),'notification_projection',job.signal);if(snapshot.resource.data.seen!==false||snapshot.resource.data.deleted===true)return false;
  await db.transaction(async tx=>{await assertAppIntegrationNotificationDelivery(tx,caller,source);await runtime.metadataSource.guard(tx,caller,snapshot,'notification_projection');});return true;
 }catch{return false;}
}
