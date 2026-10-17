import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { appPrivateStateRecords } from '@deft/db/schema';
import type { ExperienceCaller } from './app-experience-service.js';
import { AppExperienceExposureService } from './app-experience-exposure.js';
import { exposureDigest } from './app-experience-exposure-contract.js';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import { AppPrivateStateSecrets, privateStateStoredBytes } from './app-private-state-secrets.js';
import { PrivateStateRequestSchema, privateStateValue, assertPrivateStateCas, assertPrivateStateQuota } from './app-private-state-contract.js';
import { AppError } from './app-errors.js';
import { privateAccessClockBounds, samplePrivateAccessClock } from './app-private-access-clock.js';

export class AppPrivateStateService {
  private readonly secrets: AppPrivateStateSecrets;
  constructor(keys: AppRunKeyProvider, private readonly exposure = new AppExperienceExposureService(keys),
    private readonly clock: () => Date = () => new Date()) { this.secrets = new AppPrivateStateSecrets(keys); }
  async request(caller: ExperienceCaller, sessionId: string, key: string, raw: unknown, signal?: AbortSignal) {
    const parsed = PrivateStateRequestSchema.safeParse(raw);
    if (!parsed.success) throw new AppError('Invalid private state request', 'APP_ACTION_INVALID', 400);
    const request = parsed.data;
    return this.exposure.withPrivateState(caller, sessionId, key, async (tx, authority) => {
      const { declaration, artifact_digest, installation_id } = authority;
      const declaration_digest = exposureDigest(declaration);
      const quotaScope = and(eq(appPrivateStateRecords.org_id, caller.org_id), eq(appPrivateStateRecords.owner_user_id, caller.user_id),
        eq(appPrivateStateRecords.installation_id, installation_id), eq(appPrivateStateRecords.state_key, key));
      const scope = and(quotaScope, eq(appPrivateStateRecords.resource_target_key, authority.session.resource_target_key));
      // The owner/key advisory lock preserves one quota across all artifacts and targets.
      const dispatchedAt = performance.now(), applicationSample = this.clock().getTime();
      const sampled = await tx.execute(sql`SELECT (extract(epoch FROM clock_timestamp())*1000)::text AS now_ms`);
      const receivedAt = performance.now(), databaseSample = Number(sampled.rows[0]?.now_ms);
      const clock = privateAccessClockBounds(this.clock, applicationSample, databaseSample, dispatchedAt, receivedAt);
      const createdAt = new Date(databaseSample), now = clock.current();
      // Tombstones fence retries until original retention expiry. Expired identifiers
      // are then purged; an expired session can never replay its old request.
      const expired = await tx.select({ id: appPrivateStateRecords.record_id }).from(appPrivateStateRecords)
        .where(and(quotaScope, sql`${appPrivateStateRecords.expires_at} <= ${now}`)).limit(50);
      if (expired.length) await tx.delete(appPrivateStateRecords).where(and(quotaScope, inArray(appPrivateStateRecords.record_id, expired.map(row => row.id))));
      const rows = await tx.select().from(appPrivateStateRecords).where(and(quotaScope,
        sql`${appPrivateStateRecords.deleted_at} IS NULL AND ${appPrivateStateRecords.expires_at}>${now}`))
        .orderBy(asc(appPrivateStateRecords.record_id)).limit(33);
      if (rows.length > 32) throw new AppError('Private state active record quota reached', 'APP_STATE_CONFLICT', 409);
      const active = rows;
      const visible = active.filter(row => row.resource_target_key === authority.session.resource_target_key
        && row.artifact_digest === artifact_digest && row.declaration_digest === declaration_digest);
      let deadline = Infinity;
      const currentUntil = (expiresAt: Date) => { deadline = Math.min(deadline, expiresAt.getTime()); };
      authority.onFinalCheck(async () => {
        const finalClock = await samplePrivateAccessClock(tx, this.clock);
        if (Math.max(clock.current().getTime(), finalClock.current().getTime()) >= deadline) throw new AppError('Private state expired', 'APP_ACTION_UNAVAILABLE', 409);
      });
      authority.onDeliveryCheck(() => {
        if (clock.current().getTime() >= deadline) throw new AppError('Private state expired', 'APP_ACTION_UNAVAILABLE', 409);
      });
      const meta = (row: typeof rows[number]) => ({ record_id: row.record_id, revision: row.revision,
        updated_at: row.updated_at.toISOString(), expires_at: row.expires_at.toISOString() });
      if (request.operation === 'list') {
        active.forEach(row => currentUntil(row.expires_at));
        return { operation: 'list', items: visible.map(meta), quota: {
          used_records: active.length, max_records: declaration.max_records,
          used_bytes: active.reduce((sum, row) => sum + row.byte_length, 0), max_total_bytes: declaration.max_total_bytes,
        } };
      }
      const [row] = await tx.select().from(appPrivateStateRecords).where(and(scope, eq(appPrivateStateRecords.record_id, request.record_id))).limit(1);
      if (row && (row.artifact_digest !== artifact_digest || row.declaration_digest !== declaration_digest)) {
        throw new AppError('Private state requires explicit artifact adoption', 'APP_STALE', 409);
      }
      const context = (revision: number) => ({ org_id: caller.org_id, owner_user_id: caller.user_id,
        installation_id, state_key: key, record_id: request.record_id, artifact_digest, declaration_digest, revision,
        ...(authority.session.resource_target_key === 'primary' ? {} : { resource_target_key: authority.session.resource_target_key }) });
      if (request.operation === 'read') {
        if (!row || row.deleted_at || row.expires_at <= now) throw new AppError('Private state not found', 'APP_NOT_FOUND', 404);
        currentUntil(row.expires_at);
        try {
          const opened = this.secrets.openState(context(row.revision),row.body);
          const checked = privateStateValue(declaration,opened.value);
          authority.restoreSources(opened.sources,checked.value,row.expires_at);
          return { operation: 'read', item: { ...meta(row), value: checked.value } };
        } catch { throw new AppError('Private state unavailable', 'APP_ACTION_UNAVAILABLE', 409); }
      }
      assertPrivateStateCas(request.expected_revision, row?.revision);
      if (request.operation === 'put' && !row) {
        // UUIDs are installation-wide. A guessed identifier from another source
        // cannot overwrite it or turn a guarded conflict into an internal error.
        const [existingIdentifier] = await tx.select({ id: appPrivateStateRecords.record_id }).from(appPrivateStateRecords).where(and(
          eq(appPrivateStateRecords.org_id, caller.org_id), eq(appPrivateStateRecords.owner_user_id, caller.user_id),
          eq(appPrivateStateRecords.installation_id, installation_id), eq(appPrivateStateRecords.state_key, key),
          eq(appPrivateStateRecords.record_id, request.record_id))).limit(1);
        if (existingIdentifier) throw new AppError('Private state identifier already exists', 'APP_STATE_CONFLICT', 409);
      }
      if (request.operation === 'delete') {
        if (!row) throw new AppError('Private state not found', 'APP_NOT_FOUND', 404);
        if (row.deleted_at || row.expires_at <= now) return { operation: 'delete', record_id: row.record_id, revision: row.revision };
        await tx.update(appPrivateStateRecords).set({ revision: row.revision + 1, body: null, key_version: null,
          byte_length: 0, deleted_at: now, updated_at: now }).where(and(scope, eq(appPrivateStateRecords.record_id, row.record_id)));
        return { operation: 'delete', record_id: row.record_id, revision: row.revision + 1 };
      }
      if (row && (row.deleted_at || row.expires_at <= now)) throw new AppError('Private state was deleted or expired', 'APP_STATE_CONFLICT', 409);
      let checked: ReturnType<typeof privateStateValue>;
      try { checked = privateStateValue(declaration, request.value); }
      catch { throw new AppError('Private state violates its reviewed schema or record quota', 'APP_ACTION_INVALID', 400); }
      const previous = row ? this.secrets.openState(context(row.revision),row.body).sources : [];
      const sources = await authority.retainSources(request.source_refs,checked.value,previous);
      const storedBytes = privateStateStoredBytes(checked.value,sources);
      if (storedBytes > declaration.max_record_bytes || storedBytes > 16384) throw new AppError('Private state source exceeds its reviewed record quota','APP_ACTION_INVALID',413);
      const [retained] = await tx.select({ count: sql<number>`count(*)::int` }).from(appPrivateStateRecords).where(quotaScope);
      if (!row && (retained?.count ?? 0) >= 4096) throw new AppError('Private state retained identifier safety cap reached', 'APP_STATE_CONFLICT', 409);
      assertPrivateStateQuota(active.length + (row ? 0 : 1), active.reduce((sum, item) => sum + item.byte_length, 0)
        - (row?.byte_length ?? 0) + storedBytes, declaration);
      const revision = (row?.revision ?? 0) + 1;
      const body = this.secrets.seal(context(revision), checked.value,sources);
      const expires_at = row?.expires_at ?? new Date(createdAt.getTime() + declaration.retention_days * 86400000);
      currentUntil(expires_at);
      if (row) await tx.update(appPrivateStateRecords).set({ revision, body, key_version: body.key_version,
        byte_length: storedBytes, updated_at: now }).where(and(scope, eq(appPrivateStateRecords.record_id, row.record_id)));
      else await tx.insert(appPrivateStateRecords).values({ org_id: caller.org_id, owner_user_id: caller.user_id,
        installation_id, state_key: key, record_id: request.record_id, artifact_digest, declaration_digest,
        resource_target_key: authority.session.resource_target_key,
        revision, body, key_version: body.key_version, byte_length: storedBytes, created_at: createdAt, updated_at: now, expires_at });
      return { operation: 'put', item: { record_id: request.record_id, revision, updated_at: now.toISOString(), expires_at: expires_at.toISOString() } };
    }, signal);
  }
}
