/**
 * Prints a one-time password recovery link for any member, made on the
 * server by whoever runs it (an operator with shell access). It is the way
 * back in for an owner who has forgotten their password: in the app, only the
 * owner can make a link for an owner or admin.
 *
 * The link sets a new password and nothing else. It never removes two-step
 * verification: the person still needs a code from their authenticator or a
 * recovery code.
 *
 * Run (from apps/api): node --import tsx src/scripts/make-recovery-url.ts <email>
 * In Docker: docker compose exec deft sh -c "cd /app/apps/api && node --import tsx src/scripts/make-recovery-url.ts <email>"
 */
import { pathToFileURL } from 'node:url';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { orgMembers, users } from '@deft/db/schema';
import { db } from '../lib/db.js';
import { env } from '../lib/env.js';
import { OPERATOR_RECOVERY_ISSUER } from '../lib/web-sessions.js';

const RECOVERY_TTL = '24h';

export async function makeOperatorRecoveryUrl(email: string): Promise<{ url: string; expires_at: string }> {
  const [target] = await db
    .select({ id: users.id, email: users.email, password_version: users.password_version, org_id: orgMembers.org_id })
    .from(users)
    .innerJoin(orgMembers, eq(orgMembers.user_id, users.id))
    .where(and(eq(users.email, email.trim()), eq(orgMembers.is_active, true), eq(users.kind, 'human')))
    .limit(1);
  if (!target) throw new Error(`No active member with the email ${email}`);
  const token = jwt.sign(
    { id: target.id, email: target.email, org_id: target.org_id, purpose: 'password-reset', password_version: target.password_version, issued_by: OPERATOR_RECOVERY_ISSUER },
    env.JWT_SECRET,
    { expiresIn: RECOVERY_TTL },
  );
  const { exp } = jwt.decode(token) as { exp: number };
  return { url: `${env.NEXT_PUBLIC_APP_URL}/reset-password?token=${token}`, expires_at: new Date(exp * 1000).toISOString() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: make-recovery-url.ts <email>');
    process.exit(2);
  }
  makeOperatorRecoveryUrl(email)
    .then(({ url, expires_at }) => {
      console.log(`Recovery link (works once, until ${expires_at}):\n${url}`);
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
