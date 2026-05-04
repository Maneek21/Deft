/**
 * MCP bearer token issuer + resolver.
 *
 * One bearer = one BYOA agent. The agent presents the raw token to Deft on
 * every MCP request; Deft bcrypt-compares it against all live employee rows
 * to find the owning employee, then the tool handler validates the declared
 * `caller_employee_slug` against that employee's slug.
 *
 * Defty (the in-process built-in agent) does not transit MCP — it has no
 * `agent_employees` row and never participates in bearer auth. Every row in
 * `agent_employees` is a BYOA agent.
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { eq, and, isNotNull } from 'drizzle-orm';
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
 * Generate a raw token, bcrypt-hash it, and write the hash into the
 * `agent_employees` row identified by (orgId, employeeId). Returns the raw
 * token exactly once.
 */
export async function issueEmployeeToken(
  orgId: string,
  employeeId: string,
): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  const hash = await bcrypt.hash(raw, BCRYPT_ROUNDS);

  const affected = await db
    .update(agentEmployees)
    .set({ mcp_token_hash: hash })
    .where(
      and(
        eq(agentEmployees.org_id, orgId),
        eq(agentEmployees.id, employeeId),
      ),
    )
    .returning({ id: agentEmployees.id });

  if (affected.length === 0) {
    throw new Error(
      `issueEmployeeToken: no employee found for org ${orgId} id ${employeeId}`,
    );
  }

  return raw;
}

/**
 * Resolve a bearer token to its owning employee. Walks all live
 * `agent_employees` rows that have a non-null `mcp_token_hash` and
 * bcrypt-compares. The first match wins.
 *
 * In MVP this is a linear scan. Fine at the <100 employee scale a
 * self-hosted Deft instance operates at.
 */
export async function resolveGatewayToken(bearer: string): Promise<ResolvedGateway> {
  if (!bearer || bearer.length < 16) {
    throw new McpAuthError(401, 'unauthorized', 'Missing or malformed bearer token');
  }

  const candidates = await db
    .select({
      id: agentEmployees.id,
      org_id: agentEmployees.org_id,
      slug: agentEmployees.slug,
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
    // eslint-disable-next-line no-await-in-loop
    const ok = await bcrypt.compare(bearer, row.mcp_token_hash);
    if (!ok) continue;
    return {
      org_id: row.org_id,
      gateway_employees: [
        {
          employee_id: row.id,
          slug: row.slug,
          trust_level: row.trust_level as TrustLevel,
        },
      ],
    };
  }

  throw new McpAuthError(401, 'unauthorized', 'Invalid bearer token');
}

/**
 * Validate that the declared `caller_employee_slug` matches the employee
 * we just resolved. Returns the narrowed employee on success.
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
      `Declared caller_employee_slug "${callerSlug}" is not registered for this token`,
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
