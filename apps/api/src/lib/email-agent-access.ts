import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { emailAgentGrants, mcpTokens } from '@deft/db/schema';
import { db } from './db.js';
import { getEmailMailboxAuthority } from './email-account-authority-router.js';
import type { EmailActor, EmailScope } from './email-mailbox-service.js';
export const EmailAgentAccessChange = z.strictObject({ principal_kind:z.enum(['defty','personal_mcp']),principal_id:z.string().min(1).max(256),
  operations:z.array(z.enum(['read','draft','triage','send'])).max(4).refine(v=>new Set(v).size===v.length).refine(v=>(!v.includes('draft')&&!v.includes('triage')&&!v.includes('send')||v.includes('read'))&&(!v.includes('send')||v.includes('draft'))),expected_revision:z.number().int().min(0).max(2147483646) });
export class EmailAgentAccessService {
  async list(actor:EmailActor,scope:EmailScope) {
    const authority=await getEmailMailboxAuthority(db);
    return db.transaction(async tx=>{
      await authority.current(actor,scope,'human_read',tx);
      const grants=await tx.select().from(emailAgentGrants).where(and(eq(emailAgentGrants.org_id,scope.org_id),eq(emailAgentGrants.owner_user_id,scope.owner_user_id),eq(emailAgentGrants.account_id,scope.account_id)));
      const tokens=await tx.select({id:mcpTokens.id,name:mcpTokens.name}).from(mcpTokens).where(and(eq(mcpTokens.org_id,scope.org_id),eq(mcpTokens.user_id,scope.owner_user_id),eq(mcpTokens.principal_kind,'human'),isNull(mcpTokens.revoked_at)));
      await authority.current(actor,scope,'human_read',tx);
      return {defty_principal_id:scope.owner_user_id,grants,personal_tokens:tokens};
    });
  }
  async change(actor:EmailActor,scope:EmailScope,raw:unknown) {
    const input=EmailAgentAccessChange.parse(raw),authority=await getEmailMailboxAuthority(db);
    await db.transaction(async tx=>{
      await authority.current(actor,scope,'human_read',tx);
      if(input.principal_kind==='defty'&&input.principal_id!==scope.owner_user_id)throw Error('EMAIL_ACCESS_DENIED');
      if(input.principal_kind==='personal_mcp'){
        const [token]=await tx.select().from(mcpTokens).where(and(eq(mcpTokens.id,input.principal_id),eq(mcpTokens.org_id,scope.org_id),eq(mcpTokens.user_id,scope.owner_user_id),eq(mcpTokens.principal_kind,'human'),isNull(mcpTokens.revoked_at))).limit(1).for('share');
        if(!token)throw Error('EMAIL_ACCESS_DENIED');
      }
      const key=and(eq(emailAgentGrants.org_id,scope.org_id),eq(emailAgentGrants.owner_user_id,scope.owner_user_id),eq(emailAgentGrants.account_id,scope.account_id),eq(emailAgentGrants.principal_kind,input.principal_kind),eq(emailAgentGrants.principal_id,input.principal_id));
      const [previous]=await tx.select().from(emailAgentGrants).where(key).limit(1).for('update');
      if((previous?.revision??0)!==input.expected_revision)throw Error('EMAIL_AGENT_GRANT_CONFLICT');
      const now=new Date(),next={operations:input.operations,revision:input.expected_revision+1,revoked_at:input.operations.length?null:now,updated_at:now};
      if(previous)await tx.update(emailAgentGrants).set(next).where(eq(emailAgentGrants.id,previous.id));
      else await tx.insert(emailAgentGrants).values({id:randomUUID(),...scope,principal_kind:input.principal_kind,principal_id:input.principal_id,...next});
      await authority.current(actor,scope,'human_read',tx);
    });
    return this.list(actor,scope);
  }
}
