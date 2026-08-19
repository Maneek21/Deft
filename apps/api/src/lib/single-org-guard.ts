/**
 * Self-hosted v1 — Single-org hard-block.
 *
 * The self-hosted v1 product supports one workspace per deployment. This
 * guard protects that supported operating model; it is not a license
 * restriction. The first signup bootstraps the workspace, and every
 * subsequent signup must join it through an invite flow (or be rejected).
 *
 * This helper counts how many orgs exist. Callers decide how to react:
 *   - auth /signup rejects with SINGLE_ORG_LIMIT when count >= 1 and the
 *     request is not an invite redemption.
 *   - the startup check in apps/api/src/server.ts logs a warning if count
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
    'for an invite — the self-hosted v1 product supports a single ' +
    'workspace per deployment.',
  code: 'SINGLE_ORG_LIMIT',
} as const;
