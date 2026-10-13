import {sql} from 'drizzle-orm';
import {createAppIntegrationNotificationPolicyAuthority} from './app-integration-notification-authority.js';
import {db} from './db.js';
import {createPostgresAppIntegrationDataGateway,type AppIntegrationPolicyAuthority} from './app-integration-data-postgres.js';
import {createAppIntegrationCapturePolicyAuthority} from './app-integration-capture-authority.js';
import {AppDataRuntimeAuthorityRequestSchema} from '@deft/app-kit';
let gateway:ReturnType<typeof createPostgresAppIntegrationDataGateway>|undefined;
/** One concrete journal/dispatcher shared by tools, source reads and capture.
 * Policy delivery authority is reconstructed from retained Host metadata. */
export function createHostAppIntegrationDataGateway(notificationAuthority?:AppIntegrationPolicyAuthority){
 return createPostgresAppIntegrationDataGateway({policyAuthority:createAppIntegrationCapturePolicyAuthority({transaction:work=>db.transaction(work)}),...(notificationAuthority?{notificationAuthority}:{})});
}
export function getAppIntegrationDataGateway(){
 // Root/lane3 must mount the concrete independent notification policy reader.
 // No reader here means notification execution remains default-off.
 return gateway??=createHostAppIntegrationDataGateway(createAppIntegrationNotificationPolicyAuthority({transaction:work=>db.transaction(work)}));
}
/** Called only by the existing authenticated Runtime authority endpoint.
 * Absence leaves its ordinary browser journal path unchanged. */
export async function maybeAppIntegrationDataRuntimeAuthority(raw:unknown,authorization:string|undefined){
 const input=AppDataRuntimeAuthorityRequestSchema.parse(raw);
 const result=await db.execute(sql`SELECT request_id,context->>'kind' AS kind FROM app_integration_data_invocations WHERE request_id=${input.request_id}`);
 if(result.rows.length===0)return null;
 if(result.rows[0]?.kind==='tool')return (await import('./app-integration-tool-prepared.js')).integrationPreparedReadAuthority(input,authorization);
 return getAppIntegrationDataGateway().callback(input,authorization);
}
