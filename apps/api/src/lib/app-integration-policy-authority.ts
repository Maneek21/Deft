import type {AppIntegrationSourceCaller} from './app-integration-source.js';
import type {AppIntegrationSourcePurpose} from '../../../../packages/app-kit/src/app-integration-source.js';
import type {AppRunTransaction} from './app-run-repository.js';
export type AppIntegrationPolicyAuthority=(caller:AppIntegrationSourceCaller,target:{installation_id:string;account_ref:string;store_key:string;resource_binding_id:string},tx?:AppRunTransaction)=>Promise<{identity:string;expires_at:number}>;
/** Policy kinds are separate authority sources. Missing notification admission
 * stays default-off; capture grants and browser/tool grants cannot substitute. */
export async function currentIntegrationPolicyAuthority(options:{policyAuthority:AppIntegrationPolicyAuthority;notificationAuthority?:AppIntegrationPolicyAuthority},caller:AppIntegrationSourceCaller,target:Parameters<AppIntegrationPolicyAuthority>[1],purpose:AppIntegrationSourcePurpose,tx?:AppRunTransaction){
 const notification=caller.kind==='notification_policy',capture=caller.kind==='capture_policy';
 if(notification?purpose!=='notification_projection'||!caller.notification_delivery||!!caller.capture_delivery:!capture||purpose!=='knowledge_capture'||!caller.capture_delivery||!!caller.notification_delivery)throw Error('APP_INTEGRATION_POLICY_DENIED');
 const authority=notification?options.notificationAuthority:options.policyAuthority;
 if(!authority)throw Error('APP_INTEGRATION_POLICY_DISABLED');
 const result=await authority(caller,target,tx);
 if(!result.identity||!Number.isFinite(result.expires_at)||result.expires_at<=Date.now())throw Error('APP_INTEGRATION_POLICY_DENIED');
 return result;
}
