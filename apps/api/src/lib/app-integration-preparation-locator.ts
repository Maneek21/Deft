import {z} from 'zod';import {and,eq} from 'drizzle-orm';import {appVersions} from '@deft/db/schema';import {db} from './db.js';
import {readIntegrationTool} from './app-integration-tool-store.js';import {currentOriginalTool} from './app-integration-tool-runtime.js';
import {appExperienceService,verifiedExperienceBundle,type ExperienceCaller} from './app-experience-service.js';
/** The URL carries only the original invocation UUID. The real opening human
 * cannot replace its installation, action, source or immutable prepared input. */
export async function locateAppIntegrationPreparation(caller:ExperienceCaller,raw:unknown){
 const id=z.uuid().parse(raw),row=await readIntegrationTool(id),deny=()=>Error('APP_INTEGRATION_PREPARED_AUTHORITY_STALE');
 if(!row?.prepared||row.metadata.caller.org_id!==caller.org_id||row.metadata.caller.user_id!==caller.user_id)throw deny();
 const {account}=await currentOriginalTool(row),m=row.metadata;const [version]=await db.select().from(appVersions).where(and(eq(appVersions.org_id,caller.org_id),eq(appVersions.id,m.envelope.scope.app_version_id),eq(appVersions.installation_id,m.target.installation_id),eq(appVersions.state,'active'))).limit(1);if(!version)throw deny();
 const manifest=version.manifest as {record_stores?:{key:string;source_projection?:{navigation_entry_key?:string}}[]},key=manifest.record_stores?.find(store=>store.key===m.target.store_key)?.source_projection?.navigation_entry_key;if(!key)throw deny();
 const {bundle}=await verifiedExperienceBundle(version,key);if(!bundle.action_keys.includes(row.prepared.action_key)||!('record_store_keys' in bundle)||!bundle.record_store_keys?.includes(m.target.store_key))throw deny();
 const session=await appExperienceService.create(caller,m.target.installation_id,key,{resource_target_key:account.scope.target_key});
 if(session.pin.app_version_id!==m.envelope.scope.app_version_id||session.pin.grant_snapshot_id!==m.envelope.scope.grant_snapshot_id||session.resource_target_key!==m.envelope.scope.target_key)throw deny();
 await currentOriginalTool(row);return {schema_version:'deft.app_integration_preparation_locator.v1',request_id:id,session_id:session.pin.session_id,app_name:session.app_name,action_key:row.prepared.action_key,expires_at:session.expires_at};
}
