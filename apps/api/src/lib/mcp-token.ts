/**
 * MCP bearer token issuer + resolver.
 *
 * One bearer = one BYOA agent. The agent presents the raw token to Deft on
 * every MCP request; Deft bcrypt-compares it against all live employee rows
 * to find the owning employee. Employee identity comes from that credential,
 * never from model-authored tool arguments.
 *
 * Defty (the in-process built-in agent) does not transit MCP — it has no
 * `agent_employees` row and never participates in bearer auth. Every row in
 * `agent_employees` is a BYOA agent.
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { eq, and, isNotNull, isNull, sql } from 'drizzle-orm';
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
  /** Present only for a first-class scoped mcp_tokens credential. */
  token_id?: string;
  scopes?: string[];
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
  /** Legacy agent_employees bearer hashes intentionally have neither. */
  token_id?: string;
  scopes: string[];
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

export const EMPLOYEE_MCP_APP_SCOPES = [
  'read:apps',
  'invoke:apps',
  'read:app-runs',
] as const;

export type EmployeeMcpAppScope = typeof EMPLOYEE_MCP_APP_SCOPES[number];
export type EmployeeMcpScope = 'read:modules' | EmployeeMcpAppScope;

export type IssuedEmployeeMcpToken = Readonly<{
  raw: string;
  prefix: string;
  tokenId: string;
  tokenHash: string;
  scopes: readonly EmployeeMcpScope[];
}>;

/**
 * Issue a first-class employee MCP credential and keep the historical
 * agent_employees hash in sync. An empty App-scope selection is intentional:
 * existing employee issuance remains App-blind until an operator explicitly
 * selects one of the additive App scopes.
 */
export async function issueScopedEmployeeMcpToken(params: {
  orgId: string;
  employeeId: string;
  name?: string;
  createdBy?: string;
  scopes?: readonly EmployeeMcpAppScope[];
  rawToken?: string;
  revokeExisting?: boolean;
  bcryptRounds?: number;
}): Promise<IssuedEmployeeMcpToken> {
  const requestedAppScopes = [...new Set(params.scopes ?? [])];
  if (requestedAppScopes.some((scope) => !EMPLOYEE_MCP_APP_SCOPES.includes(scope))) {
    throw new Error('issueScopedEmployeeMcpToken: unsupported employee MCP scope');
  }
  // App discovery/invocation authorizes both the module-backed resource and
  // the App operation. First-class employee credentials therefore always
  // carry the base module-read scope, while every App scope remains opt-in.
  const scopes: EmployeeMcpScope[] = ['read:modules', ...requestedAppScopes];
  const raw = params.rawToken ?? randomBytes(32).toString('base64url');
  if (raw.length < 16) throw new Error('issueScopedEmployeeMcpToken: token is too short');
  const prefix = raw.slice(0, 18);
  const tokenHash = await bcrypt.hash(raw, params.bcryptRounds ?? BCRYPT_ROUNDS);
  const now = new Date();

  return db.transaction(async (tx) => {
    const [employee] = await tx
      .select({ id: agentEmployees.id })
      .from(agentEmployees)
      .where(and(
        eq(agentEmployees.org_id, params.orgId),
        eq(agentEmployees.id, params.employeeId),
        eq(agentEmployees.is_deleted, false),
      ))
      .limit(1);
    if (!employee) {
      throw new Error(
        `issueScopedEmployeeMcpToken: no employee found for org ${params.orgId} id ${params.employeeId}`,
      );
    }

    if (params.revokeExisting) {
      await tx.update(mcpTokens).set({
        revoked_at: now,
        app_run_authorization_version: sql`${mcpTokens.app_run_authorization_version} + 1`,
        updated_at: now,
      }).where(and(
        eq(mcpTokens.org_id, params.orgId),
        eq(mcpTokens.agent_employee_id, params.employeeId),
        eq(mcpTokens.principal_kind, 'agent'),
        isNull(mcpTokens.revoked_at),
      ));
    }

    const [token] = await tx.insert(mcpTokens).values({
      org_id: params.orgId,
      agent_employee_id: params.employeeId,
      principal_kind: 'agent',
      name: params.name ?? 'Agent employee MCP token',
      token_hash: tokenHash,
      token_prefix: prefix,
      scopes,
      created_by: params.createdBy,
      created_at: now,
      updated_at: now,
    }).returning({ id: mcpTokens.id });
    if (!token) throw new Error('issueScopedEmployeeMcpToken: insert returned no row');

    await tx.update(agentEmployees).set({ mcp_token_hash: tokenHash })
      .where(and(
        eq(agentEmployees.org_id, params.orgId),
        eq(agentEmployees.id, params.employeeId),
      ));

    return Object.freeze({ raw, prefix, tokenId: token.id, tokenHash, scopes });
  });
}

/**
 * Generate a raw token, bcrypt-hash it, and write the hash into the
 * `agent_employees` row identified by (orgId, employeeId). Returns the raw
 * token exactly once.
 */
export async function issueEmployeeToken(
  orgId: string,
  employeeId: string,
  scopes: readonly EmployeeMcpAppScope[] = [],
): Promise<string> {
  return (await issueScopedEmployeeMcpToken({
    orgId,
    employeeId,
    scopes,
    revokeExisting: true,
  })).raw;
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

  const tokenCandidates = await db
      .select({
        id: mcpTokens.id,
        org_id: mcpTokens.org_id,
        user_id: mcpTokens.user_id,
        agent_employee_id: mcpTokens.agent_employee_id,
        principal_kind: mcpTokens.principal_kind,
        token_hash: mcpTokens.token_hash,
        scopes: mcpTokens.scopes,
        revoked_at: mcpTokens.revoked_at,
      })
      .from(mcpTokens)
      .where(eq(mcpTokens.token_prefix, bearer.slice(0, 18)));

  for (const row of tokenCandidates) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await bcrypt.compare(bearer, row.token_hash);
    if (!ok) continue;
    // A revoked first-class employee credential must never be resurrected by
    // the compatibility hash copied to agent_employees.
    if (row.revoked_at) throw new McpAuthError(401, 'unauthorized', 'Invalid bearer token');
    if (row.principal_kind === 'human' && row.user_id) {
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
    if (row.principal_kind === 'agent' && row.agent_employee_id) {
      const [employee] = await db.select({
        id: agentEmployees.id,
        slug: agentEmployees.slug,
        trust_level: agentEmployees.trust_level,
        disabled_tools: agentEmployees.disabled_tools,
        unhealthy: agentEmployees.unhealthy,
        unhealthy_reason: agentEmployees.unhealthy_reason,
      }).from(agentEmployees).where(and(
        eq(agentEmployees.org_id, row.org_id),
        eq(agentEmployees.id, row.agent_employee_id),
        eq(agentEmployees.is_active, true),
        eq(agentEmployees.is_deleted, false),
      )).limit(1);
      if (!employee) {
        throw new McpAuthError(403, 'forbidden', 'Agent employee is inactive or unavailable');
      }
      await db.update(mcpTokens).set({ last_used_at: new Date() }).where(eq(mcpTokens.id, row.id));
      return {
        kind: 'agent',
        token_id: row.id,
        org_id: row.org_id,
        scopes: row.scopes ?? [],
        gateway_employees: [{
          employee_id: employee.id,
          slug: employee.slug,
          trust_level: employee.trust_level as TrustLevel,
          disabled_tools: employee.disabled_tools ?? [],
          unhealthy: employee.unhealthy,
          unhealthy_reason: employee.unhealthy_reason,
        }],
      };
    }
    throw new McpAuthError(403, 'forbidden', 'MCP token principal is invalid');
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
  return { kind: 'agent', ...agent, scopes: [] };
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

/** Resolve the one employee authenticated by this bearer token. */
export function resolveAuthenticatedEmployee(resolved: ResolvedGateway): GatewayEmployee {
  if (resolved.gateway_employees.length !== 1) {
    throw new McpAuthError(
      403,
      'forbidden',
      'Agent employee bearer must resolve to exactly one employee',
    );
  }
  return resolved.gateway_employees[0]!;
}

/** Read the Authorization header and extract the bearer token value. */
export function extractBearer(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!m) return null;
  return m[1]!.trim();
}
