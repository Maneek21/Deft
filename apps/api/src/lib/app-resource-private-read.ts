import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appResourceBindings, appResourceProjections, appSyncCheckpoints } from '@deft/db/schema';
import { parseSyncPage } from '@deft/app-kit/experimental/resource-sync';
import { AppRuntimeResourceRefV2Schema, canonicalCapabilityJson } from '@deft/shared';
import type { ResourceRefV2 } from '@deft/shared';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import { PostgresAppRunRepository, type AppRunTransaction } from './app-run-repository.js';
import { loadLiveResourceSyncBindingAuthority, resourceSyncParticipantsAreHuman } from './app-resource-sync-authority.js';
import { AppResourceSyncSecretService } from './app-resource-sync-secrets.js';
import { isAppResourceSyncChannelEnabled } from './env.js';
import { openPrivateSearchCursor, privateSearchDigest, sealPrivateSearchCursor } from './app-resource-private-search-cursor.js';

export const APP_RESOURCE_PRIVATE_READ_LIMITS = Object.freeze({ items: 25, response_bytes: 1_048_576 });
const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const subjectSchema = z.strictObject({ kind: z.literal('human'), org_id: uuid, user_id: uuid });
const pageSchema = z.strictObject({ resource_binding_id: uuid,
  limit: z.number().int().min(1).max(APP_RESOURCE_PRIVATE_READ_LIMITS.items).optional(),
  cursor: z.string().min(1).max(2_048).optional() });
const oneSchema = z.strictObject({ resource_binding_id: uuid, projection_id: uuid });
export const APP_RESOURCE_PRIVATE_SEARCH_LIMITS = Object.freeze({ scan_records: 100,
  scan_bytes: 1_048_576, items: 25, response_bytes: 65_536, snippet_chars: 240, cursor_ms: 900_000 });
const searchSchema = z.strictObject({ resource_binding_id: uuid, query: z.string().min(1).max(200)
  .refine(value => value.trim().length > 0), field_keys: z.array(z.string().min(1).max(48)).min(1).max(32)
  .refine(value => new Set(value).size === value.length), cursor: z.string().min(1).max(2048).optional() });
export type PrivateSearchPage = Readonly<{ schema_version: 'deft.app_private_search_page.v1';
  items: readonly Readonly<{ ref: ResourceRefV2; label: string; snippet: string; field_key: string; href: string }>[];
  scan: Readonly<{ records_scanned: number; complete: boolean }>; next_cursor: string | null;
  freshness: 'unknown'; consent_expires_at: string }>;
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cursorSchema = z.strictObject({ version: z.literal(1), key_version: z.string().min(1).max(128),
  org_id: uuid, resource_binding_id: uuid, checkpoint_id: uuid,
  generation: sequence.refine((value) => value > 0), cursor_sequence: sequence, after: uuid });
type Cursor = z.infer<typeof cursorSchema>;
export type AppResourcePrivateReadSubject = z.input<typeof subjectSchema>;
export type PrivateResourceRecord = Readonly<{ projection_id: string; ref: ResourceRefV2;
  resource_type: string; label: string; revision: string;
  data: Record<string, string | number | boolean>; freshness: 'unknown' }>;
export type PrivateResourceCheckpoint = Readonly<{ generation: number; cursor_sequence: number;
  last_applied_at: string | null; freshness: 'unknown' }>;
export type PrivateResourcePage = Readonly<{ items: readonly PrivateResourceRecord[];
  next_cursor: string | null; checkpoint: PrivateResourceCheckpoint }>;
export type AppResourcePrivateReadDeliveryGuard = (tx: AppRunTransaction) => Promise<void>;

export class AppResourcePrivateReadError extends Error {
  constructor(readonly code: 'APP_RESOURCE_PRIVATE_UNAVAILABLE' | 'APP_RESOURCE_PRIVATE_CURSOR_STALE'
    | 'APP_RESOURCE_PRIVATE_INPUT_INVALID', readonly status: 400 | 404 | 409) {
    super(code === 'APP_RESOURCE_PRIVATE_CURSOR_STALE' ? 'Private resource page changed; restart the read'
      : code === 'APP_RESOURCE_PRIVATE_INPUT_INVALID' ? 'Invalid private resource read'
        : 'Private resource unavailable');
    this.name = 'AppResourcePrivateReadError';
  }
}
const unavailable = () => new AppResourcePrivateReadError('APP_RESOURCE_PRIVATE_UNAVAILABLE', 404);
const invalid = () => new AppResourcePrivateReadError('APP_RESOURCE_PRIVATE_INPUT_INVALID', 400);

/** Host-internal seam: callers must authenticate a current human session before
 * constructing the subject. Neither a ResourceRef nor a Worker assertion grants access. */
export class AppResourcePrivateReadService {
  readonly #secrets: AppResourceSyncSecretService;
  constructor(private readonly keys: AppRunKeyProvider,
    private readonly clock: () => Date = () => new Date(),
    private readonly repository: Pick<PostgresAppRunRepository, 'transaction'> = new PostgresAppRunRepository(),
    private readonly deliveryGuard?: AppResourcePrivateReadDeliveryGuard) {
    this.#secrets = new AppResourceSyncSecretService(keys);
  }

  async ownerPrivateSearchScope(rawSubject: AppResourcePrivateReadSubject, bindingId: string) {
    const subject = subjectSchema.safeParse(rawSubject);
    const id = uuid.safeParse(bindingId);
    if (!subject.success || !id.success) throw invalid();
    return this.#read(subject.data, id.data, async (_tx, authority) => ({
      field_keys: Object.keys(authority.descriptor.record_schema.properties).sort(),
      label_field: authority.descriptor.label_field,
      consent_expires_at: authority.binding.consent_expires_at!.toISOString(),
    }));
  }

  /** Exhaustive across a coherent saved checkpoint via explicit continuation.
   * The caller injects the bounded search transaction factory and verified SID. */
  async searchOwnerPrivateResources(rawSubject: AppResourcePrivateReadSubject,
    rawInput: z.input<typeof searchSchema>, webSessionId: string, signal?: AbortSignal,
    deadline = performance.now() + 3000): Promise<PrivateSearchPage> {
    const subject = subjectSchema.safeParse(rawSubject), input = searchSchema.safeParse(rawInput);
    if (!subject.success || !input.success || !uuid.safeParse(webSessionId).success) throw invalid();
    const fields = [...input.data.field_keys].sort();
    const needle = input.data.query.toLowerCase();
    let expires = 0;
    const check = () => { signal?.throwIfAborted(); if (performance.now() >= deadline
      || expires && this.clock().getTime() >= expires) throw unavailable(); };
    const result = await this.#read(subject.data, input.data.resource_binding_id, async (tx, authority, checkpoint) => {
      check();
      if (fields.some(key => !Object.hasOwn(authority.descriptor.record_schema.properties, key))) throw invalid();
      const b = authority.binding;
      const identity_scope = privateSearchDigest({ org: subject.data.org_id, owner: subject.data.user_id,
        sid: webSessionId, binding: b.id, registration: authority.registration.id, app: b.app_installation_id,
        version: b.app_version_id, grant: b.grant_snapshot_id, lifecycle: authority.installation.lifecycle_epoch,
        grant_epoch: authority.installation.grant_epoch, descriptor: b.descriptor_digest,
        runtime_epoch: authority.registration.runtime_epoch, operator: authority.registration.operator_user_id,
        registration_contract: authority.registration.contract_version, grant_kind: b.grant_snapshot_kind,
        consent: b.consent_expires_at!.toISOString() });
      const checkpoint_scope = privateSearchDigest({ id: checkpoint.id, generation: checkpoint.generation,
        sequence: checkpoint.cursor_sequence });
      const query_fields_scope = privateSearchDigest({ query: input.data.query, fields });
      let cursor;
      try { cursor = input.data.cursor ? openPrivateSearchCursor(this.keys, input.data.cursor) : null; }
      catch { throw unavailable(); }
      if (cursor && (cursor.identity_scope !== identity_scope || cursor.query_fields_scope !== query_fields_scope)) throw unavailable();
      if (cursor && cursor.checkpoint_scope !== checkpoint_scope) throw new AppResourcePrivateReadError('APP_RESOURCE_PRIVATE_CURSOR_STALE', 409);
      expires = cursor?.expires_at ?? Math.min(this.clock().getTime() + APP_RESOURCE_PRIVATE_SEARCH_LIMITS.cursor_ms,
        b.consent_expires_at!.getTime());
      check();
      const locators = await tx.select({ id: appResourceProjections.id, bytes: appResourceProjections.body_bytes })
        .from(appResourceProjections).where(and(...this.#scope(subject.data.org_id, b.id, checkpoint),
          cursor ? gt(appResourceProjections.id, cursor.after) : undefined))
        .orderBy(asc(appResourceProjections.id)).limit(APP_RESOURCE_PRIVATE_SEARCH_LIMITS.scan_records + 1);
      check();
      let bytes = 0;
      const selected: string[] = [];
      for (const locator of locators.slice(0, APP_RESOURCE_PRIVATE_SEARCH_LIMITS.scan_records)) {
        if (locator.bytes > APP_RESOURCE_PRIVATE_SEARCH_LIMITS.scan_bytes) throw unavailable();
        if (bytes + locator.bytes > APP_RESOURCE_PRIVATE_SEARCH_LIMITS.scan_bytes) break;
        bytes += locator.bytes; selected.push(locator.id);
      }
      const rows = selected.length ? await tx.select().from(appResourceProjections).where(and(
        ...this.#scope(subject.data.org_id, b.id, checkpoint), inArray(appResourceProjections.id, selected)))
        .orderBy(asc(appResourceProjections.id)) : [];
      if (rows.length !== selected.length) throw unavailable();
      const items: PrivateSearchPage['items'][number][] = [];
      let scanned = 0, after: string | null = null;
      for (const row of rows) {
        check();
        const record = this.#record(row, authority);
        let hit: PrivateSearchPage['items'][number] | undefined;
        for (const key of fields) {
          const value = record.data[key];
          if (value === undefined) continue;
          const text = String(value), at = text.toLowerCase().indexOf(needle);
          if (at < 0) continue;
          const start = Math.max(0, at - 60);
          hit = { ref: record.ref, label: record.label,
            snippet: text.slice(start, start + APP_RESOURCE_PRIVATE_SEARCH_LIMITS.snippet_chars), field_key: key,
            href: `/app-resources/${encodeURIComponent(record.ref.provider.provider_instance_id)}/${encodeURIComponent(record.resource_type)}/${encodeURIComponent(record.projection_id)}` };
          break;
        }
        if (hit && items.length >= APP_RESOURCE_PRIVATE_SEARCH_LIMITS.items) break;
        if (hit) items.push(hit);
        scanned++; after = row.id;
        if (items.length === APP_RESOURCE_PRIVATE_SEARCH_LIMITS.items) break;
      }
      const complete = scanned === locators.length;
      const next_cursor = !complete && after ? sealPrivateSearchCursor(this.keys, {
        after, expires_at: expires, identity_scope, checkpoint_scope, query_fields_scope }) : null;
      if (!complete && !next_cursor) throw unavailable();
      const page: PrivateSearchPage = { schema_version: 'deft.app_private_search_page.v1', items,
        scan: { records_scanned: scanned, complete }, next_cursor, freshness: 'unknown',
        consent_expires_at: b.consent_expires_at!.toISOString() };
      if (Buffer.byteLength(JSON.stringify(page), 'utf8') > APP_RESOURCE_PRIVATE_SEARCH_LIMITS.response_bytes) throw unavailable();
      return page;
    });
    check();
    return result;
  }

  async listOwnerPrivateResourcePage(rawSubject: AppResourcePrivateReadSubject,
    rawInput: z.input<typeof pageSchema>): Promise<PrivateResourcePage> {
    const subject = subjectSchema.safeParse(rawSubject);
    const input = pageSchema.safeParse(rawInput);
    if (!subject.success || !input.success) throw invalid();
    return this.#read(subject.data, input.data.resource_binding_id, async (tx, authority, checkpoint) => {
      const cursor = input.data.cursor ? this.#openCursor(input.data.cursor) : null;
      if (cursor && (cursor.org_id !== subject.data.org_id
        || cursor.resource_binding_id !== authority.binding.id)) throw unavailable();
      if (cursor && (cursor.checkpoint_id !== checkpoint.id || cursor.generation !== checkpoint.generation
        || cursor.cursor_sequence !== checkpoint.cursor_sequence)) {
        throw new AppResourcePrivateReadError('APP_RESOURCE_PRIVATE_CURSOR_STALE', 409);
      }
      const limit = input.data.limit ?? APP_RESOURCE_PRIVATE_READ_LIMITS.items;
      const rows = await tx.select().from(appResourceProjections).where(and(
        ...this.#scope(subject.data.org_id, authority.binding.id, checkpoint),
        cursor ? gt(appResourceProjections.id, cursor.after) : undefined,
      )).orderBy(asc(appResourceProjections.id)).limit(limit + 1);
      const metadata = this.#checkpoint(checkpoint);
      const items: PrivateResourceRecord[] = [];
      let nextCursor: string | null = null;
      for (const [index, row] of rows.slice(0, limit).entries()) {
        const item = this.#record(row, authority);
        const candidateCursor = index + 1 < rows.length ? this.#sealCursor({
          org_id: subject.data.org_id, resource_binding_id: authority.binding.id,
          checkpoint_id: checkpoint.id, generation: checkpoint.generation,
          cursor_sequence: checkpoint.cursor_sequence, after: row.id,
        }) : null;
        const candidate = { items: [...items, item], next_cursor: candidateCursor, checkpoint: metadata };
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > APP_RESOURCE_PRIVATE_READ_LIMITS.response_bytes) {
          if (items.length === 0) throw unavailable();
          // The preceding cursor already points to the last returned row; the
          // oversized candidate will be considered first on the next page.
          break;
        }
        items.push(item);
        nextCursor = candidateCursor;
      }
      return { items, next_cursor: nextCursor, checkpoint: metadata };
    });
  }

  async getOwnerPrivateResource(rawSubject: AppResourcePrivateReadSubject,
    rawInput: z.input<typeof oneSchema>): Promise<Readonly<{
      item: PrivateResourceRecord; checkpoint: PrivateResourceCheckpoint }>> {
    const subject = subjectSchema.safeParse(rawSubject);
    const input = oneSchema.safeParse(rawInput);
    if (!subject.success || !input.success) throw invalid();
    return this.#read(subject.data, input.data.resource_binding_id, async (tx, authority, checkpoint) => {
      const [row] = await tx.select().from(appResourceProjections).where(and(
        ...this.#scope(subject.data.org_id, authority.binding.id, checkpoint),
        eq(appResourceProjections.id, input.data.projection_id),
      )).limit(1);
      if (!row) throw unavailable();
      return { item: this.#record(row, authority), checkpoint: this.#checkpoint(checkpoint) };
    });
  }

  /** Canonical host display only. Locators nominate authority; they never grant it. */
  async resolveOwnerPrivateDisplay(rawSubject: AppResourcePrivateReadSubject,
    rawRef: unknown): Promise<Readonly<{ label: string }>> {
    const record = await this.getOwnerPrivateResourceByRef(rawSubject, rawRef);
    return { label: record.label };
  }

  /** Same exact owner consent as the canonical private reader, for trusted host
   * human navigation only. This never authorizes Worker, agent or share access. */
  async getOwnerPrivateResourceByRef(rawSubject: AppResourcePrivateReadSubject,
    rawRef: unknown): Promise<Readonly<{ ref: ResourceRefV2; label: string;
      data: PrivateResourceRecord['data']; freshness: 'unknown'; consent_expires_at: string; search_href: string }>> {
    const subject = subjectSchema.safeParse(rawSubject);
    const ref = AppRuntimeResourceRefV2Schema.safeParse(rawRef);
    if (!subject.success) throw invalid();
    if (!ref.success || !uuid.safeParse(ref.data.resource_id).success
      || !uuid.safeParse(ref.data.provider.provider_instance_id).success) throw unavailable();
    return this.#read(subject.data, async tx => {
      const [locator] = await tx.select({ binding_id: appResourceBindings.id })
        .from(appResourceProjections).innerJoin(appResourceBindings, and(
          eq(appResourceBindings.org_id, appResourceProjections.org_id),
          eq(appResourceBindings.id, appResourceProjections.resource_binding_id)))
        .where(and(eq(appResourceProjections.org_id, subject.data.org_id),
          eq(appResourceProjections.id, ref.data.resource_id),
          eq(appResourceBindings.runtime_registration_id, ref.data.provider.provider_instance_id),
          eq(appResourceBindings.resource_family, ref.data.resource_type),
          eq(appResourceBindings.owner_user_id, subject.data.user_id))).limit(1);
      if (!locator) throw unavailable();
      return locator.binding_id;
    }, async (tx, authority, checkpoint) => {
      // Recheck the exact locator against locked, live authority after any wait.
      if (authority.registration.id !== ref.data.provider.provider_instance_id.toLowerCase()
        || authority.descriptor.resource_type !== ref.data.resource_type) throw unavailable();
      const [row] = await tx.select().from(appResourceProjections).where(and(
        ...this.#scope(subject.data.org_id, authority.binding.id, checkpoint),
        eq(appResourceProjections.id, ref.data.resource_id),
      )).limit(1);
      if (!row) throw unavailable();
      const record = this.#record(row, authority);
      const result = { ref: record.ref, label: record.label, data: record.data,
        freshness: 'unknown' as const,
        search_href: `/app-resources/search/${authority.binding.id}`,
        consent_expires_at: authority.binding.consent_expires_at!.toISOString() };
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > APP_RESOURCE_PRIVATE_READ_LIMITS.response_bytes) {
        throw unavailable();
      }
      return result;
    });
  }

  async #read<T>(subject: AppResourcePrivateReadSubject,
    bindingLocator: string | ((tx: AppRunTransaction) => Promise<string>),
    read: (tx: AppRunTransaction, authority: Authority, checkpoint: Checkpoint) => Promise<T>): Promise<T> {
    return this.repository.transaction(async (tx) => {
      const bindingId = typeof bindingLocator === 'string' ? bindingLocator : await bindingLocator(tx);
      const authority = await loadLiveResourceSyncBindingAuthority(tx, {
        org_id: subject.org_id, resource_binding_id: bindingId, clock: this.clock,
      });
      if (!authority || authority.binding.owner_user_id !== subject.user_id) throw unavailable();
      await tx.execute(sql`SELECT id FROM app_sync_checkpoints WHERE org_id = ${subject.org_id}
        AND resource_binding_id = ${bindingId} AND state = 'active' FOR SHARE`);
      const checkpoints = await tx.select().from(appSyncCheckpoints).where(and(
        eq(appSyncCheckpoints.org_id, subject.org_id), eq(appSyncCheckpoints.resource_binding_id, bindingId),
        eq(appSyncCheckpoints.state, 'active'),
      )).limit(2);
      const checkpoint = checkpoints[0];
      if (!checkpoint || checkpoints.length !== 1) throw unavailable();
      const assertConsent = () => {
        const now = this.clock();
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())
          || !authority.binding.consent_expires_at || authority.binding.consent_expires_at <= now) throw unavailable();
      };
      assertConsent();
      const result = await read(tx, authority, checkpoint);
      // Host session/Experience checks belong inside these authority locks and
      // before the last clock check: their own row locks may wait past consent.
      await this.deliveryGuard?.(tx);
      if (!await resourceSyncParticipantsAreHuman(tx, authority.binding.owner_user_id,
        authority.registration.operator_user_id)) throw unavailable();
      assertConsent();
      if (!isAppResourceSyncChannelEnabled()) throw unavailable();
      return result;
    });
  }

  #scope(orgId: string, bindingId: string, checkpoint: Checkpoint) {
    return [eq(appResourceProjections.org_id, orgId), eq(appResourceProjections.resource_binding_id, bindingId),
      eq(appResourceProjections.checkpoint_id, checkpoint.id),
      eq(appResourceProjections.generation, checkpoint.generation), eq(appResourceProjections.state, 'live')];
  }

  #checkpoint(checkpoint: Checkpoint): PrivateResourceCheckpoint {
    // Settlement currently makes no provider freshness assertion. Its timestamp
    // is a host observation, never evidence that the provider is current.
    return { generation: checkpoint.generation, cursor_sequence: checkpoint.cursor_sequence,
      last_applied_at: checkpoint.last_applied_at?.toISOString() ?? null, freshness: 'unknown' };
  }

  #record(row: typeof appResourceProjections.$inferSelect, authority: Authority): PrivateResourceRecord {
    try {
      const body = z.strictObject({ revision: z.string(), data: z.unknown() }).parse(this.#secrets.openJson({
        schema_version: row.body_envelope_version, algorithm: row.body_algorithm,
        key_version: row.body_key_version, nonce_b64: row.body_nonce_b64,
        ciphertext_b64: row.body_ciphertext_b64, auth_tag_b64: row.body_auth_tag_b64,
      }, { org_id: row.org_id, resource_binding_id: row.resource_binding_id,
        checkpoint_id: row.checkpoint_id, payload_kind: 'projection', generation: row.generation,
        projection_id: row.id, slot: 'record' }));
      // The ID is only a parser placeholder; never decrypt the provider ID.
      // Its minimum length cannot inflate a valid near-ceiling stored page.
      const parsed = parseSyncPage(authority.descriptor, {
        schema_version: 'deft.app_sync_request.v1', cursor: null, max_items: 1,
      }, { schema_version: 'deft.app_sync_page.v1', upserts: [{ id: 'x', ...body }],
        tombstones: [], next_cursor: null, has_more: false }).upserts[0]!;
      const label = (parsed.data[authority.descriptor.label_field] as string)
        .replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
      const ref = AppRuntimeResourceRefV2Schema.parse({ schema_version: 'deft.resource_ref.v2',
        provider: { kind: 'app_runtime', provider_instance_id: authority.registration.id },
        resource_type: authority.descriptor.resource_type, resource_id: row.id });
      return { projection_id: row.id, ref, resource_type: authority.descriptor.resource_type,
        label, revision: parsed.revision, data: parsed.data, freshness: 'unknown' };
    } catch { throw unavailable(); }
  }

  #sealCursor(value: Omit<Cursor, 'version' | 'key_version'>): string {
    const key = this.keys.current('fingerprint');
    try {
      const payload = Buffer.from(canonicalCapabilityJson(cursorSchema.parse({ ...value,
        version: 1, key_version: key.key_id }))).toString('base64url');
      const mac = createHmac('sha256', key.key).update('deft.resource_private_read.cursor.v1\0')
        .update(payload).digest('base64url');
      return `${payload}.${mac}`;
    } finally { key.key.fill(0); }
  }

  #openCursor(value: string): Cursor {
    try {
      const parts = value.split('.');
      if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/u.test(part))) throw unavailable();
      const payload = parts[0]!;
      const bytes = Buffer.from(payload, 'base64url');
      if (bytes.toString('base64url') !== payload) throw unavailable();
      const cursor = cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
      const key = this.keys.read('fingerprint', cursor.key_version);
      if (!key) throw unavailable();
      try {
        const mac = Buffer.from(parts[1]!, 'base64url');
        const expected = createHmac('sha256', key.key).update('deft.resource_private_read.cursor.v1\0')
          .update(payload).digest();
        if (mac.length !== expected.length || mac.toString('base64url') !== parts[1]
          || !timingSafeEqual(mac, expected)) throw unavailable();
      } finally { key.key.fill(0); }
      return cursor;
    } catch { throw unavailable(); }
  }
}

type Authority = NonNullable<Awaited<ReturnType<typeof loadLiveResourceSyncBindingAuthority>>>;
type Checkpoint = typeof appSyncCheckpoints.$inferSelect;
