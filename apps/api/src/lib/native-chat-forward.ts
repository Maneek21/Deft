import { and, eq } from 'drizzle-orm';
import { appPrivateDeftySeals, messages, orgMembers, spaces, spaceMembers, users } from '@deft/db/schema';
import type { ContextCreator, ContextWriteDatabase } from './native-context-create.js';

export class NativeChatForwardError extends Error {
  constructor(readonly code: 'FORBIDDEN' | 'PRIVATE_CONTEXT_REQUIRED') { super(code); }
}

/** Shared forwarding write. Copies are quoted context, not new authored turns:
 * forwarding never runs mention normalization, agent dispatch or link fetching.
 * The caller can retain its source and receipt transaction through this write. */
export async function assertNativeChatForwardDestination(database: ContextWriteDatabase, user: ContextCreator, spaceId: string) {
  const [destination] = await database.select({ id: spaces.id }).from(spaces)
    .innerJoin(spaceMembers, and(eq(spaceMembers.space_id, spaces.id), eq(spaceMembers.user_id, user.id)))
    .innerJoin(orgMembers, and(eq(orgMembers.org_id, spaces.org_id), eq(orgMembers.user_id, user.id), eq(orgMembers.is_active, true)))
    .where(and(eq(spaces.org_id, user.org_id), eq(spaces.id, spaceId))).limit(1).for('share');
  if (!destination) throw new NativeChatForwardError('FORBIDDEN');
  const [seal] = await database.select({ id: appPrivateDeftySeals.id }).from(appPrivateDeftySeals)
    .where(and(eq(appPrivateDeftySeals.org_id, user.org_id), eq(appPrivateDeftySeals.space_id, spaceId))).limit(1).for('share');
  if (seal) throw new NativeChatForwardError('PRIVATE_CONTEXT_REQUIRED');
}

export async function createNativeChatForward(database: ContextWriteDatabase, user: ContextCreator,
  input: { space_id: string; content: string; metadata: unknown }) {
  await assertNativeChatForwardDestination(database, user, input.space_id);
  const [forwarded] = await database.insert(messages).values({ org_id: user.org_id, space_id: input.space_id,
    user_id: user.id, content: input.content, metadata: input.metadata }).returning();
  if (!forwarded) throw new Error('Message insert returned no row');
  return forwarded;
}

/** Keep the existing forward event shape in both callers. */
export async function nativeChatForwardBroadcast(database: ContextWriteDatabase, messageId: string) {
  const [full] = await database.select({ id: messages.id, content: messages.content, user_id: messages.user_id,
    space_id: messages.space_id, created_at: messages.created_at, user_name: users.name,
    user_avatar: users.avatar_url, metadata: messages.metadata }).from(messages)
    .innerJoin(users, eq(messages.user_id, users.id)).where(eq(messages.id, messageId)).limit(1);
  return full;
}
