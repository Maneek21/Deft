import {appDataDigest,currentAppDataAuthority,appDataRetainedGuard} from './app-data-authority.js';
import {createAppIntegrationRecipientAssistance} from './app-integration-recipients.js';
import {GovernedAppIntegrationContacts} from './app-integration-contacts.js';
import {listModuleInstallations,queryModuleRecords} from './module-service.js';
import {resourceSyncWebAuthority} from './app-resource-sync-web-authority.js';
import {invokeAppIntegrationRecentRecipients} from './app-integration-recipient-transport.js';
import type {ExperienceCaller} from './app-experience-service.js';
/** The current browser SID is retained at each read boundary. Module grants and
 * the signed account read remain separate; neither authorizes the other. */
export async function appIntegrationRecipientService(authorization:string|undefined,session:string){
 const auth=await resourceSyncWebAuthority(authorization),caller:ExperienceCaller={org_id:auth.actor.org_id,user_id:auth.actor.actor_id,sid:auth.web_session.sid,access_expires_at:auth.web_session.expires_at};
 const contacts=new GovernedAppIntegrationContacts({list:actor=>listModuleInstallations(actor),query:(actor,input)=>queryModuleRecords(actor,input)});
 const current=async()=>{await resourceSyncWebAuthority(authorization,caller);const value=await currentAppDataAuthority(caller,session,'drafts',appDataRetainedGuard(caller),true);return {identity:appDataDigest({scope:value.scope,connection:value.connection,consent:value.consent?{consent_id:value.consent.consent_id,consent_digest:value.consent.consent_digest,expires_at:value.consent.expires_at.toISOString()}:null,data_policy_digest:value.data_policy_digest}),expires_at:value.expires_at};};
 const service=createAppIntegrationRecipientAssistance({current,contacts:(_,input,signal)=>contacts.search(auth.actor,input,signal),recent:(_,input,signal)=>invokeAppIntegrationRecentRecipients(caller,session,input,signal)});
 return {suggest:(input:unknown,signal?:AbortSignal)=>service.suggest({kind:'human',org_id:caller.org_id,user_id:caller.user_id,principal_id:caller.sid,access_expires_at:caller.access_expires_at},input,signal)};
}
