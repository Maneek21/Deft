import {EmailRecipientAssistance} from './email-recipient-assistance.js';
import {GovernedEmailRecipientContacts} from './email-recipient-contacts.js';
import {getEmailMailboxRuntime} from './email-mailbox-runtime.js';
import {getEmailOutboxService} from './email-outbox-runtime.js';
import {humanModuleActor,listModuleInstallations,queryModuleRecords} from './module-service.js';
import type {EmailActor,EmailScope} from './email-mailbox-service.js';
export async function getEmailRecipientAssistance(actor:EmailActor){
 const [{authority},recent]=await Promise.all([getEmailMailboxRuntime(actor),getEmailOutboxService(actor)]);
 const human=(a:EmailActor,s:EmailScope)=>humanModuleActor({orgId:s.org_id,userId:a.user_id,role:'member',source:'rest'});
 const contacts=new GovernedEmailRecipientContacts({list:(a,s)=>listModuleInstallations(human(a,s)),query:(a,s,input)=>queryModuleRecords(human(a,s),input)});
 return new EmailRecipientAssistance(authority,contacts,recent);
}
