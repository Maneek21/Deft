import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { agentEmployees, agentMcpCallAudit, oauthAuditEvents, auditLog, mcpTokens, orgMembers, users, appResourceProjections } from '@deft/db/schema';
import { canonicalCapabilityJson } from '@deft/shared';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import type { AppRunTransaction } from './app-run-repository.js';
import { AppResourceSyncSecretService } from './app-resource-sync-secrets.js';
import { loadLockedPrivateAccessParent, privateAccessParentGateIsCurrent } from './app-private-access-parent.js';
import { decodePrivateProjection } from './app-resource-private-projection.js';
import { privateSearchDatabase } from './app-resource-private-search-db.js';
import { ACCESS_LIMITS, HumanAccessAccept, accessUnavailable, PrivateResourceAccessError } from './app-resource-access-contract.js';
import type { AccessCaller } from './app-resource-access-service.js';
import { PRIVATE_MCP_GRANT_MS, PrivateMcpGrantSnapshot, PrivateMcpReviewInput, PrivateMcpReviewResponse, PrivateMcpCitationPayload, PrivateMcpSearchCursor, PrivateMcpSearchInput, PrivateMcpInventoryInput, PrivateMcpInventoryCursor, encodePrivateMcpToolResult, type PrivateMcpSnapshot } from './app-private-mcp-contract.js';
import { privateMcpEnabled, requirePrivateMcpInvocation, finalPrivateMcpCredential } from './app-private-mcp-authority.js';
import type { PrivateMcpInvocation, FirstClassMcpAuthentication } from './mcp-token.js';
import { assertPrivateAccessAdmission } from './app-private-access-admission.js';
import { samplePrivateAccessClock, type PrivateAccessClock } from './app-private-access-clock.js';

type Tx = AppRunTransaction;
type Parent = Awaited<ReturnType<typeof loadLockedPrivateAccessParent>>;
type GrantRow = {
  id: string; org_id: string; owner_user_id: string; subject_user_id: string; mcp_token_id: string;
  app_installation_id: string; resource_binding_id: string; checkpoint_id: string; projection_id: string;
  snapshot: unknown; review_digest: string; expires_at: Date; revoked_at: Date | null; accepted_sequence: string;
};
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalCapabilityJson(value)).digest('hex')}`;
const custodyNotice = 'Anyone holding this exact credential may receive these fields in an external MCP client. Revocation stops future Deft access and cannot recall copies already delivered.' as const;

/** Independent MCP purpose. Human grants and Worker consent are never inputs. */
export class AppPrivateMcpService {
  readonly secrets: AppResourceSyncSecretService;
  private readonly clocks = new WeakMap<Tx, PrivateAccessClock>();
  private current(tx: Tx) { const clock = this.clocks.get(tx); if (!clock) throw accessUnavailable(); return clock.current(); }
  private issuance(tx: Tx) { const clock = this.clocks.get(tx); if (!clock) throw accessUnavailable(); return clock.issuance(); }
  private deadline(tx: Tx, expires: Date) { const clock = this.clocks.get(tx); if (!clock) throw accessUnavailable(); return clock.bindDeadline(expires); }
  constructor(private readonly keys: AppRunKeyProvider, private readonly clock: () => Date = () => new Date()) {
    this.secrets = new AppResourceSyncSecretService(keys);
  }

  private seal(value: unknown, purpose: 'review' | 'citation' | 'search' | 'inventory') {
    const key = this.keys.current('fingerprint');
    try {
      const body = Buffer.from(canonicalCapabilityJson({ key_version: key.key_id, value })).toString('base64url');
      const mac = createHmac('sha256', key.key).update(`deft.app_private_mcp.${purpose}.v1\0`).update(body).digest('base64url');
      return `${body}.${mac}`;
    } finally { key.key.fill(0); }
  }

  private open(token: string, purpose: 'review' | 'citation' | 'search' | 'inventory'): unknown {
    try {
      const [body, mac, ...extra] = token.split('.');
      if (!body || !mac || extra.length) throw accessUnavailable();
      const envelope = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      const key = this.keys.read('fingerprint', envelope.key_version);
      if (!key) throw accessUnavailable();
      try {
        const expected = createHmac('sha256', key.key).update(`deft.app_private_mcp.${purpose}.v1\0`).update(body).digest();
        const actual = Buffer.from(mac, 'base64url');
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw accessUnavailable();
        return envelope.value as unknown;
      } finally { key.key.fill(0); }
    } catch { throw accessUnavailable(); }
  }

  private async run<T>(signal: AbortSignal | undefined, work: (tx: Tx) => Promise<T>, deadline = performance.now() + 3000, allowDisabled = false) {
    if (!allowDisabled && !privateMcpEnabled()) throw accessUnavailable();
    let localClock: PrivateAccessClock | undefined;
    const result = await privateSearchDatabase().transaction(async tx => {
      localClock = await samplePrivateAccessClock(tx, this.clock);
      this.clocks.set(tx, localClock);
      try { return await work(tx); }
      finally { this.clocks.delete(tx); }
    }, signal, deadline);
    signal?.throwIfAborted();
    if (localClock?.expired()) throw accessUnavailable();
    if (!allowDisabled && !privateMcpEnabled()) throw accessUnavailable();
    return result;
  }

  private async destination(tx: Tx, org: string, destination: PrivateMcpSnapshot['destination']) {
    const [token] = await tx.select().from(mcpTokens).where(and(eq(mcpTokens.org_id, org), eq(mcpTokens.id, destination.token_id))).limit(1);
    if (!token || token.revoked_at || !token.scopes.includes('read:app-private-resources')) throw accessUnavailable();
    const employee = token.agent_employee_id ? (await tx.select().from(agentEmployees).where(and(eq(agentEmployees.org_id, org), eq(agentEmployees.id, token.agent_employee_id))).limit(1))[0] : null;
    if (destination.kind === 'personal_mcp' ? token.principal_kind !== 'human' || !token.user_id || token.agent_employee_id
      : token.principal_kind !== 'agent' || token.user_id || !employee || !employee.is_active || employee.is_deleted || employee.unhealthy) throw accessUnavailable();
    const subject = destination.kind === 'personal_mcp' ? token.user_id! : employee!.user_id;
    return { token, employee, subject };
  }

  private async members(tx: Tx, org: string, owner: string, subject: string, operator: string, write: boolean, kind: 'personal_mcp' | 'employee_mcp', requireLive = true) {
    for (const id of [...new Set([owner, subject, operator])].sort()) {
      await tx.execute(write && (id === owner || id === subject)
        ? sql`SELECT id FROM org_members WHERE org_id=${org} AND user_id=${id} FOR UPDATE`
        : sql`SELECT id FROM org_members WHERE org_id=${org} AND user_id=${id} FOR SHARE`);
    }
    if (!requireLive) return;
    await this.freshMembers(tx, org, owner, subject, operator, kind);
  }

  private async freshMembers(tx: Tx, org: string, owner: string, subject: string, operator: string, kind: 'personal_mcp' | 'employee_mcp') {
    const rows = await tx.select({ id: users.id, kind: users.kind, active: orgMembers.is_active, role: orgMembers.role })
      .from(orgMembers).innerJoin(users, eq(users.id, orgMembers.user_id))
      .where(and(eq(orgMembers.org_id, org), inArray(orgMembers.user_id, [...new Set([owner, subject, operator])])));
    for (const id of [...new Set([owner, subject, operator])]) {
      const row = rows.find(value => value.id === id);
      const expected = id === subject && kind === 'employee_mcp' ? 'agent' : 'human';
      if (!row?.active || row.role === 'guest' || row.kind !== expected) throw accessUnavailable();
    }
  }

  private pins(parent: Parent) {
    if (!parent.record) throw accessUnavailable();
    const { authority: a, checkpoint: p, record } = parent;
    return {
      app_installation_id: a.installation.id, app_version_id: a.version.id, grant_snapshot_id: a.grant.id,
      lifecycle_epoch: a.installation.lifecycle_epoch, grant_epoch: a.installation.grant_epoch,
      registration_id: a.registration.id, operator_user_id: a.registration.operator_user_id, runtime_epoch: a.registration.runtime_epoch,
      resource_binding_id: a.binding.id, descriptor_digest: a.descriptor_digest, checkpoint_id: p.id, generation: p.generation,
      revision_digest: digest({ revision: record.revision }), content_digest: digest({ revision: record.revision, data: record.data }),
    };
  }

  private async parent(tx: Tx, org: string, ref: PrivateMcpSnapshot['ref'], target: Awaited<ReturnType<AppPrivateMcpService['destination']>>, kind: PrivateMcpSnapshot['destination']['kind'], write: boolean, signal?: AbortSignal, decrypt = true) {
    return loadLockedPrivateAccessParent({ tx, orgId: org, ref, recipient: target.subject, clock: () => this.current(tx), secrets: this.secrets, signal, decrypt,
      lockParticipants: async (owner, subject, operator) => {
        await this.members(tx, org, owner, subject, operator, write, kind);
        if (target.employee) await tx.execute(sql`SELECT id FROM agent_employees WHERE org_id=${org} AND id=${target.employee.id} FOR SHARE`);
        // Revalidate the locator BEFORE proceeding into any parent lock.
        const current = await this.destination(tx, org, { kind, token_id: target.token.id });
        if (current.subject !== target.subject || current.employee?.id !== target.employee?.id) throw accessUnavailable();
      },
    });
  }

  private async credentialPins(tx: Tx, org: string, destination: PrivateMcpSnapshot['destination']) {
    await tx.execute(sql`SELECT id FROM mcp_tokens WHERE org_id=${org} AND id=${destination.token_id} FOR SHARE`);
    const target = await this.destination(tx, org, destination);
    const [subject] = await tx.select({ name: users.name, version: orgMembers.app_run_authorization_version }).from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.user_id)).where(and(eq(orgMembers.org_id, org), eq(orgMembers.user_id, target.subject))).limit(1);
    if (!subject) throw accessUnavailable();
    return {
      subject_user_id: target.subject, employee_id: target.employee?.id ?? null,
      token_authorization_version: target.token.app_run_authorization_version,
      token_hash_digest: createHash('sha256').update(target.token.token_hash).digest('hex'), scope_digest: digest([...target.token.scopes].sort()),
      subject_membership_authorization_version: subject.version, employee_authorization_version: target.employee?.app_run_authorization_version ?? null,
      token_label: target.token.name.slice(0, 200), subject_label: subject.name.slice(0, 200),
    };
  }

  private async ownerFinal(tx: Tx, c: AccessCaller, participants: readonly string[], expires: Date, kind: 'personal_mcp' | 'employee_mcp', allowDisabled = false, parent?: Parent) {
    await c.guard(tx);
    this.deadline(tx, new Date(Math.min(expires.getTime(), c.guard.current_web_session_expires_at().getTime())));
    if (!allowDisabled) await this.freshMembers(tx, c.org_id, participants[0]!, participants[1]!, participants[2]!, kind);
    const rows = await tx.select({ id: users.id, kind: users.kind, active: orgMembers.is_active, role: orgMembers.role }).from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.user_id)).where(and(eq(orgMembers.org_id, c.org_id), inArray(orgMembers.user_id, [...new Set(participants)])));
    if (!rows.some(row => row.id === c.user_id && row.kind === 'human' && row.active && row.role !== 'guest')
      || (!allowDisabled && !privateMcpEnabled()) || parent && !privateAccessParentGateIsCurrent(parent) || expires <= this.current(tx) || c.guard.current_web_session_expires_at() <= this.current(tx)) throw accessUnavailable();
  }

  private async auditMcpTool(tx: Tx, stamp: FirstClassMcpAuthentication, tool: string, grantId: string) {
    const metadata = { token_id: stamp.token_id, grant_id: grantId, purpose: 'mcp_private_context' };
    if (stamp.employee_id) {
      await tx.insert(agentMcpCallAudit).values({ org_id: stamp.org_id, employee_id: stamp.employee_id, tool_name: tool, success: true, metadata });
    } else {
      await tx.insert(oauthAuditEvents).values({ org_id: stamp.org_id, user_id: stamp.user_id, client_id: `personal-token:${stamp.token_id}`, event: 'mcp_tool_call', metadata: { ...metadata, tool_name: tool, success: true, principal_kind: 'human' } });
    }
  }

  async prepare(c: AccessCaller, raw: unknown, signal?: AbortSignal) {
    const input = PrivateMcpReviewInput.parse(raw);
    return this.run(signal, async tx => {
      const target = await this.destination(tx, c.org_id, input.destination);
      const parent = await this.parent(tx, c.org_id, input.ref, target, input.destination.kind, false, signal);
      if (parent.authority.binding.owner_user_id !== c.user_id) throw accessUnavailable();
      const fields = [...input.field_keys].sort();
      if (fields.some(field => !Object.hasOwn(parent.authority.descriptor.record_schema.properties, field) || !Object.hasOwn(parent.record!.data, field))) throw accessUnavailable();
      const now = this.issuance(tx);
      const expires = new Date(Math.min(Date.parse(input.expires_at), now.getTime() + PRIVATE_MCP_GRANT_MS, parent.authority.binding.consent_expires_at!.getTime()));
      const snapshot = PrivateMcpGrantSnapshot.parse({
        schema_version: 'deft.app_private_mcp_snapshot.v1', purpose: 'mcp_private_context', org_id: c.org_id, owner_user_id: c.user_id,
        destination: input.destination, ...this.pins(parent), ...await this.credentialPins(tx, c.org_id, input.destination), ref: input.ref,
        operations: input.operations, field_keys: fields, app_label: String((parent.authority.version.manifest as Record<string, unknown>).name ?? parent.authority.installation.app_id).slice(0, 200),
        expires_at: expires.toISOString(), review_expires_at: new Date(Math.min(expires.getTime(), now.getTime() + ACCESS_LIMITS.review_ms)).toISOString(),
      });
      const selected = Object.fromEntries(fields.map(field => [field, parent.record!.data[field]!]));
      encodePrivateMcpToolResult({ schema_version: 'deft.app_private_mcp_record.v1', grant_id: randomUUID(), label: 'Private App record', data: selected, freshness: 'unknown', expires_at: snapshot.expires_at });
      const result = PrivateMcpReviewResponse.parse({ snapshot, selected_data: selected, custody_notice: custodyNotice, review_digest: digest(snapshot), review_token: this.seal(snapshot, 'review') });
      if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw new PrivateResourceAccessError('APP_RESOURCE_ACCESS_TOO_LARGE', 413);
      await this.ownerFinal(tx, c, parent.participants, expires, input.destination.kind, false, parent);
      return result;
    });
  }

  private grantRow(raw: unknown): GrantRow | undefined {
    if (!raw) return undefined;
    const row = raw as GrantRow;
    const expires = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at as unknown as string);
    const revoked = row.revoked_at === null ? null : row.revoked_at instanceof Date ? row.revoked_at : new Date(row.revoked_at as unknown as string);
    if (Number.isNaN(expires.getTime()) || revoked && Number.isNaN(revoked.getTime())) throw accessUnavailable();
    return { ...row, expires_at: expires, revoked_at: revoked };
  }

  private stored(row: GrantRow) {
    const snapshot = PrivateMcpGrantSnapshot.parse(row.snapshot);
    if (digest(snapshot) !== row.review_digest || snapshot.expires_at !== row.expires_at.toISOString()
      || snapshot.org_id !== row.org_id || snapshot.owner_user_id !== row.owner_user_id
      || snapshot.subject_user_id !== row.subject_user_id || snapshot.destination.token_id !== row.mcp_token_id
      || snapshot.app_installation_id !== row.app_installation_id || snapshot.resource_binding_id !== row.resource_binding_id
      || snapshot.checkpoint_id !== row.checkpoint_id || snapshot.ref.resource_id !== row.projection_id) throw accessUnavailable();
    return snapshot;
  }

  async accept(c: AccessCaller, raw: unknown, signal?: AbortSignal) {
    const input = HumanAccessAccept.parse(raw);
    const snapshot = PrivateMcpGrantSnapshot.parse(this.open(input.review_token, 'review'));
    if (snapshot.org_id !== c.org_id || snapshot.owner_user_id !== c.user_id || digest(snapshot) !== input.review_digest) throw accessUnavailable();
    return this.run(signal, async tx => {
      const target = await this.destination(tx, c.org_id, snapshot.destination);
      const parent = await this.parent(tx, c.org_id, snapshot.ref, target, snapshot.destination.kind, true, signal);
      const pins = { ...this.pins(parent), ...await this.credentialPins(tx, c.org_id, snapshot.destination) };
      if (digest(pins) !== digest(Object.fromEntries(Object.keys(pins).map(key => [key, snapshot[key as keyof PrivateMcpSnapshot]])))) throw new PrivateResourceAccessError('APP_RESOURCE_ACCESS_STALE', 409);
      const expires = new Date(Math.min(Date.parse(snapshot.review_expires_at), Date.parse(snapshot.expires_at), parent.authority.binding.consent_expires_at!.getTime()));
      const prior = this.grantRow((await tx.execute(sql`SELECT * FROM app_private_mcp_grants WHERE org_id=${c.org_id} AND owner_user_id=${c.user_id} AND review_digest=${input.review_digest} LIMIT 1`)).rows[0]);
      if (prior) {
        if (prior.revoked_at) throw accessUnavailable();
        this.stored(prior);
        await this.ownerFinal(tx, c, parent.participants, expires, snapshot.destination.kind, false, parent);
        return { grant_id: prior.id, expires_at: snapshot.expires_at };
      }
      await assertPrivateAccessAdmission(tx, c.org_id, c.user_id, snapshot.app_installation_id, snapshot.subject_user_id);
      const id = randomUUID();
      await tx.execute(sql`INSERT INTO app_private_mcp_grants(id,org_id,owner_user_id,subject_user_id,mcp_token_id,app_installation_id,resource_binding_id,checkpoint_id,projection_id,review_digest,snapshot,accepted_at,expires_at) VALUES(${id},${c.org_id},${c.user_id},${snapshot.subject_user_id},${snapshot.destination.token_id},${snapshot.app_installation_id},${snapshot.resource_binding_id},${snapshot.checkpoint_id},${snapshot.ref.resource_id},${input.review_digest},${JSON.stringify(snapshot)}::jsonb,clock_timestamp(),${snapshot.expires_at}::timestamptz)`);
      await tx.insert(auditLog).values({ org_id: c.org_id, actor_type: 'user', actor_id: c.user_id, action: 'app_private_mcp.accept', entity_type: 'app_private_mcp_grant', entity_id: id, metadata: { review_digest: input.review_digest, destination_kind: snapshot.destination.kind } });
      // Exact review, binding and owner SID deadlines must survive awaited writes.
      const finalPins = await this.credentialPins(tx, c.org_id, snapshot.destination);
      if (digest(finalPins) !== digest(Object.fromEntries(Object.keys(finalPins).map(key => [key, snapshot[key as keyof PrivateMcpSnapshot]])))) throw accessUnavailable();
      await this.ownerFinal(tx, c, parent.participants, expires, snapshot.destination.kind, false, parent);
      return { grant_id: id, expires_at: snapshot.expires_at };
    });
  }

  async read(invocation: PrivateMcpInvocation, id: string, operation: 'read' | 'cite' = 'read', citation?: { scope_digest: string; expires_at: string }) {
    const call = requirePrivateMcpInvocation(invocation);
    const stamp = call.authentication;
    return this.run(call.signal, async tx => {
      const row = this.grantRow((await tx.execute(sql`SELECT * FROM app_private_mcp_grants WHERE org_id=${stamp.org_id} AND id=${id} AND mcp_token_id=${stamp.token_id} LIMIT 1`)).rows[0]);
      if (!row || row.revoked_at) throw accessUnavailable();
      if (citation && citation.scope_digest !== digest({ token: stamp.token_id, grant: row.review_digest })) throw accessUnavailable();
      const snapshot = this.stored(row);
      if (!snapshot.operations.includes(operation) || snapshot.destination.token_id !== stamp.token_id || snapshot.org_id !== stamp.org_id || snapshot.subject_user_id !== stamp.user_id
        || snapshot.employee_id !== stamp.employee_id || snapshot.token_authorization_version !== stamp.token_authorization_version
        || snapshot.token_hash_digest !== stamp.token_hash_digest || snapshot.scope_digest !== digest(stamp.scopes)
        || snapshot.subject_membership_authorization_version !== stamp.membership_authorization_version
        || snapshot.employee_authorization_version !== stamp.employee_authorization_version) throw accessUnavailable();
      const target = await this.destination(tx, stamp.org_id, snapshot.destination);
      const parent = await this.parent(tx, stamp.org_id, snapshot.ref, target, snapshot.destination.kind, false, call.signal, false);
      await tx.execute(sql`SELECT id FROM app_private_mcp_grants WHERE org_id=${stamp.org_id} AND id=${id} FOR SHARE`);
      const current = this.grantRow((await tx.execute(sql`SELECT * FROM app_private_mcp_grants WHERE org_id=${stamp.org_id} AND id=${id}`)).rows[0]);
      if (!current || current.revoked_at || current.review_digest !== row.review_digest) throw accessUnavailable();
      this.stored(current);
      const deadline = new Date(Math.min(current.expires_at.getTime(), parent.authority.binding.consent_expires_at!.getTime(), citation ? Date.parse(citation.expires_at) : Infinity));
      const tool = operation === 'read' ? 'app_private_resource_read' : 'app_private_resource_cite';
      await finalPrivateMcpCredential(tx, invocation, tool, deadline, this.deadline(tx, deadline));
      if (!privateAccessParentGateIsCurrent(parent)) throw accessUnavailable();
      call.signal.throwIfAborted();
      const record = decodePrivateProjection(this.secrets, parent.row, parent.authority.descriptor);
      const pins = this.pins({ ...parent, record });
      if (digest(pins) !== digest(Object.fromEntries(Object.keys(pins).map(key => [key, snapshot[key as keyof PrivateMcpSnapshot]])))) throw accessUnavailable();
      const result = operation === 'read'
        ? encodePrivateMcpToolResult({ schema_version: 'deft.app_private_mcp_record.v1', grant_id: id, label: 'Private App record', data: Object.fromEntries(snapshot.field_keys.map(field => [field, record.data[field]!])), freshness: 'unknown', expires_at: current.expires_at.toISOString() })
        : encodePrivateMcpToolResult({ schema_version: 'deft.app_private_mcp_citation.v1', citation_token: this.seal({ grant_id: id, scope_digest: digest({ token: stamp.token_id, grant: current.review_digest }), expires_at: current.expires_at.toISOString() }, 'citation'), label: 'Private App record', freshness: 'unknown', expires_at: current.expires_at.toISOString() });
      await tx.insert(auditLog).values({ org_id: stamp.org_id, actor_type: stamp.principal_kind === 'agent' ? 'agent' : 'user', actor_id: stamp.employee_id ?? stamp.user_id, action: `app_private_mcp.${operation}`, entity_type: 'app_private_mcp_grant', entity_id: id, metadata: { token_id: stamp.token_id, decision: 'allowed' } });
      // Audit in this transaction; the route must perform no later audit await
      // after receiving the private result. Never persist args/body/client _meta.
      if (stamp.employee_id) {
        await tx.insert(agentMcpCallAudit).values({ org_id: stamp.org_id, employee_id: stamp.employee_id, tool_name: tool, success: true, metadata: { token_id: stamp.token_id, grant_id: id, purpose: 'mcp_private_context' } });
      } else {
        await tx.insert(oauthAuditEvents).values({ org_id: stamp.org_id, user_id: stamp.user_id, client_id: `personal-token:${stamp.token_id}`, event: 'mcp_tool_call', metadata: { tool_name: tool, success: true, token_id: stamp.token_id, grant_id: id, principal_kind: 'human', purpose: 'mcp_private_context' } });
      }
      await this.freshMembers(tx, stamp.org_id, parent.participants[0]!, target.subject, parent.participants[2]!, snapshot.destination.kind);
      await finalPrivateMcpCredential(tx, invocation, tool, deadline, this.deadline(tx, deadline));
      if (!privateAccessParentGateIsCurrent(parent)) throw accessUnavailable();
      return result;
    }, call.deadline);
  }

  async readCitation(invocation: PrivateMcpInvocation, token: string) {
    const citation = PrivateMcpCitationPayload.parse(this.open(token, 'citation'));
    if (Date.parse(citation.expires_at) <= this.clock().getTime()) throw accessUnavailable();
    return this.read(invocation, citation.grant_id, 'read', citation);
  }

  async search(invocation: PrivateMcpInvocation, raw: unknown) {
    const input = PrivateMcpSearchInput.parse(raw);
    const fields = [...input.field_keys].sort();
    const cursor = input.cursor ? PrivateMcpSearchCursor.parse(this.open(input.cursor, 'search')) : null;
    const call = requirePrivateMcpInvocation(invocation), stamp = call.authentication;
    if (cursor && Date.parse(cursor.expires_at) <= this.clock().getTime()) throw accessUnavailable();
    return this.run(call.signal, async tx => {
      const anchor = this.grantRow((await tx.execute(sql`SELECT * FROM app_private_mcp_grants WHERE org_id=${stamp.org_id} AND mcp_token_id=${stamp.token_id} AND id=${input.grant_id} LIMIT 1`)).rows[0]);
      if (!anchor || anchor.revoked_at || anchor.expires_at <= this.current(tx)) throw accessUnavailable();
      const scope = this.stored(anchor);
      if (!scope.operations.includes('search') || fields.some(field => !scope.field_keys.includes(field))
        || scope.subject_user_id !== stamp.user_id || scope.employee_id !== stamp.employee_id
        || scope.token_authorization_version !== stamp.token_authorization_version || scope.token_hash_digest !== stamp.token_hash_digest
        || scope.scope_digest !== digest(stamp.scopes) || scope.subject_membership_authorization_version !== stamp.membership_authorization_version
        || scope.employee_authorization_version !== stamp.employee_authorization_version) throw accessUnavailable();
      const identity = digest({ org: stamp.org_id, token: stamp.token_id, subject: stamp.user_id, employee: stamp.employee_id,
        token_version: stamp.token_authorization_version, token_hash: stamp.token_hash_digest, scopes: stamp.scopes,
        anchor: anchor.id, grant: anchor.review_digest, query: input.query, fields });
      if (cursor && cursor.scope_digest !== identity) throw accessUnavailable();
      const target = await this.destination(tx, stamp.org_id, scope.destination);
      await this.members(tx, stamp.org_id, scope.owner_user_id, target.subject, scope.operator_user_id, false, scope.destination.kind);
      const cutoff = cursor?.cutoff ?? String((await tx.execute(sql`SELECT coalesce(max(accepted_sequence),0)::text AS value FROM app_private_mcp_grants WHERE org_id=${stamp.org_id} AND subject_user_id=${target.subject}`)).rows[0]?.value ?? '0');
      const rows = (await tx.execute(sql`SELECT * FROM app_private_mcp_grants WHERE org_id=${stamp.org_id} AND mcp_token_id=${stamp.token_id} AND resource_binding_id=${scope.resource_binding_id} AND accepted_sequence>${cursor?.after ?? '0'}::bigint AND accepted_sequence<=${cutoff}::bigint ORDER BY accepted_sequence LIMIT 100`)).rows.map(row => this.grantRow(row)!);
      const snapshots = rows.map(row => this.stored(row));
      if (snapshots.some(snapshot => snapshot.owner_user_id !== scope.owner_user_id || snapshot.operator_user_id !== scope.operator_user_id || snapshot.subject_user_id !== scope.subject_user_id
        || snapshot.employee_id !== scope.employee_id || snapshot.destination.token_id !== stamp.token_id || snapshot.registration_id !== scope.registration_id
        || snapshot.app_installation_id !== scope.app_installation_id || snapshot.app_version_id !== scope.app_version_id || snapshot.grant_snapshot_id !== scope.grant_snapshot_id)) throw accessUnavailable();
      const parent = await this.parent(tx, stamp.org_id, scope.ref, target, scope.destination.kind, false, call.signal, false);
      const checkpoint = digest({ binding: scope.resource_binding_id, checkpoint: parent.checkpoint.id, generation: parent.checkpoint.generation });
      if (cursor && cursor.checkpoint_digest !== checkpoint) throw new PrivateResourceAccessError('APP_RESOURCE_ACCESS_STALE', 409);
      const ids = [...new Set([anchor.id, ...rows.map(row => row.id)])].sort();
      await tx.execute(sql`SELECT id FROM app_private_mcp_grants WHERE org_id=${stamp.org_id} AND id IN (${sql.join(ids.map(id => sql`${id}`), sql`,`)}) ORDER BY id COLLATE "C" FOR SHARE`);
      const currentRows = (await tx.execute(sql`SELECT * FROM app_private_mcp_grants WHERE org_id=${stamp.org_id} AND id IN (${sql.join(ids.map(id => sql`${id}`), sql`,`)})`)).rows.map(row => this.grantRow(row)!);
      const currentAnchor = currentRows.find(row => row.id === anchor.id);
      if (!currentAnchor || currentAnchor.revoked_at || currentAnchor.review_digest !== anchor.review_digest || currentAnchor.expires_at <= this.current(tx)) throw accessUnavailable();
      this.stored(currentAnchor);
      const projections = [...new Set([anchor.projection_id, ...rows.filter(row => !row.revoked_at && row.expires_at > this.current(tx)).map(row => row.projection_id)])];
      const bytes = (await tx.execute(sql`SELECT coalesce(sum(octet_length(body_ciphertext_b64)),0)::text AS bytes FROM app_resource_projections WHERE org_id=${stamp.org_id} AND id IN (${sql.join(projections.map(id => sql`${id}`), sql`,`)})`)).rows[0]?.bytes;
      if (Number(bytes) > 1048576) throw new PrivateResourceAccessError('APP_RESOURCE_ACCESS_TOO_LARGE', 413);
      const projectionRows = await tx.select().from(appResourceProjections).where(and(eq(appResourceProjections.org_id, stamp.org_id), eq(appResourceProjections.resource_binding_id, scope.resource_binding_id), eq(appResourceProjections.checkpoint_id, parent.checkpoint.id), eq(appResourceProjections.generation, parent.checkpoint.generation), eq(appResourceProjections.state, 'live'), inArray(appResourceProjections.id, projections)));
      let expiry = Math.min(currentAnchor.expires_at.getTime(), parent.authority.binding.consent_expires_at!.getTime(), cursor ? Date.parse(cursor.expires_at) : this.issuance(tx).getTime() + 300000);
      await finalPrivateMcpCredential(tx, invocation, 'app_private_resource_search', new Date(expiry), this.deadline(tx, new Date(expiry)));
      if (!privateAccessParentGateIsCurrent(parent)) throw accessUnavailable();
      const decoded = new Map<string, ReturnType<typeof decodePrivateProjection>>();
      for (const row of projectionRows) {
        requirePrivateMcpInvocation(invocation);
        decoded.set(row.id, decodePrivateProjection(this.secrets, row, parent.authority.descriptor));
      }
      const anchorRecord = decoded.get(anchor.projection_id);
      if (!anchorRecord) throw accessUnavailable();
      const anchorPins = this.pins({ ...parent, record: anchorRecord });
      if (digest(anchorPins) !== digest(Object.fromEntries(Object.keys(anchorPins).map(key => [key, scope[key as keyof PrivateMcpSnapshot]])))) throw new PrivateResourceAccessError('APP_RESOURCE_ACCESS_STALE', 409);
      const hits: { grant_id: string; label: 'Private App record'; snippets: Record<string, string> }[] = [];
      let after = cursor?.after ?? '0';
      for (const row of rows) {
        const current = currentRows.find(value => value.id === row.id);
        if (!current || current.review_digest !== row.review_digest) throw accessUnavailable();
        const snapshot = this.stored(current);
        if (!current.revoked_at && current.expires_at > this.current(tx) && snapshot.operations.includes('search') && fields.every(field => snapshot.field_keys.includes(field))
          && snapshot.token_authorization_version === stamp.token_authorization_version && snapshot.token_hash_digest === stamp.token_hash_digest
          && snapshot.scope_digest === digest(stamp.scopes) && snapshot.subject_membership_authorization_version === stamp.membership_authorization_version
          && snapshot.employee_authorization_version === stamp.employee_authorization_version) {
          const record = decoded.get(row.projection_id);
          if (record) {
            const pins = this.pins({ ...parent, record });
            if (digest(pins) === digest(Object.fromEntries(Object.keys(pins).map(key => [key, snapshot[key as keyof PrivateMcpSnapshot]])))) {
              const snippets: Record<string, string> = {};
              for (const field of fields) {
                const text = String(record.data[field] ?? '');
                const found = text.toLocaleLowerCase('en-US').indexOf(input.query.toLocaleLowerCase('en-US'));
                if (found >= 0) snippets[field] = text.slice(Math.max(0, found - 40), Math.max(0, found - 40) + 240);
              }
              if (Object.keys(snippets).length) {
                const hit = { grant_id: row.id, label: 'Private App record' as const, snippets };
                try {
                  encodePrivateMcpToolResult({ schema_version: 'deft.app_private_mcp_search_page.v1', hits: [...hits, hit], next_cursor: 'x'.repeat(2048), complete: false, expires_at: new Date(expiry).toISOString() });
                } catch (error) { if (!hits.length) throw error; break; }
                hits.push(hit);
                expiry = Math.min(expiry, current.expires_at.getTime());
              }
            }
          }
        }
        // Advance only after the candidate has been processed or denied.
        after = String(row.accepted_sequence);
        if (hits.length === 25) break;
      }
      const more = (await tx.execute(sql`SELECT id FROM app_private_mcp_grants WHERE org_id=${stamp.org_id} AND mcp_token_id=${stamp.token_id} AND resource_binding_id=${scope.resource_binding_id} AND accepted_sequence>${after}::bigint AND accepted_sequence<=${cutoff}::bigint LIMIT 1`)).rowCount !== 0;
      const next = more ? this.seal({ scope_digest: identity, checkpoint_digest: checkpoint, cutoff, after, expires_at: new Date(expiry).toISOString() }, 'search') : null;
      const result = encodePrivateMcpToolResult({ schema_version: 'deft.app_private_mcp_search_page.v1', hits, next_cursor: next, complete: !more, expires_at: new Date(expiry).toISOString() });
      await tx.insert(auditLog).values({ org_id: stamp.org_id, actor_type: stamp.principal_kind === 'agent' ? 'agent' : 'user', actor_id: stamp.employee_id ?? stamp.user_id, action: 'app_private_mcp.search', entity_type: 'app_private_mcp_grant', entity_id: anchor.id, metadata: { token_id: stamp.token_id, decision: 'allowed' } });
      await this.auditMcpTool(tx, stamp, 'app_private_resource_search', anchor.id);
      await this.freshMembers(tx, stamp.org_id, parent.participants[0]!, target.subject, parent.participants[2]!, scope.destination.kind);
      await finalPrivateMcpCredential(tx, invocation, 'app_private_resource_search', new Date(expiry), this.deadline(tx, new Date(expiry)));
      if (!privateAccessParentGateIsCurrent(parent)) throw accessUnavailable();
      return result;
    }, call.deadline);
  }

  async revoke(c: AccessCaller, id: string, signal?: AbortSignal) {
    return this.run(signal, async tx => {
      const row = this.grantRow((await tx.execute(sql`SELECT * FROM app_private_mcp_grants WHERE org_id=${c.org_id} AND owner_user_id=${c.user_id} AND id=${id} LIMIT 1`)).rows[0]);
      if (!row) throw accessUnavailable();
      const snapshot = this.stored(row);
      // Stored pins choose a complete lock set, even when the destination,
      // credential or parent is stale. Revocation never decrypts old content.
      await this.members(tx, c.org_id, snapshot.owner_user_id, snapshot.subject_user_id, snapshot.operator_user_id, true, snapshot.destination.kind, false);
      if (snapshot.employee_id) await tx.execute(sql`SELECT id FROM agent_employees WHERE org_id=${c.org_id} AND id=${snapshot.employee_id} FOR SHARE`);
      for (const [table, value] of [
        ['app_installations', snapshot.app_installation_id], ['app_versions', snapshot.app_version_id],
        ['app_grant_snapshots', snapshot.grant_snapshot_id], ['app_runtime_registrations', snapshot.registration_id],
        ['app_resource_bindings', snapshot.resource_binding_id], ['app_sync_checkpoints', snapshot.checkpoint_id],
      ] as const) await tx.execute(sql`SELECT id FROM ${sql.identifier(table)} WHERE org_id=${c.org_id} AND id=${value} FOR SHARE`);
      await tx.execute(sql`SELECT id FROM app_private_mcp_grants WHERE org_id=${c.org_id} AND id=${id} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM mcp_tokens WHERE org_id=${c.org_id} AND id=${snapshot.destination.token_id} FOR SHARE`);
      await c.guard(tx);
      const current = this.grantRow((await tx.execute(sql`SELECT * FROM app_private_mcp_grants WHERE org_id=${c.org_id} AND id=${id}`)).rows[0]);
      if (!current || current.review_digest !== row.review_digest) throw accessUnavailable();
      if (!current.revoked_at) {
        await tx.execute(sql`UPDATE app_private_mcp_grants SET revoked_at=clock_timestamp(),revoked_by_user_id=${c.user_id} WHERE org_id=${c.org_id} AND id=${id}`);
        await tx.insert(auditLog).values({ org_id: c.org_id, actor_type: 'user', actor_id: c.user_id, action: 'app_private_mcp.revoke', entity_type: 'app_private_mcp_grant', entity_id: id, metadata: { review_digest: current.review_digest } });
      }
      await this.ownerFinal(tx, c, [snapshot.owner_user_id, snapshot.subject_user_id, snapshot.operator_user_id], c.guard.current_web_session_expires_at(), snapshot.destination.kind, true);
      return { revoked: true };
    }, performance.now() + 3000, true);
  }

  async inventory(c: AccessCaller, raw: unknown, signal?: AbortSignal) {
    const input = PrivateMcpInventoryInput.parse(raw);
    const cursor = input.cursor ? PrivateMcpInventoryCursor.parse(this.open(input.cursor, 'inventory')) : null;
    if (cursor && (cursor.org_id !== c.org_id || cursor.owner_user_id !== c.user_id || cursor.sid !== c.sid
      || cursor.app_installation_id !== input.app_installation_id || Date.parse(cursor.expires_at) <= this.clock().getTime())) throw accessUnavailable();
    return this.run(signal, async tx => {
      await tx.execute(sql`SELECT id FROM org_members WHERE org_id=${c.org_id} AND user_id=${c.user_id} FOR SHARE`);
      const cutoff = cursor?.cutoff ?? String((await tx.execute(sql`SELECT coalesce(max(accepted_sequence),0)::text AS value FROM app_private_mcp_grants WHERE org_id=${c.org_id} AND owner_user_id=${c.user_id} AND app_installation_id=${input.app_installation_id}`)).rows[0]?.value ?? '0');
      const rows = (await tx.execute(sql`SELECT * FROM app_private_mcp_grants WHERE org_id=${c.org_id} AND owner_user_id=${c.user_id} AND app_installation_id=${input.app_installation_id} AND accepted_sequence>${cursor?.after ?? '0'}::bigint AND accepted_sequence<=${cutoff}::bigint ORDER BY accepted_sequence LIMIT 26`)).rows.map(row => this.grantRow(row)!);
      const page = rows.slice(0, 25);
      const expires = cursor?.expires_at ?? new Date(Math.min(this.issuance(tx).getTime() + 300000, c.guard.current_web_session_expires_at().getTime())).toISOString();
      const result = { schema_version: 'deft.app_private_mcp_inventory.v1', items: page.map(row => ({
        grant_id: row.id, label: 'Private App record', destination: this.stored(row).destination,
        expires_at: row.expires_at.toISOString(), state: row.revoked_at ? 'revoked' : row.expires_at <= this.current(tx) ? 'expired' : 'active',
      })), next_cursor: rows.length > page.length ? this.seal({ org_id: c.org_id, owner_user_id: c.user_id, sid: c.sid,
        app_installation_id: input.app_installation_id, cutoff, after: String(page.at(-1)!.accepted_sequence), expires_at: expires }, 'inventory') : null };
      if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw new PrivateResourceAccessError('APP_RESOURCE_ACCESS_TOO_LARGE', 413);
      await this.ownerFinal(tx, c, [c.user_id], new Date(expires), 'personal_mcp', true);
      return result;
    }, performance.now() + 3000, true);
  }

  async prune(c: AccessCaller, signal?: AbortSignal) {
    return this.run(signal, async tx => {
      const rows = (await tx.execute(sql`SELECT * FROM app_private_mcp_grants WHERE org_id=${c.org_id} AND owner_user_id=${c.user_id} AND coalesce(revoked_at,expires_at)<clock_timestamp()-interval '30 days' ORDER BY id COLLATE "C" LIMIT 100`)).rows.map(row => this.grantRow(row)!);
      const snapshots = rows.map(row => this.stored(row));
      const writers = new Set([c.user_id, ...snapshots.map(row => row.subject_user_id)]);
      const participants = [...new Set([...writers, ...snapshots.map(row => row.operator_user_id)])].sort();
      for (const id of participants) await tx.execute(writers.has(id)
        ? sql`SELECT id FROM org_members WHERE org_id=${c.org_id} AND user_id=${id} FOR UPDATE`
        : sql`SELECT id FROM org_members WHERE org_id=${c.org_id} AND user_id=${id} FOR SHARE`);
      for (const id of [...new Set(snapshots.flatMap(row => row.employee_id ? [row.employee_id] : []))].sort()) await tx.execute(sql`SELECT id FROM agent_employees WHERE org_id=${c.org_id} AND id=${id} FOR SHARE`);
      for (const [table, key] of [['app_installations','app_installation_id'], ['app_versions','app_version_id'], ['app_grant_snapshots','grant_snapshot_id'], ['app_runtime_registrations','registration_id'], ['app_resource_bindings','resource_binding_id'], ['app_sync_checkpoints','checkpoint_id']] as const) {
        for (const id of [...new Set(snapshots.map(row => row[key]))].sort()) await tx.execute(sql`SELECT id FROM ${sql.identifier(table)} WHERE org_id=${c.org_id} AND id=${id} FOR SHARE`);
      }
      for (const id of rows.map(row => row.id).sort()) await tx.execute(sql`SELECT id FROM app_private_mcp_grants WHERE org_id=${c.org_id} AND id=${id} FOR UPDATE`);
      for (const id of [...new Set(snapshots.map(row => row.destination.token_id))].sort()) await tx.execute(sql`SELECT id FROM mcp_tokens WHERE org_id=${c.org_id} AND id=${id} FOR SHARE`);
      await c.guard(tx);
      const removed = rows.length ? (await tx.execute(sql`DELETE FROM app_private_mcp_grants WHERE org_id=${c.org_id} AND owner_user_id=${c.user_id} AND id IN (${sql.join(rows.map(row => sql`${row.id}`), sql`,`)}) AND coalesce(revoked_at,expires_at)<clock_timestamp()-interval '30 days' RETURNING id`)).rows : [];
      if (removed.length) await tx.insert(auditLog).values({ org_id: c.org_id, actor_type: 'user', actor_id: c.user_id, action: 'app_private_mcp.prune', entity_type: 'app_private_mcp_grant', entity_id: c.user_id, metadata: { grant_ids: removed.map(row => row.id) } });
      await this.ownerFinal(tx, c, [c.user_id], c.guard.current_web_session_expires_at(), 'personal_mcp', true);
      return { removed: removed.length };
    }, performance.now() + 3000, true);
  }
}
