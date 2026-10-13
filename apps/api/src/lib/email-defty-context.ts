import { and, eq, isNull } from 'drizzle-orm';
import { emailAgentGrants, emailMessages } from '@deft/db/schema';
import { db } from './db.js';
import { getEmailMailboxAuthority } from './email-account-authority-router.js';
import { ensureDeftyDm, ensureDeftyEmployee } from './ensure-defty-membership.js';
import type { EmailActor, EmailScope } from './email-mailbox-service.js';
import {z} from 'zod';
import type {ExperienceCaller} from './app-experience-service.js';
import {getAppIntegrationCaptureRuntime} from './app-integration-capture-service.js';

/** Creates a reference handoff only; the user still authors and sends the Chat message. */
export async function openEmailDeftyContext(actor: EmailActor, scope: EmailScope, messageId: string) {
  const authority = await getEmailMailboxAuthority(db);
  const grant = await db.transaction(async tx => {
    await authority.current(actor, scope, 'human_read', tx);
    const [message] = await tx.select({ id: emailMessages.logical_message_id }).from(emailMessages).where(and(
      eq(emailMessages.org_id, scope.org_id), eq(emailMessages.owner_user_id, scope.owner_user_id),
      eq(emailMessages.account_id, scope.account_id), eq(emailMessages.logical_message_id, messageId), isNull(emailMessages.deleted_at),
    )).limit(1);
    if (!message) throw Error('EMAIL_MESSAGE_UNAVAILABLE');
    const [permission] = await tx.select().from(emailAgentGrants).where(and(
      eq(emailAgentGrants.org_id, scope.org_id), eq(emailAgentGrants.owner_user_id, scope.owner_user_id),
      eq(emailAgentGrants.account_id, scope.account_id), eq(emailAgentGrants.principal_kind, 'defty'),
      eq(emailAgentGrants.principal_id, scope.owner_user_id), isNull(emailAgentGrants.revoked_at),
    )).limit(1);
    if (!permission?.operations.includes('read')) throw Error('EMAIL_DEFTY_ACCESS_REQUIRED');
    return permission;
  });
  const defty = await ensureDeftyEmployee(scope.org_id);
  const spaceId = await ensureDeftyDm(scope.org_id, scope.owner_user_id);
  await authority.current({ user_id: scope.owner_user_id, agent_grant_id: grant.id, principal_kind: 'defty',
    principal_id: scope.owner_user_id, access_expires_at: actor.access_expires_at, conversation_id: spaceId, employee_id: defty.employeeId }, scope, 'human_read');
  await authority.current(actor, scope, 'human_read');
  const params = new URLSearchParams({ space: spaceId, email_account: scope.account_id, email_message: messageId });
  return { space_id: spaceId, account_id: scope.account_id, logical_message_id: messageId, url: `/chat?${params}` };
}

/** Installed-App handoff. Source navigation keeps the original opaque identity;
 * the real human and canonical private Defty context independently reauthorize. */
export async function openInstalledEmailDeftyContext(caller:ExperienceCaller,raw:unknown){
 const input=z.strictObject({installation_id:z.uuid(),account_ref:z.string().min(1).max(512),store_key:z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u),logical_message_id:z.string().regex(/^mail_[a-f0-9]{64}$/u)}).parse(raw);
 const source=await getAppIntegrationCaptureRuntime(),human={org_id:caller.org_id,user_id:caller.user_id,kind:'human' as const,principal_id:caller.sid,access_expires_at:caller.access_expires_at};
 const first=await source.resolveOpaque(human,input,input.logical_message_id,'read');
 const employee=await ensureDeftyEmployee(caller.org_id),space=await ensureDeftyDm(caller.org_id,caller.user_id);
 const defty={org_id:caller.org_id,user_id:caller.user_id,kind:'defty' as const,principal_id:caller.user_id,employee_id:employee.employeeId,conversation_id:space,access_expires_at:caller.access_expires_at};
 const current=await source.resolveOpaque(defty,input,input.logical_message_id,'tool_read');
 if(current.publication.target.ref.content_digest!==first.publication.target.ref.content_digest)throw Error('EMAIL_SOURCE_CHANGED');
 const final=await source.resolveOpaque(human,input,input.logical_message_id,'read');
 if(final.publication.target.ref.content_digest!==current.publication.target.ref.content_digest)throw Error('EMAIL_SOURCE_CHANGED');
 return {space_id:space,url:'/chat?'+new URLSearchParams({space}),source:{installation_id:input.installation_id,account_ref:input.account_ref,store_key:input.store_key,ref:current.publication.target.ref},
  tool_context:{tool_key:'email_read',input:{account_id:input.account_ref,logical_message_id:input.logical_message_id}}};
}
