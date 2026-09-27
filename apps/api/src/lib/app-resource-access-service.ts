import { randomUUID, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, sql, inArray } from "drizzle-orm";
import { appResourceAccessGrants as grants, appResourceProjections as projections, orgMembers, users, auditLog } from "@deft/db/schema";
import { canonicalCapabilityJson } from "@deft/shared";
import type { AppRunKeyProvider } from "./app-run-keyrings.js";
import type { AppRunTransaction } from "./app-run-repository.js";
import type { WebAuthorityGuard } from "./app-resource-sync-web-authority.js";
import { privateSearchDatabase } from "./app-resource-private-search-db.js";
import { assertPrivateAccessAdmission } from "./app-private-access-admission.js";
import { samplePrivateAccessClock, type PrivateAccessClock } from "./app-private-access-clock.js";
import { loadLockedPrivateAccessParent } from "./app-private-access-parent.js";
import { decodePrivateProjection } from "./app-resource-private-projection.js";
import { AppResourceSyncSecretService } from "./app-resource-sync-secrets.js";
import { isAppResourceSyncChannelEnabled } from "./env.js";
import { ACCESS_LIMITS, HumanAccessReviewInput, HumanAccessReviewResponse, HumanAccessSnapshot, HumanAccessAccept, HumanAccessInventoryInput, HumanAccessInventoryCursor, HumanAccessSearchInput, HumanAccessSearchCursor, accessUnavailable, PrivateResourceAccessError, type AccessSnapshot } from "./app-resource-access-contract.js";
export type AccessCaller = Readonly<{
  org_id: string;
  user_id: string;
  sid: string;
  guard: WebAuthorityGuard;
}>;
const digest = (v: unknown) => `sha256:${createHash("sha256").update(canonicalCapabilityJson(v)).digest("hex")}`;
export const privateSharingEnabled = () => isAppResourceSyncChannelEnabled() && process.env.DEFT_APP_PRIVATE_SHARING_ENABLED === "true";
type Tx = AppRunTransaction;
export class AppResourceAccessService {
  readonly secrets: AppResourceSyncSecretService;
  private readonly clocks = new WeakMap<Tx, PrivateAccessClock>();
  private current(tx: Tx) { const clock = this.clocks.get(tx); if (!clock) throw accessUnavailable(); return clock.current(); }
  private issuance(tx: Tx) { const clock = this.clocks.get(tx); if (!clock) throw accessUnavailable(); return clock.issuance(); }
  constructor(private readonly keys: AppRunKeyProvider, private readonly clock: () => Date = () => new Date()) {
    this.secrets = new AppResourceSyncSecretService(keys);
  }
  private token(value: unknown, purpose = "review") {
    const key = this.keys.current("fingerprint");
    try {
      const body = Buffer.from(canonicalCapabilityJson({ key_version: key.key_id, value })).toString("base64url");
      return `${body}.${createHmac("sha256", key.key).update(`deft.app_resource_access.${purpose}.v1\0`).update(body).digest("base64url")}`;
    }
    finally {
      key.key.fill(0);
    }
  }
  private open(token: string, purpose = "review") {
    try {
      const [body, mac, ...rest] = token.split(".");
      if (!body || !mac || rest.length) {
        throw accessUnavailable();
      }
      const raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      const key = this.keys.read("fingerprint", raw.key_version);
      if (!key) {
        throw accessUnavailable();
      }
      try {
        const expected = createHmac("sha256", key.key).update(`deft.app_resource_access.${purpose}.v1\0`).update(body).digest(), actual = Buffer.from(mac, "base64url");
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
          throw accessUnavailable();
        }
        return raw.value as unknown;
      }
      finally {
        key.key.fill(0);
      }
    }
    catch {
      throw accessUnavailable();
    }
  }
  private async human(tx: Tx, org: string, ids: readonly string[]) {
    const rows = await tx.select({
      id: users.id,
      kind: users.kind,
      role: orgMembers.role,
      active: orgMembers.is_active
    }).from(orgMembers).innerJoin(users, eq(users.id, orgMembers.user_id)).where(and(eq(orgMembers.org_id, org), inArray(orgMembers.user_id, [...ids])));
    if (ids.some(id => !rows.some(r => r.id === id && r.kind === "human" && r.active && r.role !== "guest"))) {
      throw accessUnavailable();
    }
  }
  private async members(tx: Tx, org: string, owner: string, recipient: string, operator: string, write: boolean, requireLive = true) {
    for (const id of [...new Set([owner, recipient, operator])].sort()) {
      if (write && (id === owner || id === recipient)) {
        await tx.execute(sql `SELECT id FROM org_members WHERE org_id=${org} AND user_id=${id} FOR UPDATE`);
      }
      else
        await tx.execute(sql `SELECT id FROM org_members WHERE org_id=${org} AND user_id=${id} FOR SHARE`);
    }
    if (requireLive) {
      await this.human(tx, org, [...new Set([owner, recipient, operator])]);
    }
  }
  private async webFinal(tx: Tx, c: AccessCaller, expires?: Date) {
    await c.guard(tx);
    const deadline = new Date(Math.min(expires?.getTime() ?? Infinity, c.guard.current_web_session_expires_at().getTime()));
    this.clocks.get(tx)?.bindDeadline(deadline);
    if (deadline <= this.current(tx)) throw accessUnavailable();
  }
  private async final(tx: Tx, c: AccessCaller, ids: readonly string[], expires?: Date) {
    await this.webFinal(tx, c, expires);
    await this.human(tx, c.org_id, ids);
    const now = this.current(tx);
    if (!privateSharingEnabled() || expires && expires <= now || c.guard.current_web_session_expires_at() <= now) {
      throw accessUnavailable();
    }
  }
  private async run<T>(signal: AbortSignal | undefined, work: (tx: Tx) => Promise<T>, allowDisabled = false) {
    if (!allowDisabled && !privateSharingEnabled()) {
      throw accessUnavailable();
    }
    let localClock: PrivateAccessClock | undefined;
    const result = await privateSearchDatabase().transaction(async tx => {
      localClock = await samplePrivateAccessClock(tx, this.clock);
      this.clocks.set(tx, localClock);
      try { return await work(tx); }
      finally { this.clocks.delete(tx); }
    }, signal, performance.now() + 3000);
    signal?.throwIfAborted();
    if (localClock?.expired() || !allowDisabled && !privateSharingEnabled()) throw accessUnavailable();
    return result;
  }
  private async live(tx: Tx, c: AccessCaller, ref: AccessSnapshot["ref"], recipient: string, write: boolean, signal?: AbortSignal, decrypt = true) {
    return loadLockedPrivateAccessParent({
      tx, orgId: c.org_id, ref, recipient, clock: () => this.current(tx), secrets: this.secrets, signal, decrypt,
      lockParticipants: (owner, target, operator) => this.members(tx, c.org_id, owner, target, operator, write),
    });
  }
  private pins(live: Awaited<ReturnType<AppResourceAccessService["live"]>>) {
    const { authority: a, checkpoint: p, record: r } = live;
    if (!r) {
      throw accessUnavailable();
    }
    return {
      app_installation_id: a.installation.id,
      app_version_id: a.version.id,
      grant_snapshot_id: a.grant.id,
      lifecycle_epoch: a.installation.lifecycle_epoch,
      grant_epoch: a.installation.grant_epoch,
      registration_id: a.registration.id,
      operator_user_id: a.registration.operator_user_id,
      runtime_epoch: a.registration.runtime_epoch,
      resource_binding_id: a.binding.id,
      descriptor_digest: a.descriptor_digest,
      checkpoint_id: p.id,
      generation: p.generation,
      revision_digest: digest({ revision: r.revision }),
      content_digest: digest({ revision: r.revision, data: r.data })
    };
  }
  async prepare(c: AccessCaller, raw: unknown, signal?: AbortSignal) {
    const input = HumanAccessReviewInput.parse(raw);
    return this.run(signal, async (tx) => {
      const live = await this.live(tx, c, input.ref, input.destination.user_id, false, signal);
      if (live.authority.binding.owner_user_id !== c.user_id) {
        throw accessUnavailable();
      }
      const fields = [...input.field_keys].sort();
      if (fields.some(f => !Object.hasOwn(live.authority.descriptor.record_schema.properties, f))) {
        throw accessUnavailable();
      }
      const now = this.issuance(tx), expires = new Date(Math.min(new Date(input.expires_at).getTime(), now.getTime() + ACCESS_LIMITS.grant_ms, live.authority.binding.consent_expires_at!.getTime()));
      if (expires <= now) {
        throw accessUnavailable();
      }
      const [recipient] = await tx.select({ name: users.name }).from(users).where(eq(users.id, input.destination.user_id));
      const snapshot = HumanAccessSnapshot.parse({
        schema_version: "deft.app_resource_access_snapshot.v1",
        purpose: "human_view",
        org_id: c.org_id,
        owner_user_id: c.user_id,
        recipient_user_id: input.destination.user_id,
        ...this.pins(live),
        ref: input.ref,
        field_keys: fields,
        operations: input.operations,
        app_label: String((live.authority.version.manifest as Record<string, unknown>).name ?? live.authority.installation.app_id).slice(0, 200),
        recipient_label: (recipient?.name ?? "Human recipient").slice(0, 200),
        expires_at: expires.toISOString(),
        review_expires_at: new Date(Math.min(expires.getTime(), now.getTime() + ACCESS_LIMITS.review_ms)).toISOString()
      });
      await this.final(tx, c, live.participants, expires);
      if (fields.some(k => !Object.hasOwn(live.record!.data, k))) {
        throw accessUnavailable();
      }
      const selectedData = Object.fromEntries(fields.map(k => [k, live.record!.data[k]!]));
      const label = fields.includes(live.authority.descriptor.label_field) ? String(live.record!.data[live.authority.descriptor.label_field]).slice(0, 200) : "Shared App record";
      const readEnvelope = {
        schema_version: "deft.app_resource_access_record.v1",
        grant_id: "00000000-0000-0000-0000-000000000000",
        ref: input.ref,
        label,
        data: selectedData,
        freshness: "unknown",
        expires_at: snapshot.expires_at
      };
      if (Buffer.byteLength(JSON.stringify(readEnvelope)) > ACCESS_LIMITS.bytes) {
        throw new PrivateResourceAccessError("APP_RESOURCE_ACCESS_TOO_LARGE", 413);
      }
      const result = HumanAccessReviewResponse.parse({
        snapshot,
        record_label: label,
        selected_data: selectedData,
        review_digest: digest(snapshot),
        review_token: this.token(snapshot)
      });
      if (Buffer.byteLength(JSON.stringify(result)) > 131072) {
        throw new PrivateResourceAccessError("APP_RESOURCE_ACCESS_TOO_LARGE", 413);
      }
      return result;
    });
  }
  async accept(c: AccessCaller, raw: unknown, signal?: AbortSignal) {
    const input = HumanAccessAccept.parse(raw), s = HumanAccessSnapshot.parse(this.open(input.review_token));
    if (s.org_id !== c.org_id || s.owner_user_id !== c.user_id || digest(s) !== input.review_digest) {
      throw accessUnavailable();
    }
    return this.run(signal, async (tx) => {
      const live = await this.live(tx, c, s.ref, s.recipient_user_id, true, signal);
      if (digest(this.pins(live)) !== digest(Object.fromEntries(Object.keys(this.pins(live)).map(k => [k, s[k as keyof AccessSnapshot]])))) {
        throw new PrivateResourceAccessError("APP_RESOURCE_ACCESS_STALE", 409);
      }
      const now = this.current(tx);
      if (new Date(s.review_expires_at) <= now || new Date(s.expires_at) > live.authority.binding.consent_expires_at!) {
        throw accessUnavailable();
      }
      const [prior] = await tx.select().from(grants).where(and(eq(grants.org_id, c.org_id), eq(grants.owner_user_id, c.user_id), eq(grants.review_digest, input.review_digest)));
      if (prior) {
        if (prior.revoked_at || prior.expires_at <= now) {
          throw accessUnavailable();
        }
        await this.final(tx, c, live.participants, new Date(Math.min(prior.expires_at.getTime(), Date.parse(s.review_expires_at), live.authority.binding.consent_expires_at!.getTime())));
        return { grant_id: prior.id, expires_at: prior.expires_at.toISOString() };
      }
      await assertPrivateAccessAdmission(tx, c.org_id, c.user_id, s.app_installation_id, s.recipient_user_id);
      await this.final(tx, c, live.participants, new Date(Math.min(Date.parse(s.expires_at), Date.parse(s.review_expires_at), live.authority.binding.consent_expires_at!.getTime())));
      const id = randomUUID();
      await tx.execute(sql `INSERT INTO app_resource_access_grants(id,org_id,owner_user_id,recipient_user_id,app_installation_id,resource_binding_id,checkpoint_id,projection_id,review_digest,snapshot,accepted_at,expires_at) VALUES(${id},${c.org_id},${c.user_id},${s.recipient_user_id},${s.app_installation_id},${s.resource_binding_id},${s.checkpoint_id},${s.ref.resource_id},${input.review_digest},${JSON.stringify(s)}::jsonb,clock_timestamp(),${s.expires_at}::timestamptz)`);
      await tx.insert(auditLog).values({
        org_id: c.org_id,
        actor_type: "user",
        actor_id: c.user_id,
        action: "app_resource_access.accept",
        entity_type: "app_resource_access_grant",
        entity_id: id,
        metadata: {
          review_digest: input.review_digest,
          recipient_user_id: s.recipient_user_id,
          field_keys: s.field_keys,
          operations: s.operations,
          purpose: s.purpose
        }
      });
      await this.final(tx, c, live.participants, new Date(Math.min(Date.parse(s.expires_at), Date.parse(s.review_expires_at), live.authority.binding.consent_expires_at!.getTime())));
      return { grant_id: id, expires_at: s.expires_at };
    });
  }
  async read(c: AccessCaller, id: string, signal?: AbortSignal, operation: "read" | "cite" | "scope" = "read") {
    return this.run(signal, async (tx) => {
      const [g] = await tx.select().from(grants).where(and(eq(grants.org_id, c.org_id), eq(grants.id, id), eq(grants.recipient_user_id, c.user_id))).limit(1);
      if (!g) {
        throw accessUnavailable();
      }
      const s = this.stored(g);
      if (operation !== "scope" && !s.operations.includes(operation)) {
        throw accessUnavailable();
      }
      const live = await this.live(tx, c, s.ref, s.recipient_user_id, false, signal);
      await tx.execute(sql `SELECT id FROM app_resource_access_grants WHERE org_id=${c.org_id} AND id=${id} FOR SHARE`);
      const [current] = await tx.select().from(grants).where(and(eq(grants.org_id, c.org_id), eq(grants.id, id)));
      if (!current || current.revoked_at || current.review_digest !== g.review_digest || digest(current.snapshot) !== g.review_digest || digest(this.pins(live)) !== digest(Object.fromEntries(Object.keys(this.pins(live)).map(k => [k, s[k as keyof AccessSnapshot]])))) {
        throw accessUnavailable();
      }
      const data = Object.fromEntries(s.field_keys.map(k => [k, live.record!.data[k]!]));
      const label = s.field_keys.includes(live.authority.descriptor.label_field) ? String(live.record!.data[live.authority.descriptor.label_field]).slice(0, 200) : "Shared App record";
      const result = operation === "scope" ? {
        schema_version: "deft.app_resource_access_scope.v1",
        grant_id: id,
        label: "Shared App record",
        field_keys: s.field_keys,
        operations: s.operations,
        expires_at: current.expires_at.toISOString()
      } : operation === "cite" ? {
        schema_version: "deft.app_resource_access_citation.v1",
        grant_id: id,
        label,
        href: `/private-app-resources/shared/${id}`,
        freshness: "unknown",
        expires_at: current.expires_at.toISOString()
      } : {
        schema_version: "deft.app_resource_access_record.v1",
        grant_id: id,
        ref: s.ref,
        label,
        data,
        freshness: "unknown",
        expires_at: current.expires_at.toISOString()
      };
      if (Buffer.byteLength(JSON.stringify(result)) > ACCESS_LIMITS.bytes) {
        throw new PrivateResourceAccessError("APP_RESOURCE_ACCESS_TOO_LARGE", 413);
      }
      await this.final(tx, c, live.participants, current.expires_at);
      if (live.authority.binding.consent_expires_at! <= this.current(tx)) {
        throw accessUnavailable();
      }
      return result;
    });
  }
  async revoke(c: AccessCaller, id: string, signal?: AbortSignal) {
    return this.run(signal, async (tx) => {
      const [g] = await tx.select().from(grants).where(and(eq(grants.org_id, c.org_id), eq(grants.id, id), eq(grants.owner_user_id, c.user_id))).limit(1);
      if (!g) {
        throw accessUnavailable();
      }
      const s = this.stored(g);
      await this.members(tx, c.org_id, c.user_id, g.recipient_user_id, s.operator_user_id, true, false);
      await this.staleParents(tx, c.org_id, [s]);
      await tx.execute(sql `SELECT id FROM app_resource_access_grants WHERE org_id=${c.org_id} AND id=${id} FOR UPDATE`);
      await this.webFinal(tx, c);
      const [current] = await tx.select().from(grants).where(and(eq(grants.org_id, c.org_id), eq(grants.id, id)));
      if (!current) {
        throw accessUnavailable();
      }
      if (!current.revoked_at) {
        await tx.update(grants).set({ revoked_at: this.current(tx), revoked_by_user_id: c.user_id }).where(eq(grants.id, id));
        await tx.insert(auditLog).values({
          org_id: c.org_id,
          actor_type: "user",
          actor_id: c.user_id,
          action: "app_resource_access.revoke",
          entity_type: "app_resource_access_grant",
          entity_id: id,
          metadata: { review_digest: current.review_digest }
        });
      }
      await this.webFinal(tx, c);
      return { revoked: true };
    }, true);
  }
  private stored(g: typeof grants.$inferSelect) {
    const s = HumanAccessSnapshot.parse(g.snapshot);
    if (s.org_id !== g.org_id || s.owner_user_id !== g.owner_user_id || s.recipient_user_id !== g.recipient_user_id || s.app_installation_id !== g.app_installation_id || s.resource_binding_id !== g.resource_binding_id || s.checkpoint_id !== g.checkpoint_id || s.ref.resource_id !== g.projection_id || s.expires_at !== g.expires_at.toISOString() || digest(s) !== g.review_digest) {
      throw accessUnavailable();
    }
    return s;
  }
  async search(c: AccessCaller, anchorId: string, raw: unknown, signal?: AbortSignal) {
    const input = HumanAccessSearchInput.parse(raw);
    const cursor = input.cursor ? HumanAccessSearchCursor.parse(this.open(input.cursor, "search")) : null;
    const queryDigest = digest({ query: input.query, field_keys: input.field_keys });
    if (cursor && (cursor.org_id !== c.org_id || cursor.recipient_user_id !== c.user_id || cursor.sid !== c.sid || cursor.anchor_id !== anchorId || cursor.query_digest !== queryDigest || new Date(cursor.expires_at) <= this.clock())) {
      throw accessUnavailable();
    }
    return this.run(signal, async (tx) => {
      const [anchor] = await tx.select().from(grants).where(and(eq(grants.org_id, c.org_id), eq(grants.recipient_user_id, c.user_id), eq(grants.id, anchorId)));
      if (!anchor || anchor.revoked_at || anchor.expires_at <= this.current(tx)) {
        throw accessUnavailable();
      }
      const scope = this.stored(anchor);
      if (!scope.operations.includes("search") || input.field_keys.some(k => !scope.field_keys.includes(k))) {
        throw accessUnavailable();
      }
      await this.members(tx, c.org_id, scope.owner_user_id, c.user_id, scope.operator_user_id, false);
      const cutoff = cursor?.cutoff ?? String((await tx.execute(sql `SELECT coalesce(max(accepted_sequence),0)::text AS value
        FROM app_resource_access_grants WHERE org_id=${c.org_id} AND recipient_user_id=${c.user_id}`)).rows[0]?.value ?? "0");
      const rows = await tx.select().from(grants).where(and(eq(grants.org_id, c.org_id), eq(grants.recipient_user_id, c.user_id), eq(grants.resource_binding_id, scope.resource_binding_id), sql `${grants.accepted_sequence}>${cursor?.after ?? "0"}::bigint`, sql `${grants.accepted_sequence}<=${cutoff}::bigint`)).orderBy(grants.accepted_sequence).limit(ACCESS_LIMITS.search_candidates);
      const snapshots = rows.map(g => this.stored(g));
      if (snapshots.some(s => s.owner_user_id !== scope.owner_user_id || s.operator_user_id !== scope.operator_user_id || s.registration_id !== scope.registration_id || s.app_version_id !== scope.app_version_id || s.grant_snapshot_id !== scope.grant_snapshot_id || s.app_installation_id !== scope.app_installation_id)) {
        throw accessUnavailable();
      }
      await this.staleParents(tx, c.org_id, [scope]);
      const liveAnchor = await this.live(tx, c, scope.ref, c.user_id, false, signal, false);
      if (cursor && (cursor.resource_binding_id !== scope.resource_binding_id || cursor.checkpoint_id !== liveAnchor.checkpoint.id || cursor.generation !== liveAnchor.checkpoint.generation)) {
        throw new PrivateResourceAccessError("APP_RESOURCE_ACCESS_STALE", 409);
      }
      for (const id of [...new Set([anchorId, ...rows.map(g => g.id)])].sort()) {
        await tx.execute(sql `SELECT id FROM app_resource_access_grants WHERE org_id=${c.org_id} AND id=${id} FOR SHARE`);
      }
      const [currentAnchor] = await tx.select().from(grants).where(and(eq(grants.org_id, c.org_id), eq(grants.id, anchorId)));
      if (!currentAnchor || currentAnchor.revoked_at || currentAnchor.expires_at <= this.current(tx) || currentAnchor.review_digest !== anchor.review_digest) {
        throw accessUnavailable();
      }
      const projectionIds = [...new Set([anchor.projection_id, ...rows.filter(g => !g.revoked_at && g.expires_at > this.current(tx)).map(g => g.projection_id)])];
      if (projectionIds.length) {
        const total = await tx.execute(sql `SELECT coalesce(sum(octet_length(body_ciphertext_b64)),0)::text AS bytes
          FROM app_resource_projections WHERE org_id=${c.org_id} AND id IN (${sql.join(projectionIds.map(id => sql `${id}`), sql `,`)})`);
        if (Number(total.rows[0]?.bytes ?? 0) > 1048576) {
          throw new PrivateResourceAccessError("APP_RESOURCE_ACCESS_TOO_LARGE", 413);
        }
      }
      const projectionRows = await tx.select().from(projections).where(and(eq(projections.org_id, c.org_id), eq(projections.resource_binding_id, scope.resource_binding_id), eq(projections.checkpoint_id, liveAnchor.checkpoint.id), eq(projections.generation, liveAnchor.checkpoint.generation), eq(projections.state, "live"), inArray(projections.id, projectionIds)));
      const decoded = new Map<string, Awaited<ReturnType<AppResourceAccessService["live"]>>>();
      for (const row of projectionRows) {
        signal?.throwIfAborted();
        try {
          decoded.set(row.id, { ...liveAnchor, row, record: decodePrivateProjection(this.secrets, row, liveAnchor.authority.descriptor) });
        }
        catch {
          throw accessUnavailable();
        }
      }
      const authorizedAnchor = decoded.get(anchor.projection_id);
      if (!authorizedAnchor || digest(this.pins(authorizedAnchor)) !== digest(Object.fromEntries(Object.keys(this.pins(authorizedAnchor)).map(k => [k, scope[k as keyof AccessSnapshot]])))) {
        throw accessUnavailable();
      }
      const hits: {
        grant_id: string;
        label: string;
        snippets: Record<string, string>;
      }[] = [];
      let deliveryExpires = currentAnchor.expires_at.getTime();
      let after = cursor?.after ?? "0";
      for (const g of rows) {
        after = g.accepted_sequence.toString();
        const s = this.stored(g);
        if (g.revoked_at || g.expires_at <= this.current(tx) || !s.operations.includes("search") || input.field_keys.some(k => !s.field_keys.includes(k))) {
          continue;
        }
        const live = decoded.get(g.projection_id);
        if (!live) {
          continue;
        }
        if (digest(this.pins(live)) !== digest(Object.fromEntries(Object.keys(this.pins(live)).map(k => [k, s[k as keyof AccessSnapshot]])))) {
          continue;
        }
        const snippets: Record<string, string> = {};
        for (const k of input.field_keys) {
          const value = live.record!.data[k];
          if (value === undefined) {
            continue;
          }
          const text = String(value), index = text.toLocaleLowerCase("en-US").indexOf(input.query.toLocaleLowerCase("en-US"));
          if (index >= 0) {
            snippets[k] = text.slice(Math.max(0, index - 60), Math.max(0, index - 60) + 240);
          }
        }
        if (Object.keys(snippets).length) {
          deliveryExpires = Math.min(deliveryExpires, g.expires_at.getTime());
          hits.push({ grant_id: g.id, label: s.field_keys.includes(live.authority.descriptor.label_field) ? String(live.record!.data[live.authority.descriptor.label_field]).slice(0, 200) : "Shared App record", snippets });
        }
        if (hits.length === ACCESS_LIMITS.search_hits) {
          break;
        }
      }
      const more = (await tx.execute(sql `SELECT 1 FROM app_resource_access_grants WHERE org_id=${c.org_id} AND recipient_user_id=${c.user_id}
        AND resource_binding_id=${scope.resource_binding_id} AND accepted_sequence>${after}::bigint AND accepted_sequence<=${cutoff}::bigint LIMIT 1`)).rowCount !== 0;
      await this.final(tx, c, liveAnchor.participants, new Date(Math.min(deliveryExpires, liveAnchor.authority.binding.consent_expires_at!.getTime(), cursor ? Date.parse(cursor.expires_at) : Infinity)));
      const next = more ? this.token({
        schema_version: "deft.app_resource_access_search_cursor.v1",
        org_id: c.org_id,
        recipient_user_id: c.user_id,
        sid: c.sid,
        anchor_id: anchorId,
        resource_binding_id: scope.resource_binding_id,
        checkpoint_id: liveAnchor.checkpoint.id,
        generation: liveAnchor.checkpoint.generation,
        query_digest: queryDigest,
        cutoff,
        after,
        expires_at: cursor?.expires_at ?? new Date(Math.min(this.issuance(tx).getTime() + 300000, anchor.expires_at.getTime(), c.guard.current_web_session_expires_at().getTime())).toISOString()
      }, "search") : null;
      const result = {
        schema_version: "deft.app_resource_access_search_page.v1",
        hits,
        next_cursor: next,
        complete: next === null
      };
      if (Buffer.byteLength(JSON.stringify(result)) > ACCESS_LIMITS.bytes) {
        throw new PrivateResourceAccessError("APP_RESOURCE_ACCESS_TOO_LARGE", 413);
      }
      return result;
    });
  }
  async inventory(c: AccessCaller, raw: unknown, signal?: AbortSignal) {
    const input = HumanAccessInventoryInput.parse(raw);
    const cursor = input.cursor ? HumanAccessInventoryCursor.parse(this.open(input.cursor, "inventory")) : null;
    if (cursor && (cursor.org_id !== c.org_id || cursor.user_id !== c.user_id || cursor.view !== input.view || cursor.app_installation_id !== (input.app_installation_id ?? null) || cursor.sid !== c.sid || new Date(cursor.expires_at) <= this.clock())) {
      throw accessUnavailable();
    }
    return this.run(signal, async (tx) => {
      await tx.execute(sql `SELECT id FROM org_members WHERE org_id=${c.org_id} AND user_id=${c.user_id} FOR SHARE`);
      await this.human(tx, c.org_id, [c.user_id]);
      const subjectFilter = input.view === "received" ? eq(grants.recipient_user_id, c.user_id) : and(eq(grants.owner_user_id, c.user_id), eq(grants.app_installation_id, input.app_installation_id!));
      const cutoff = cursor?.cutoff ?? String((await tx.select({ value: sql<string> `coalesce(max(accepted_sequence),0)::text` }).from(grants).where(and(eq(grants.org_id, c.org_id), subjectFilter)))[0]?.value ?? "0");
      const after = cursor?.after ?? "0";
      const rows = await tx.select().from(grants).where(and(eq(grants.org_id, c.org_id), subjectFilter, sql `${grants.accepted_sequence}>${after}::bigint`, sql `${grants.accepted_sequence}<=${cutoff}::bigint`)).orderBy(grants.accepted_sequence).limit(ACCESS_LIMITS.inventory + 1);
      const page = rows.slice(0, ACCESS_LIMITS.inventory);
      const now = this.current(tx);
      const items = page.map(g => ({
        grant_id: g.id,
        label: "Shared App record",
        expires_at: g.expires_at.toISOString(),
        state: g.revoked_at ? "revoked" : g.expires_at <= now ? "expired" : "active"
      }));
      if (input.view === "owned") {
        await this.webFinal(tx, c, cursor ? new Date(cursor.expires_at) : undefined);
      }
      else
        await this.final(tx, c, [c.user_id], cursor ? new Date(cursor.expires_at) : undefined);
      if (cursor && new Date(cursor.expires_at) <= this.current(tx)) throw accessUnavailable();
      const next = rows.length > page.length ? this.token({
        schema_version: "deft.app_resource_access_inventory_cursor.v1",
        org_id: c.org_id,
        user_id: c.user_id,
        sid: c.sid,
        view: input.view,
        app_installation_id: input.app_installation_id ?? null,
        cutoff,
        after: page.at(-1)!.accepted_sequence.toString(),
        expires_at: cursor?.expires_at ?? new Date(Math.min(this.issuance(tx).getTime() + 300000, c.guard.current_web_session_expires_at().getTime())).toISOString()
      }, "inventory") : null;
      const result = {
        schema_version: "deft.app_resource_access_inventory.v1",
        items,
        next_cursor: next,
        complete: next === null
      };
      if (Buffer.byteLength(JSON.stringify(result)) > ACCESS_LIMITS.bytes) {
        throw new PrivateResourceAccessError("APP_RESOURCE_ACCESS_TOO_LARGE", 413);
      }
      return result;
    }, input.view === "owned");
  }
  async prune(c: AccessCaller, signal?: AbortSignal) {
    return this.run(signal, async (tx) => {
      const candidates = await tx.select().from(grants).where(and(eq(grants.org_id, c.org_id), eq(grants.owner_user_id, c.user_id), sql `coalesce(${grants.revoked_at},${grants.expires_at})
          < clock_timestamp()-interval '30 days'`)).orderBy(grants.id).limit(ACCESS_LIMITS.prune);
      const snapshots = candidates.map(g => this.stored(g));
      const writers = new Set([c.user_id, ...candidates.map(g => g.recipient_user_id)]);
      const participants = [...new Set([...writers, ...snapshots.map(s => s.operator_user_id)])].sort();
      for (const id of participants) {
        if (writers.has(id)) {
          await tx.execute(sql `SELECT id FROM org_members WHERE org_id=${c.org_id} AND user_id=${id} FOR UPDATE`);
        }
        else
          await tx.execute(sql `SELECT id FROM org_members WHERE org_id=${c.org_id} AND user_id=${id} FOR SHARE`);
      }
      await this.staleParents(tx, c.org_id, snapshots);
      for (const g of candidates) {
        await tx.execute(sql `SELECT id FROM app_resource_access_grants WHERE org_id=${c.org_id} AND id=${g.id} FOR UPDATE`);
      }
      await this.webFinal(tx, c);
      const ids = candidates.map(g => g.id);
      const removed = ids.length ? await tx.delete(grants).where(and(eq(grants.org_id, c.org_id), eq(grants.owner_user_id, c.user_id), inArray(grants.id, ids), sql `coalesce(${grants.revoked_at},${grants.expires_at})<clock_timestamp()-interval '30 days'`)).returning({ id: grants.id }) : [];
      if (removed.length) {
        await tx.insert(auditLog).values({
          org_id: c.org_id,
          actor_type: "user",
          actor_id: c.user_id,
          action: "app_resource_access.prune",
          entity_type: "app_resource_access_grant",
          entity_id: c.user_id,
          metadata: { grant_ids: removed.map(g => g.id) }
        });
      }
      await this.webFinal(tx, c);
      return { removed: removed.length };
    }, true);
  }
  private async staleParents(tx: Tx, org: string, snapshots: readonly AccessSnapshot[]) {
    const sets = [["app_installations", "app_installation_id"], ["app_versions", "app_version_id"], ["app_grant_snapshots", "grant_snapshot_id"], ["app_runtime_registrations", "registration_id"], ["app_resource_bindings", "resource_binding_id"], ["app_sync_checkpoints", "checkpoint_id"]] as const;
    for (const [table, key] of sets) {
      for (const id of [...new Set(snapshots.map(s => s[key]))].sort()) {
        await tx.execute(sql `SELECT id FROM ${sql.identifier(table)} WHERE org_id=${org} AND id=${id} FOR SHARE`);
      }
    }
  }
}
