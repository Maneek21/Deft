import { createHash } from 'node:crypto';
import {
  APP_RUN_CONTRACT_VERSIONS,
  AppRunAuthorizationSnapshotSchema,
  CapabilityProviderDiscoverySnapshotSchema,
  canonicalCapabilityJson,
  type AppRunActor,
  type AppRunAuthorizationSnapshot,
  type AppRunPolicySnapshot,
} from '@deft/shared';
import {
  agentEmployees,
  appRuns,
  capabilityProviderSnapshots,
  mcpConnections,
  mcpTokens,
  mcpToolOverrides,
  oauthAccessTokens,
  orgMembers,
} from '@deft/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from './db.js';
import type { AppRunExecutionAuthorizer } from './app-run-authorization.js';
import type {
  AppRunSafeView,
  AppRunTransaction,
} from './app-run-repository.js';
import { canonicalMcpToolName, isMcpToolEnabled } from './mcp-tool-identity.js';

const HOST_POLICY_VERSION = 'deft.app_run.host_policy.v1';

type AuthorityRef = AppRunAuthorizationSnapshot['authority_refs'][number];
type TokenAuthority = Readonly<{
  token_kind: 'mcp' | 'oauth';
  token_id: string;
}>;

export type AppRunAuthorizationCapture = Readonly<{
  org_id: string;
  authenticated_subject: AppRunActor;
  execution_actor: AppRunActor;
  provider_instance_id: string;
  provider_snapshot_id: string;
  operation_name: string;
  policy: AppRunPolicySnapshot;
  required_token_scopes?: readonly string[];
  token_authorities?: readonly TokenAuthority[];
}>;

type InternalRunAuthorization = Readonly<{
  authorization_snapshot: Record<string, unknown>;
  provider_snapshot_id: string;
  budget_reserved_at: Date | null;
  budget_reserved_count: number | null;
  budget_limit_at_reservation: number | null;
}>;

function authorityVersion(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(`deft.app_run.authority.v1\0${domain}\0`)
    .update(canonicalCapabilityJson(value))
    .digest('hex')}`;
}

function actorIdentity(actor: AppRunActor): string {
  switch (actor.actor_type) {
    case 'human': return actor.user_id;
    case 'agent_employee': return actor.agent_employee_id;
    case 'system': return actor.system_id;
    case 'automation': return actor.automation_id;
  }
}

function runActor(type: AppRunSafeView['execution_actor_type'], id: string): AppRunActor {
  switch (type) {
    case 'human': return { actor_type: 'human', user_id: id };
    case 'agent_employee': return { actor_type: 'agent_employee', agent_employee_id: id };
    case 'system': return { actor_type: 'system', system_id: id };
    case 'automation': return { actor_type: 'automation', automation_id: id };
  }
}

function sameAuthorityRefs(
  left: readonly AuthorityRef[],
  right: readonly AuthorityRef[],
): boolean {
  const encode = (ref: AuthorityRef) => `${ref.authority_kind}\0${ref.authority_id}\0${ref.version}`;
  if (left.length !== right.length) return false;
  const expected = new Set(right.map(encode));
  return left.every((ref) => expected.has(encode(ref)));
}

/**
 * Host-owned authorization snapshot builder and live verifier for governed
 * Runs. Callers receive only opaque versions; live rows remain authoritative.
 */
export class PostgresAppRunLiveAuthorization implements AppRunExecutionAuthorizer {
  async capture(input: AppRunAuthorizationCapture): Promise<AppRunAuthorizationSnapshot> {
    return db.transaction((tx) => this.#capture(tx, input));
  }

  /** Read-only preparation gate for future effects. It captures the same live
   * authority vector as Run submission and additionally rejects an already
   * exhausted employee budget without reserving or consuming a slot. */
  async captureForPreparation(
    input: AppRunAuthorizationCapture,
  ): Promise<AppRunAuthorizationSnapshot> {
    return db.transaction(async (tx) => {
      const snapshot = await this.#capture(tx, input);
      if (input.execution_actor.actor_type === 'agent_employee' && input.policy.risk_class !== 'read') {
        const [available] = await tx.select({ id: agentEmployees.id }).from(agentEmployees).where(and(
          eq(agentEmployees.org_id, input.org_id),
          eq(agentEmployees.id, input.execution_actor.agent_employee_id),
          eq(agentEmployees.is_active, true),
          eq(agentEmployees.is_deleted, false),
          eq(agentEmployees.unhealthy, false),
          sql`${agentEmployees.daily_action_count} < ${agentEmployees.max_daily_actions}`,
        )).limit(1);
        if (!available) throw new Error('APP_RUN_AUTHORIZATION_STALE');
      }
      return snapshot;
    });
  }

  async authorizeApproval(input: Readonly<{
    org_id: string;
    run: AppRunSafeView;
  }>): Promise<boolean> {
    try {
      return await db.transaction(async (tx) => {
        const internal = await this.#loadInternalRun(tx, input.org_id, input.run.id);
        return internal !== null && await this.#matchesLiveState(tx, input.run, internal);
      });
    } catch {
      return false;
    }
  }

  async authorizeApprovalInTransaction(
    tx: AppRunTransaction,
    run: AppRunSafeView,
  ): Promise<boolean> {
    try {
      const internal = await this.#loadInternalRun(tx, run.org_id, run.id);
      return internal !== null && await this.#matchesLiveState(tx, run, internal);
    } catch {
      return false;
    }
  }

  async authorizeExecution(input: Parameters<AppRunExecutionAuthorizer['authorizeExecution']>[0]): Promise<boolean> {
    try {
      if (input.org_id !== input.run.org_id) return false;
      const internal = await this.#loadInternalRun(input.tx, input.org_id, input.run.id);
      if (!internal || !await this.#matchesLiveState(input.tx, input.run, internal)) return false;

      const reservesEmployeeBudget = input.run.execution_actor_type === 'agent_employee'
        && input.run.risk_class !== 'read';
      if (!reservesEmployeeBudget) {
        return internal.budget_reserved_at === null
          && internal.budget_reserved_count === null
          && internal.budget_limit_at_reservation === null;
      }

      if (input.stage !== 'prepare') {
        return internal.budget_reserved_at !== null
          && internal.budget_reserved_count === 1
          && internal.budget_limit_at_reservation !== null;
      }
      if (internal.budget_reserved_at !== null) {
        return internal.budget_reserved_count === 1
          && internal.budget_limit_at_reservation !== null;
      }

      const [reservation] = await input.tx
        .update(agentEmployees)
        .set({ daily_action_count: sql`${agentEmployees.daily_action_count} + 1` })
        .where(and(
          eq(agentEmployees.org_id, input.org_id),
          eq(agentEmployees.id, input.run.execution_actor_id),
          eq(agentEmployees.is_active, true),
          eq(agentEmployees.is_deleted, false),
          eq(agentEmployees.unhealthy, false),
          sql`${agentEmployees.daily_action_count} < ${agentEmployees.max_daily_actions}`,
        ))
        .returning({
          count: agentEmployees.daily_action_count,
          limit: agentEmployees.max_daily_actions,
        });
      if (!reservation) return false;

      const [recorded] = await input.tx.update(appRuns).set({
        budget_reserved_at: input.now,
        budget_reserved_count: 1,
        budget_limit_at_reservation: reservation.limit,
        updated_at: input.now,
      }).where(and(
        eq(appRuns.org_id, input.org_id),
        eq(appRuns.id, input.run.id),
        isNull(appRuns.budget_reserved_at),
      )).returning({ id: appRuns.id });
      return Boolean(recorded);
    } catch {
      return false;
    }
  }

  async #loadInternalRun(
    tx: AppRunTransaction,
    orgId: string,
    runId: string,
  ): Promise<InternalRunAuthorization | null> {
    const [row] = await tx.select({
      authorization_snapshot: appRuns.authorization_snapshot,
      provider_snapshot_id: appRuns.provider_snapshot_id,
      budget_reserved_at: appRuns.budget_reserved_at,
      budget_reserved_count: appRuns.budget_reserved_count,
      budget_limit_at_reservation: appRuns.budget_limit_at_reservation,
    }).from(appRuns).where(and(eq(appRuns.org_id, orgId), eq(appRuns.id, runId))).limit(1);
    return row ?? null;
  }

  async #matchesLiveState(
    tx: AppRunTransaction,
    run: AppRunSafeView,
    internal: InternalRunAuthorization,
  ): Promise<boolean> {
    const stored = AppRunAuthorizationSnapshotSchema.parse(internal.authorization_snapshot);
    if (
      stored.authenticated_subject.actor_type !== run.initiating_actor_type
      || actorIdentity(stored.authenticated_subject) !== run.initiating_actor_id
    ) return false;

    const tokenAuthorities = stored.authority_refs
      .filter((ref) => ref.authority_kind === 'token_scope')
      .map((ref) => ({ token_id: ref.authority_id }));
    const current = await this.#capture(tx, {
      org_id: run.org_id,
      authenticated_subject: stored.authenticated_subject,
      execution_actor: runActor(run.execution_actor_type, run.execution_actor_id),
      provider_instance_id: run.provider_instance_id,
      provider_snapshot_id: internal.provider_snapshot_id,
      operation_name: run.operation_name,
      policy: {
        risk_class: run.risk_class,
        review_requirement: run.review_requirement,
        review_scope: run.review_scope,
        retry_class: run.retry_class,
      },
      token_authorities: await Promise.all(tokenAuthorities.map(async ({ token_id }) => ({
        token_id,
        token_kind: await this.#tokenKind(tx, run.org_id, token_id),
      }))),
    });
    return sameAuthorityRefs(stored.authority_refs, current.authority_refs);
  }

  async #capture(
    tx: AppRunTransaction,
    input: AppRunAuthorizationCapture,
  ): Promise<AppRunAuthorizationSnapshot> {
    const refs = new Map<string, AuthorityRef>();
    const add = (ref: AuthorityRef): void => {
      refs.set(`${ref.authority_kind}\0${ref.authority_id}`, ref);
    };

    const employees = new Map<string, typeof agentEmployees.$inferSelect>();
    const captureActor = async (actor: AppRunActor, reserveBudgetAuthority: boolean): Promise<void> => {
      if (actor.actor_type === 'system' || actor.actor_type === 'automation') {
        throw new Error('APP_RUN_AUTHORIZATION_STALE');
      }
      if (actor.actor_type === 'human') {
        add(await this.#membership(tx, input.org_id, actor.user_id));
        return;
      }
      let employee = employees.get(actor.agent_employee_id);
      if (!employee) {
        employee = await this.#employee(tx, input.org_id, actor.agent_employee_id);
        employees.set(actor.agent_employee_id, employee);
        add(await this.#membership(tx, input.org_id, employee.user_id));
        add({
          authority_kind: 'employee_health',
          authority_id: employee.id,
          version: authorityVersion('employee_health', {
            id: employee.id,
            authority_version: employee.app_run_authorization_version,
          }),
        });
      }
      if (reserveBudgetAuthority) {
        add({
          authority_kind: 'employee_budget',
          authority_id: employee.id,
          version: authorityVersion('employee_budget', {
            id: employee.id,
            authority_version: employee.app_run_authorization_version,
          }),
        });
      }
    };

    await captureActor(input.authenticated_subject, false);
    await captureActor(
      input.execution_actor,
      input.execution_actor.actor_type === 'agent_employee' && input.policy.risk_class !== 'read',
    );

    const [connection] = await tx.select().from(mcpConnections).where(and(
      eq(mcpConnections.org_id, input.org_id),
      eq(mcpConnections.id, input.provider_instance_id),
      eq(mcpConnections.is_active, true),
    )).limit(1);
    if (!connection || !isMcpToolEnabled(connection.enabled_tools, connection.slug, input.operation_name)) {
      throw new Error('APP_RUN_AUTHORIZATION_STALE');
    }
    const overrideRows = await tx.select().from(mcpToolOverrides).where(and(
      eq(mcpToolOverrides.org_id, input.org_id),
      eq(mcpToolOverrides.mcp_connection_id, connection.id),
    ));
    const operationOverrides = overrideRows.filter(
      (row) => canonicalMcpToolName(row.tool_name) === input.operation_name,
    );
    if (operationOverrides.some((row) => row.is_disabled)) {
      throw new Error('APP_RUN_AUTHORIZATION_STALE');
    }
    add({
      authority_kind: 'connector',
      authority_id: connection.id,
      version: authorityVersion('connector', {
        id: connection.id,
        authority_version: connection.app_run_authorization_version,
        overrides: operationOverrides
          .map((row) => ({
            id: row.id,
            authority_version: row.app_run_authorization_version,
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      }),
    });

    if (input.execution_actor.actor_type === 'agent_employee') {
      const employee = employees.get(input.execution_actor.agent_employee_id)!;
      if (!(employee.mcp_connection_ids ?? []).includes(connection.id)) {
        throw new Error('APP_RUN_AUTHORIZATION_STALE');
      }
      if ((employee.disabled_tools ?? []).some(
        (name) => canonicalMcpToolName(name) === input.operation_name,
      )) throw new Error('APP_RUN_AUTHORIZATION_STALE');
      add({
        authority_kind: 'assignment',
        authority_id: `${employee.id}:${connection.id}`,
        version: authorityVersion('assignment', {
          employee_id: employee.id,
          connection_id: connection.id,
          employee_authority_version: employee.app_run_authorization_version,
          connector_authority_version: connection.app_run_authorization_version,
        }),
      });
    }

    const [snapshotRow] = await tx.select().from(capabilityProviderSnapshots).where(and(
      eq(capabilityProviderSnapshots.org_id, input.org_id),
      eq(capabilityProviderSnapshots.id, input.provider_snapshot_id),
      eq(capabilityProviderSnapshots.provider_kind, 'mcp'),
      eq(capabilityProviderSnapshots.provider_instance_id, connection.id),
    )).limit(1);
    if (!snapshotRow) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    const snapshot = CapabilityProviderDiscoverySnapshotSchema.parse(snapshotRow.safe_snapshot);
    if (
      snapshot.snapshot_digest !== snapshotRow.snapshot_digest
      || snapshot.adapter_contract_version !== snapshotRow.adapter_contract_version
    ) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    const operation = snapshot.operations.find(
      (candidate) => candidate.identity.operation_name === input.operation_name,
    );
    if (!operation) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    add({
      authority_kind: 'provider_schema',
      authority_id: `${connection.id}:${input.operation_name}`,
      version: authorityVersion('provider_schema', {
        snapshot_id: snapshotRow.id,
        snapshot_digest: snapshotRow.snapshot_digest,
        adapter_contract_version: snapshotRow.adapter_contract_version,
        schema_digest: operation.schema_digest,
      }),
    });
    add({
      authority_kind: 'policy',
      authority_id: `${connection.id}:${input.operation_name}`,
      version: authorityVersion('policy', {
        host_policy_version: HOST_POLICY_VERSION,
        policy: input.policy,
      }),
    });

    for (const token of input.token_authorities ?? []) {
      add(await this.#tokenAuthority(tx, input, token));
    }

    return AppRunAuthorizationSnapshotSchema.parse({
      schema_version: APP_RUN_CONTRACT_VERSIONS.run,
      authenticated_subject: input.authenticated_subject,
      authority_refs: [...refs.values()].sort((left, right) => {
        const leftKey = `${left.authority_kind}\0${left.authority_id}`;
        const rightKey = `${right.authority_kind}\0${right.authority_id}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
    });
  }

  async #membership(tx: AppRunTransaction, orgId: string, userId: string): Promise<AuthorityRef> {
    const [membership] = await tx.select().from(orgMembers).where(and(
      eq(orgMembers.org_id, orgId),
      eq(orgMembers.user_id, userId),
      eq(orgMembers.is_active, true),
    )).limit(1);
    if (!membership) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    return {
      authority_kind: 'membership',
      authority_id: userId,
      version: authorityVersion('membership', {
        id: membership.id,
        authority_version: membership.app_run_authorization_version,
      }),
    };
  }

  async #employee(tx: AppRunTransaction, orgId: string, employeeId: string) {
    const [employee] = await tx.select().from(agentEmployees).where(and(
      eq(agentEmployees.org_id, orgId),
      eq(agentEmployees.id, employeeId),
      eq(agentEmployees.is_active, true),
      eq(agentEmployees.is_deleted, false),
      eq(agentEmployees.unhealthy, false),
    )).limit(1);
    if (!employee) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    return employee;
  }

  async #tokenKind(
    tx: AppRunTransaction,
    orgId: string,
    tokenId: string,
  ): Promise<TokenAuthority['token_kind']> {
    const [mcp] = await tx.select({ id: mcpTokens.id }).from(mcpTokens).where(and(
      eq(mcpTokens.org_id, orgId), eq(mcpTokens.id, tokenId),
    )).limit(1);
    if (mcp) return 'mcp';
    const [oauth] = await tx.select({ id: oauthAccessTokens.id }).from(oauthAccessTokens).where(and(
      eq(oauthAccessTokens.org_id, orgId), eq(oauthAccessTokens.id, tokenId),
    )).limit(1);
    if (oauth) return 'oauth';
    throw new Error('APP_RUN_AUTHORIZATION_STALE');
  }

  async #tokenAuthority(
    tx: AppRunTransaction,
    input: AppRunAuthorizationCapture,
    token: TokenAuthority,
  ): Promise<AuthorityRef> {
    if (token.token_kind === 'mcp') {
      const [row] = await tx.select().from(mcpTokens).where(and(
        eq(mcpTokens.org_id, input.org_id),
        eq(mcpTokens.id, token.token_id),
        isNull(mcpTokens.revoked_at),
      )).limit(1);
      if (!row) throw new Error('APP_RUN_AUTHORIZATION_STALE');
      if ((input.required_token_scopes ?? []).some((scope) => !row.scopes.includes(scope))) {
        throw new Error('APP_RUN_AUTHORIZATION_STALE');
      }
      const subjectMatches = input.authenticated_subject.actor_type === 'human'
        ? row.principal_kind === 'human' && row.user_id === input.authenticated_subject.user_id
        : input.authenticated_subject.actor_type === 'agent_employee'
          && row.principal_kind === 'agent'
          && row.agent_employee_id === input.authenticated_subject.agent_employee_id;
      if (!subjectMatches) throw new Error('APP_RUN_AUTHORIZATION_STALE');
      return {
        authority_kind: 'token_scope',
        authority_id: row.id,
        version: authorityVersion('mcp_token_scope', {
          id: row.id,
          authority_version: row.app_run_authorization_version,
        }),
      };
    }

    if (input.authenticated_subject.actor_type !== 'human') {
      throw new Error('APP_RUN_AUTHORIZATION_STALE');
    }
    const [row] = await tx.select().from(oauthAccessTokens).where(and(
      eq(oauthAccessTokens.org_id, input.org_id),
      eq(oauthAccessTokens.id, token.token_id),
      eq(oauthAccessTokens.user_id, input.authenticated_subject.user_id),
      isNull(oauthAccessTokens.revoked_at),
      sql`${oauthAccessTokens.expires_at} > now()`,
    )).limit(1);
    if (!row) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    if ((input.required_token_scopes ?? []).some((scope) => !row.scopes.includes(scope))) {
      throw new Error('APP_RUN_AUTHORIZATION_STALE');
    }
    return {
      authority_kind: 'token_scope',
      authority_id: row.id,
      version: authorityVersion('oauth_token_scope', {
        id: row.id,
        authority_version: row.app_run_authorization_version,
      }),
    };
  }
}
