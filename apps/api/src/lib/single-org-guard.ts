/**
 * Self-hosted v1 — Single-org hard-block.
 *
 * Deft ships under BSL 1.1, which prohibits offering Deft as a hosted
 * service to third parties. To give that license technical teeth, a self-
 * hosted Deft instance only ever hosts one org. The first signup
 * bootstraps that org; every subsequent signup must join the existing org
 * via an invite flow (or be rejected).
 *
 * This helper counts how many orgs exist. Callers decide how to react:
 *   - auth /signup rejects with SINGLE_ORG_LIMIT when count >= 1 and the
 *     request is not an invite redemption.
 *   - the startup check in apps/api/src/index.ts logs a warning if count
 *     exceeds 1 (which can only happen on a DB carried over from a
 *     pre-hard-block build — treat as operator misconfiguration).
 *
 * We never *prevent* multiple orgs at the DB layer — a scripted import or
 * seed run may legitimately create more than one row. The enforcement
 * surface is the public auth flow.
 */
import { db } from './db.js';
import { orgs } from '@deft/db/schema';
import { sql } from 'drizzle-orm';

export async function countOrgs(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orgs);
  return row?.n ?? 0;
}

export const SINGLE_ORG_ERROR = {
  error:
    'This Deft instance already has a workspace. Ask your administrator ' +
    'for an invite — self-hosted Deft hosts a single workspace per ' +
    'deployment. See LICENSE for the BSL 1.1 terms that make this a ' +
    'hard rule rather than a configuration knob.',
  code: 'SINGLE_ORG_LIMIT',
} as const;
