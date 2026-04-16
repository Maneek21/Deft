/**
 * Canonical user/agent-employee lookup helper for agent tool calls.
 *
 * Resolves a name-or-id input into a { id, name, is_agent, kind } row.
 * Searches across:
 *   - Org members (human users with an org_members row in this org)
 *   - Agent employees (users.is_agent=true with an agent_employees row in this org)
 *
 * Strategy (in order):
 *   1. Direct id match (either users.id or agent_employees.id -> user_id)
 *   2. Exact case-insensitive name match
 *   3. Partial ilike '%name%' match. If multiple rows match, returns null and
 *      emits a console.warn — callers should return a disambiguation error to
 *      the LLM with the list of matches.
 *
 * Returns null if no match found or match is ambiguous.
 */
import { db } from './db.js';
import { users, orgMembers, agentEmployees } from '@deft/db/schema';
import { eq, and, ilike, or, sql } from 'drizzle-orm';

export type ResolvedAssignee = {
  id: string;
  name: string;
  is_agent: boolean;
  kind: 'user' | 'agent';
};

export async function resolveAssignee(
  nameOrId: string,
  orgId: string,
): Promise<ResolvedAssignee | null> {
  if (!nameOrId || typeof nameOrId !== 'string') return null;
  const input = nameOrId.trim();
  if (input.length === 0) return null;

  // Org-scoped user universe: either a member of this org OR an agent employee of this org.
  // Built as a Drizzle query so org isolation is enforced once here.
  // We fetch all candidates and filter in memory — the candidate set is at
  // most the org's member + agent-employee count (tens/hundreds, not millions).
  const candidates = await db
    .select({
      id: users.id,
      name: users.name,
      is_agent: users.is_agent,
    })
    .from(users)
    .where(
      or(
        // Human member of this org
        sql`EXISTS (SELECT 1 FROM ${orgMembers} WHERE ${orgMembers.user_id} = ${users.id} AND ${orgMembers.org_id} = ${orgId} AND ${orgMembers.is_active} = true)`,
        // Agent employee of this org
        sql`EXISTS (SELECT 1 FROM ${agentEmployees} WHERE ${agentEmployees.user_id} = ${users.id} AND ${agentEmployees.org_id} = ${orgId} AND ${agentEmployees.is_active} = true)`,
      ),
    );

  if (candidates.length === 0) return null;

  // 1. Direct id match
  const idMatch = candidates.find((c) => c.id === input);
  if (idMatch) return toResolved(idMatch);

  // 2. Exact case-insensitive name match
  const lower = input.toLowerCase();
  const exactMatches = candidates.filter((c) => c.name.toLowerCase() === lower);
  if (exactMatches.length === 1) return toResolved(exactMatches[0]!);
  if (exactMatches.length > 1) {
    console.warn(
      `[resolveAssignee] ambiguous exact match for "${input}" in org ${orgId}: ${exactMatches
        .map((c) => c.name)
        .join(', ')}`,
    );
    return null;
  }

  // 3. Partial ilike match
  const partialMatches = candidates.filter((c) =>
    c.name.toLowerCase().includes(lower),
  );
  if (partialMatches.length === 1) return toResolved(partialMatches[0]!);
  if (partialMatches.length > 1) {
    console.warn(
      `[resolveAssignee] ambiguous partial match for "${input}" in org ${orgId}: ${partialMatches
        .map((c) => c.name)
        .join(', ')}`,
    );
    return null;
  }

  return null;
}

/**
 * Variant of {@link resolveAssignee} that, on an ambiguous match, returns the
 * candidate list so the caller can surface a disambiguation error to the LLM.
 */
export async function resolveAssigneeWithMatches(
  nameOrId: string,
  orgId: string,
): Promise<
  | { ok: true; value: ResolvedAssignee }
  | { ok: false; ambiguous: boolean; matches: ResolvedAssignee[] }
> {
  if (!nameOrId || typeof nameOrId !== 'string') {
    return { ok: false, ambiguous: false, matches: [] };
  }
  const input = nameOrId.trim();
  if (input.length === 0) return { ok: false, ambiguous: false, matches: [] };

  const candidates = await db
    .select({
      id: users.id,
      name: users.name,
      is_agent: users.is_agent,
    })
    .from(users)
    .where(
      or(
        sql`EXISTS (SELECT 1 FROM ${orgMembers} WHERE ${orgMembers.user_id} = ${users.id} AND ${orgMembers.org_id} = ${orgId} AND ${orgMembers.is_active} = true)`,
        sql`EXISTS (SELECT 1 FROM ${agentEmployees} WHERE ${agentEmployees.user_id} = ${users.id} AND ${agentEmployees.org_id} = ${orgId} AND ${agentEmployees.is_active} = true)`,
      ),
    );

  if (candidates.length === 0) {
    return { ok: false, ambiguous: false, matches: [] };
  }

  const idMatch = candidates.find((c) => c.id === input);
  if (idMatch) return { ok: true, value: toResolved(idMatch) };

  const lower = input.toLowerCase();
  const exact = candidates.filter((c) => c.name.toLowerCase() === lower);
  if (exact.length === 1) return { ok: true, value: toResolved(exact[0]!) };
  if (exact.length > 1) {
    return { ok: false, ambiguous: true, matches: exact.map(toResolved) };
  }

  const partial = candidates.filter((c) => c.name.toLowerCase().includes(lower));
  if (partial.length === 1) return { ok: true, value: toResolved(partial[0]!) };
  if (partial.length > 1) {
    return { ok: false, ambiguous: true, matches: partial.map(toResolved) };
  }

  return { ok: false, ambiguous: false, matches: [] };
}

function toResolved(row: { id: string; name: string; is_agent: boolean }): ResolvedAssignee {
  return {
    id: row.id,
    name: row.name,
    is_agent: row.is_agent,
    kind: row.is_agent ? 'agent' : 'user',
  };
}
