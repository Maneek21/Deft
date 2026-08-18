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
import { eq, and, isNotNull, isNull } from 'drizzle-orm';
import { db } from './db.js';
import { agentEmployees, mcpTokens, orgMembers } from '@deft/db/schema';
import type { TrustLevel } from './mcp-tools/types.js';
import { OAuthMcpError, resolveOAuthAccessToken } from './oauth-mcp.js';

const BCRYPT_ROUNDS = 10;

export type GatewayEmployee = {
  employee_id: string;
  slug: string;
  trust_level: TrustLevel;
  disabled_tools: string[];
  unhealthy: boolean;
  unhealthy_reason: string | null;
};

export type ResolvedGateway = {
  org_id: string;
  gateway_employees: GatewayEmployee[];
};

export type McpHumanPrincipal = {
  kind: 'human' | 'oauth';
  token_id: string;
  org_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
  scopes: string[];
  client_id?: string;
  grant_id?: string;
};

export type McpAgentPrincipal = {
  kind: 'agent';
  org_id: string;
  gateway_employees: GatewayEmployee[];
};

export type ResolvedMcpPrincipal = McpHumanPrincipal | McpAgentPrincipal;

export class McpAuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly scope?: string,
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

export async function issuePersonalMcpToken(params: {
  orgId: string;
  userId: string;
  name: string;
  scopes: string[];
  createdBy: string;
}): Promise<{ raw: string; prefix: string; tokenId: string }> {
  const secret = randomBytes(32).toString('base64url');
  const raw = `deft_mcp_${secret}`;
  const prefix = raw.slice(0, 18);
  const hash = await bcrypt.hash(raw, BCRYPT_ROUNDS);
  const [row] = await db
    .insert(mcpTokens)
    .values({
      org_id: params.orgId,
      user_id: params.userId,
      principal_kind: 'human',
      name: params.name,
      token_hash: hash,
      token_prefix: prefix,
      scopes: params.scopes,
      created_by: params.createdBy,
    })
    .returning({ id: mcpTokens.id });
  if (!row?.id) throw new Error('issuePersonalMcpToken: insert returned no row');
  return { raw, prefix, tokenId: row.id };
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
      disabled_tools: agentEmployees.disabled_tools,
      unhealthy: agentEmployees.unhealthy,
      unhealthy_reason: agentEmployees.unhealthy_reason,
      is_active: agentEmployees.is_active,
    })
    .from(agentEmployees)
    .where(
      and(
        isNotNull(agentEmployees.mcp_token_hash),
        eq(agentEmployees.is_active, true),
        eq(agentEmployees.is_deleted, false),
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
          disabled_tools: row.disabled_tools ?? [],
          unhealthy: row.unhealthy,
          unhealthy_reason: row.unhealthy_reason,
        },
      ],
    };
  }

  throw new McpAuthError(401, 'unauthorized', 'Invalid bearer token');
}

export async function resolveMcpPrincipal(bearer: string): Promise<ResolvedMcpPrincipal> {
  if (!bearer || bearer.length < 16) {
    throw new McpAuthError(401, 'unauthorized', 'Missing or malformed bearer token');
  }

  const personalCandidates = bearer.startsWith('deft_mcp_')
    ? await db
      .select({
        id: mcpTokens.id,
        org_id: mcpTokens.org_id,
        user_id: mcpTokens.user_id,
        token_hash: mcpTokens.token_hash,
        scopes: mcpTokens.scopes,
      })
      .from(mcpTokens)
      .where(and(
        eq(mcpTokens.principal_kind, 'human'),
        eq(mcpTokens.token_prefix, bearer.slice(0, 18)),
        isNull(mcpTokens.revoked_at),
      ))
    : [];

  for (const row of personalCandidates) {
    if (!row.user_id) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await bcrypt.compare(bearer, row.token_hash);
    if (!ok) continue;
    const [member] = await db
      .select({ role: orgMembers.role, is_active: orgMembers.is_active })
      .from(orgMembers)
      .where(and(eq(orgMembers.org_id, row.org_id), eq(orgMembers.user_id, row.user_id)))
      .limit(1);
    if (!member?.is_active) {
      throw new McpAuthError(403, 'forbidden', 'MCP token owner is not an active org member');
    }
    await db.update(mcpTokens).set({ last_used_at: new Date() }).where(eq(mcpTokens.id, row.id));
    return {
      kind: 'human',
      token_id: row.id,
      org_id: row.org_id,
      user_id: row.user_id,
      role: member.role as McpHumanPrincipal['role'],
      scopes: row.scopes ?? [],
    };
  }

  try {
    const oauth = await resolveOAuthAccessToken(bearer);
    return {
      kind: 'oauth',
      token_id: oauth.token_id,
      grant_id: oauth.grant_id,
      org_id: oauth.org_id,
      user_id: oauth.user_id,
      role: oauth.role,
      scopes: oauth.scopes,
      client_id: oauth.client_id,
    };
  } catch (err) {
    if (err instanceof OAuthMcpError && err.code !== 'unauthorized') {
      throw new McpAuthError(err.status, err.code, err.message);
    }
  }

  const agent = await resolveGatewayToken(bearer);
  return { kind: 'agent', ...agent };
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
