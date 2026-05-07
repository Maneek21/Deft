import { db } from './db.js';
import { spaceMembers } from '@deft/db/schema';
import { and, eq } from 'drizzle-orm';

export async function requireSpaceMembership(spaceId: string, userId: string): Promise<boolean> {
  const [member] = await db.select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, userId)))
    .limit(1);
  return !!member;
}
