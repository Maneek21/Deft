import { z } from 'zod';
import { parseRuntimeObjectInput, RuntimeObjectSchema } from '@deft/app-kit/core';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import type { AppExperienceExposureService, BrowseAuthorityPhase } from './app-experience-exposure.js';
import type { ExperienceCaller } from './app-experience-service.js';
import type { AppConnectionProjection } from './app-connection-contract.js';
import { getAppConnectionRegistry, type AppConnectionRegistry } from './app-connection-registry.js';
import { experienceProviderHandles, type ExperienceProviderHandles, type ProviderSourceRecord } from './app-experience-provider-handles.js';
import { exposureDigest, exposurePayloadData, exposureUnavailable } from './app-experience-exposure-contract.js';

export const ProviderBrowseRequestSchema = z.strictObject({ operation: z.literal('browse'),
  kind: z.enum(['list', 'search', 'conversation']), folder: z.string().min(1).max(128).regex(/^[a-z][a-z0-9_]*$/),
  query: z.string().max(200).refine(value => !/[\r\n\0]/.test(value)).optional(),
  filters:z.record(z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u).refine(key=>!['constructor','prototype','__proto__'].includes(key)),
    z.union([z.string().min(1).max(500).refine(value=>!/[\r\n\0]/u.test(value)),z.boolean()]))
    .refine(value=>Object.keys(value).length>0&&Object.keys(value).length<=32).optional(),
  cursor: z.string().uuid().optional(), record_id: z.string().uuid().optional() })
  .refine(value => value.kind === 'search' ? (!!value.query?.trim()!==!!value.filters) && !value.record_id
    : value.kind === 'conversation' ? !!value.record_id && !value.query&&!value.filters : !value.query && !value.record_id&&!value.filters);
const scalar = z.union([z.string().max(4096), z.number().finite(), z.boolean()]);
const RecordSchema = z.strictObject({ revision: z.string().min(1).max(1024), label: z.string().max(200),
  data: z.record(z.string().min(1).max(48), scalar).refine(value => Object.keys(value).length <= 32
    && !Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))),
  provider_source: z.record(z.string().min(1).max(128), z.json()).refine(value => Object.keys(value).length <= 16
    && !Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))
    && Buffer.byteLength(JSON.stringify(value)) <= 8192) });
const PageSchema = z.strictObject({ schema_version: z.literal('deft.app_provider_browse_page.v1'), items: z.array(RecordSchema).max(10),
  next_cursor: z.string().min(1).max(2048).nullable(), complete: z.boolean(), observed_at: z.iso.datetime(),
  count: z.strictObject({ returned: z.number().int().min(0).max(10), exact_total: z.null() }),
  failure_count: z.number().int().min(0).max(10) })
  .refine(page => (!page.complete || page.next_cursor === null && page.failure_count === 0) && page.count.returned === page.items.length);
type Authority = Pick<AppExperienceExposureService, 'providerAuthority' | 'connectionSetup' | 'sourceRecord' | 'browseAuthority'>;
type Cursor = { query_digest: string; cursor: string; source_id: string | null };
type BrowseTiming = { elapsed_ms: number; provider_ms: number; recheck_ms: number; recheck_calls: number; recheck_reads: number; outcome: 'success' | 'unavailable'; code: string | null; authority_phase: BrowseAuthorityPhase };
const identity = (projection: AppConnectionProjection) => {
  const { checked_at: _checked, expires_at: _expires, ...pins } = projection; return exposureDigest(pins);
};

/** Read-only provider pages under the existing reviewed Experience source. No
 * caller-selected account, durable projection write or checkpoint mutation. */
export class AppExperienceProviderBrowseService {
  constructor(private readonly keys: AppRunKeyProvider, private readonly authority: Authority,
    private readonly registry: () => Promise<AppConnectionRegistry> = getAppConnectionRegistry,
    private readonly handles: ExperienceProviderHandles = experienceProviderHandles,
    private readonly now = Date.now, private readonly timeoutMs = 60000,
    private readonly observe: (timing: BrowseTiming) => void = timing => {
      if (process.env.NODE_ENV === 'production') console.info(JSON.stringify({ event: 'app_resource_browse_timing', ...timing }));
    }) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('Invalid provider page deadline');
  }
  async read(caller: ExperienceCaller, sessionId: string, resourceKey: string, raw: unknown, signal?: AbortSignal) {
    const input = ProviderBrowseRequestSchema.parse(raw), controller = new AbortController();
    const workSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    workSignal.throwIfAborted();
    let reject!: (error: Error) => void;
    const limit = new Promise<never>((_, fail) => { reject = fail; });
    const abort = () => reject(exposureUnavailable()); workSignal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = performance.now(), timing: BrowseTiming = { elapsed_ms: 0, provider_ms: 0, recheck_ms: 0, recheck_calls: 0, recheck_reads: 0, outcome: 'unavailable', code: null, authority_phase: { locked_ms: 0, package_verify_ms: 0, package_verify_calls: 0, projection_ms: 0, final_ms: 0, db_query_ms: 0, db_query_count: 0, db_acquisition_ms: 0 } };
    try { const result = await Promise.race([this.current(caller, sessionId, resourceKey, input, workSignal, timing), limit]); timing.outcome = 'success'; return result; }
    catch (error) { const code = error instanceof Error ? error.message : ''; timing.code = /^[A-Z][A-Z0-9_]{1,99}$/.test(code) ? code : 'PROVIDER_BROWSE_UNAVAILABLE'; throw exposureUnavailable(); }
    finally { clearTimeout(timer); workSignal.removeEventListener('abort', abort); timing.elapsed_ms = performance.now() - started;
      try { this.observe({ ...timing, authority_phase: { ...timing.authority_phase }, elapsed_ms: Math.round(timing.elapsed_ms), provider_ms: Math.round(timing.provider_ms), recheck_ms: Math.round(timing.recheck_ms) }); } catch { /* Diagnostics cannot affect authority or mail. */ }
    }
  }
  private async current(caller: ExperienceCaller, sessionId: string, resourceKey: string,
    input: z.infer<typeof ProviderBrowseRequestSchema>, signal: AbortSignal, timing: BrowseTiming) {
    const started = this.now();
    const nomination = await this.authority.providerAuthority(caller, sessionId, resourceKey, signal);
    signal.throwIfAborted();
    const entry = (await this.registry()).select({ org_id: caller.org_id, owner_user_id: caller.user_id,
      installation_id: nomination.installation_id, target_key: nomination.target_key });
    if (entry.pins.resource_key !== resourceKey || entry.pins.resource_binding_id !== nomination.resource_binding_id
      || !entry.adapter.browseResource) throw exposureUnavailable();
    const initial = structuredClone(await this.authority.connectionSetup(caller, sessionId, entry.pins, signal, 'browse_resource'));
    const operation = input.kind === 'search' ? 'search' : input.kind === 'conversation' ? 'read_one' : 'list_summary';
    if (initial.purpose !== 'browse_resource' || !initial.allowed_operations.includes(operation)
      || Object.entries(entry.pins).some(([key, value]) => initial[key as keyof typeof initial] !== value)
      || initial.web_session_id !== caller.sid || initial.experience_session_id !== sessionId) throw exposureUnavailable();
    if(input.filters&&Object.keys(input.filters).some(key=>!initial.content_policy?.search_filters?.includes(key as never)))throw exposureUnavailable();
    const deadline = Math.min(nomination.expires_at, initial.expires_at, started + this.timeoutMs);
    const check = () => { signal.throwIfAborted(); if (!Number.isFinite(deadline) || this.now() >= deadline) throw exposureUnavailable(); };
    let pendingRecheck: Promise<AppConnectionProjection> | null = null;
    const recheck = async () => {
      check();
      timing.recheck_calls++;
      if (!pendingRecheck) pendingRecheck = (async () => {
      const at = performance.now(); timing.recheck_reads++;
      try {
      const { projection: current, nomination: scope } = await this.authority.browseAuthority(caller, sessionId, resourceKey, entry.pins, signal, phase => { for (const key of Object.keys(timing.authority_phase) as (keyof BrowseAuthorityPhase)[]) timing.authority_phase[key] += phase[key]; });
      if (identity(current) !== identity(initial) || scope.handle_scope !== nomination.handle_scope
        || current.expires_at < deadline || scope.expires_at < deadline) throw exposureUnavailable();
      check(); return { ...current, expires_at: deadline };
      } finally { timing.recheck_ms += performance.now() - at; }
      })().finally(() => { pendingRecheck = null; });
      const current = await pendingRecheck;
      check(); if (identity(current) !== identity(initial) || current.expires_at < deadline) throw exposureUnavailable();
      return { ...current };
    };
    const query_digest = exposureDigest({ kind: input.kind, folder: input.folder, query: input.query ?? '',filters:input.filters??null, record_id: input.record_id ?? null });
    const continuation = input.cursor ? this.handles.read<Cursor>(this.keys, nomination.handle_scope, 'cursor', input.cursor) : null;
    if (input.cursor && (!continuation || continuation.query_digest !== query_digest || continuation.source_id !== (input.record_id ?? null))) throw exposureUnavailable();
    const parent = input.record_id ? await this.authority.sourceRecord(caller, sessionId, resourceKey, input.record_id, signal) : null;
    if (parent && (parent.resource_binding_id !== nomination.resource_binding_id || parent.target_key !== nomination.target_key
      || parent.installation_id !== nomination.installation_id)) throw exposureUnavailable();
    await recheck();
    let page: z.infer<typeof PageSchema>;
    const providerStarted=performance.now();try {page = PageSchema.parse(await entry.adapter.browseResource({ operation: input.kind, folder: input.folder,
      ...(input.filters?{filters:input.filters}:{}),
      query: input.query ?? '', cursor: continuation?.cursor ?? null, source: parent?.record ?? null, limit: Math.min(10, nomination.max_records_per_page) },
    { projection: { ...initial, expires_at: deadline }, recheck, signal, search_fields: nomination.allowed_fields })); }
      finally { timing.provider_ms = performance.now() - providerStarted; }
    await recheck();
    if (page.items.length > nomination.max_records_per_page || Date.parse(page.observed_at) > this.now()
      || Buffer.byteLength(JSON.stringify(page)) > Math.min(524288, nomination.max_page_bytes)) throw exposureUnavailable();
    if (parent && exposureDigest(parent) !== exposureDigest(await this.authority.sourceRecord(caller, sessionId, resourceKey, input.record_id!, signal))) throw exposureUnavailable();
    const records: ProviderSourceRecord[] = page.items.map(record => {
      const parsed = parseRuntimeObjectInput(RuntimeObjectSchema.parse(nomination.record_schema), record.data);
      const data = exposurePayloadData(Object.fromEntries(Object.entries(parsed).filter(([key]) => nomination.allowed_fields.includes(key))), nomination.allowed_fields);
      const label = nomination.allowed_fields.includes(nomination.label_field) ? String(data[nomination.label_field] ?? '')
        .replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 200) : '';
      return { ...record, label, data };
    });
    if (records.some(record => Buffer.byteLength(JSON.stringify(record)) > 32768)) throw exposureUnavailable();
    const placeholder = { schema_version: 'deft.experience_provider_page.v1', items: records.map(record => ({ record_id: '0'.repeat(36), label: record.label, data: record.data })),
      next_cursor: page.next_cursor === null ? null : '0'.repeat(36), complete: page.complete, observed_at: page.observed_at,
      count: page.count, failure_count: page.failure_count };
    if (Buffer.byteLength(JSON.stringify({ version: 'deft.experience_bridge.v1', kind: 'response', session_id: sessionId,
      request_id: 'request_' + '9'.repeat(56), ok: true, output: placeholder })) > 60 * 1024) throw exposureUnavailable();
    check();
    const items = records.map(record => ({ record_id: this.handles.put(this.keys, nomination.handle_scope, nomination.handle_group,
      'source', record, Math.min(nomination.expires_at, initial.expires_at)), label: record.label, data: record.data }));
    const next_cursor = page.next_cursor === null ? null : this.handles.put(this.keys, nomination.handle_scope, nomination.handle_group,
      'cursor', { query_digest, cursor: page.next_cursor, source_id: input.record_id ?? null }, Math.min(nomination.expires_at, initial.expires_at));
    check();
    return { exposure_id: nomination.exposure_id, exposure_epoch: nomination.exposure_epoch,
      output: { ...placeholder, items, next_cursor } };
  }
}
