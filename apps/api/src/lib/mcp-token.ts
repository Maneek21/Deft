/**
 * Phase 3 — Gateway bearer token issuer + resolver.
 *
 * One bearer = one Gateway = N employees. When we issue a token for a Gateway
 * (identified by its connection_url), every `agent_employees` row on that
 * Gateway within the given org gets the same bcrypt hash stamped into its
 * `mcp_token_hash` column. The Gateway presents the raw token to Deft on every
 * MCP request; Deft bcrypt-compares it against all live employee rows to find
 * the owning Gateway, then the tool handler validates the declared
 * `caller_employee_slug` against that Gateway's employee set.
 *
 * Native employees (`kind = 'native'`) are never considered bearer-auth
 * candidates — the native runtime talks to Deft via direct service calls, not
 * via MCP streamable-http. Phase 2 preserved Alex PM as native so the demo
 * path keeps working.
 *
 * This is an honesty-based boundary: two employees on the same Gateway could
 * theoretically lie about their slug to escalate into each other's memory
 * scope. Stricter isolation requires the "one Gateway per employee" wizard
 * mode (Phase 8). See §3.2 of the Deft Agentic Vision plan.
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { eq, and, inArray, isNotNull } from 'drizzle-orm';
import { db } from './db.js';
import { agentEmployees } from '@deft/db/schema';
import type { TrustLevel } from './mcp-tools/types.js';

const BCRYPT_ROUNDS = 10;

export type GatewayEmployee = {
  employee_id: string;
  slug: string;
  trust_level: TrustLevel;
};

export type ResolvedGateway = {
  org_id: string;
  gateway_employees: GatewayEmployee[];
};

export class McpAuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpAuthError';
  }
}

/**
 * Generate a raw token, bcrypt-hash it, and write the hash into every
 * agent_employees row with `kind != 'native'` matching (orgId, connectionUrl).
 * Returns the raw token exactly once.
 *
 * If no matching employee rows exist, throws — the caller must seed the
 * employee first. This prevents accidental "token issued but hash landed
 * nowhere" states.
 */
export async function issueGatewayToken(
  orgId: string,
  connectionUrl: string,
): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  const hash = await bcrypt.hash(raw, BCRYPT_ROUNDS);

  const affected = await db
    .update(agentEmployees)
    .set({ mcp_token_hash: hash })
    .where(
      and(
        eq(agentEmployees.org_id, orgId),
        eq(agentEmployees.connection_url, connectionUrl),
      ),
    )
    .returning({ id: agentEmployees.id, kind: agentEmployees.kind });

  // Filter out native employees — they should never get a bearer hash set,
  // but we defensively null them out if they were accidentally matched.
  const nonNative = affected.filter((r) => r.kind !== 'native');
  if (nonNative.length === 0) {
    throw new Error(
      `issueGatewayToken: no non-native employees found for org ${orgId} connection ${connectionUrl}`,
    );
  }

  // Undo any accidental writes to native rows.
  const nativeIds = affected.filter((r) => r.kind === 'native').map((r) => r.id);
  if (nativeIds.length > 0) {
    await db
      .update(agentEmployees)
      .set({ mcp_token_hash: null })
      .where(inArray(agentEmployees.id, nativeIds));
  }

  return raw;
}

/**
 * Resolve a bearer token to its Gateway. Walks all live agent_employees rows
 * that have a non-null `mcp_token_hash` and bcrypt-compares. The first match
 * wins. We group the match by `(org_id, connection_url)` to collect the
 * sibling employees on the same Gateway.
 *
 * In MVP this is a linear scan. It's fine at the <100 employee scale a
 * self-hosted Deft instance operates at. A follow-up Phase 11 can move this
 * to a token_prefix + hash lookup table if needed.
 */
export async function resolveGatewayToken(bearer: string): Promise<ResolvedGateway> {
  if (!bearer || bearer.length < 16) {
    throw new McpAuthError(401, 'unauthorized', 'Missing or malformed bearer token');
  }

  // Pull every candidate row with a hash set. Native employees have no hash
  // so they're naturally excluded.
  const candidates = await db
    .select({
      id: agentEmployees.id,
      org_id: agentEmployees.org_id,
      slug: agentEmployees.slug,
      kind: agentEmployees.kind,
      connection_url: agentEmployees.connection_url,
      connection_status: agentEmployees.connection_status,
      mcp_token_hash: agentEmployees.mcp_token_hash,
      trust_level: agentEmployees.trust_level,
      is_active: agentEmployees.is_active,
    })
    .from(agentEmployees)
    .where(
      and(
        isNotNull(agentEmployees.mcp_token_hash),
        eq(agentEmployees.is_active, true),
      ),
    );

  for (const row of candidates) {
    if (!row.mcp_token_hash) continue;
    if (row.kind === 'native') continue;
    if (row.connection_status === 'revoked' || row.connection_status === 'error') continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await bcrypt.compare(bearer, row.mcp_token_hash);
    if (!ok) continue;
    // Match. Collect sibling employees on the same Gateway.
    const siblings = candidates.filter(
      (r) =>
        r.org_id === row.org_id &&
        r.connection_url === row.connection_url &&
        r.kind !== 'native' &&
        r.mcp_token_hash === row.mcp_token_hash,
    );
    return {
      org_id: row.org_id,
      gateway_employees: siblings.map((s) => ({
        employee_id: s.id,
        slug: s.slug,
        trust_level: s.trust_level as TrustLevel,
      })),
    };
  }

  throw new McpAuthError(401, 'unauthorized', 'Invalid bearer token');
}

/**
 * Validate that the declared `caller_employee_slug` is a member of the
 * Gateway we just resolved. Returns the narrowed employee on success.
 * Throws 403 on mismatch — this is the NC2 boundary that the plan calls out
 * as honesty-based: the resolver trusts the slug the Gateway sends.
 */
export function validateCallerSlug(
  resolved: ResolvedGateway,
  callerSlug: string,
): GatewayEmployee {
  if (!callerSlug || typeof callerSlug !== 'string') {
    throw new McpAuthError(
      400,
      'bad_request',
      'Missing arguments.caller_employee_slug',
    );
  }
  const hit = resolved.gateway_employees.find((e) => e.slug === callerSlug);
  if (!hit) {
    throw new McpAuthError(
      403,
      'forbidden',
      `Declared caller_employee_slug "${callerSlug}" is not registered on this Gateway`,
    );
  }
  return hit;
}

/** Read the Authorization header and extract the bearer token value. */
export function extractBearer(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!m) return null;
  return m[1]!.trim();
}
