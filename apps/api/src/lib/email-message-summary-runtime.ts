import {getEmailMailboxRuntime} from './email-mailbox-runtime.js';
import {EmailMessageSummaryService} from './email-message-summary.js';
import type {EmailActor} from './email-mailbox-service.js';
export async function getEmailMessageSummaryService(actor:EmailActor){const {authority,store}=await getEmailMailboxRuntime(actor);return new EmailMessageSummaryService(authority,store);}
