/** Public author-side SDK leaf. Bundlers inline this into the immutable Worker.
 * It contains no credential, URL, fetch or direct workspace API surface. */
export const DEFT_EXPERIENCE_SDK_VERSION = 'deft.experience_bridge.v1' as const;

export type ExperienceSdkPort = Pick<MessagePort, 'postMessage' | 'close' | 'onmessage'>;
export type ExperienceSdkIntent = 'resource' | 'open_resource' | 'action' | 'run_status' | 'run_cancel' | 'navigate' | 'dialog' | 'private_state';
export type ExperienceResourceSummaryPage = Readonly<{ schema_version: 'deft.experience_resource_payload.v1'; operation: 'list_summary';
  items: readonly Readonly<{ record_id: string; label: string }>[]; next_cursor: string | null; freshness: 'unknown' }>;
export type ExperienceResourceRecord = Readonly<{ schema_version: 'deft.experience_resource_payload.v1'; operation: 'read_one';
  item: Readonly<{ record_id: string; label: string; data: Readonly<Record<string, string | number | boolean>>; freshness: 'unknown' }> }>;
export type ExperienceResourceSearchPage = Readonly<{ schema_version: 'deft.experience_resource_search_page.v1'; operation: 'search';
  items: readonly Readonly<{ record_id: string; label: string; snippet: string; field_key: string }>[];
  scan: Readonly<{ records_scanned: number; complete: boolean }>; next_cursor: string | null; freshness: 'unknown' }>;
function resourceSearchReply(value: unknown, fields: readonly string[]): ExperienceResourceSearchPage {
  const object = (row: unknown): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row);
  const exact = (row: Record<string, unknown>, keys: readonly string[]) => Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
  if (!object(value) || !exact(value, ['schema_version', 'operation', 'items', 'scan', 'next_cursor', 'freshness'])
    || value.schema_version !== 'deft.experience_resource_search_page.v1' || value.operation !== 'search' || value.freshness !== 'unknown'
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > 60 * 1024 || !Array.isArray(value.items) || value.items.length > 10
    || !value.items.every(item => object(item) && exact(item, ['record_id', 'label', 'snippet', 'field_key'])
      && resourceRecordId(item.record_id) && typeof item.label === 'string' && item.label.length <= 200
      && typeof item.snippet === 'string' && item.snippet.length <= 240 && typeof item.field_key === 'string' && fields.includes(item.field_key))
    || !object(value.scan) || !exact(value.scan, ['records_scanned', 'complete'])
    || !Number.isInteger(value.scan.records_scanned) || (value.scan.records_scanned as number) < 0 || (value.scan.records_scanned as number) > 100
    || typeof value.scan.complete !== 'boolean' || value.scan.complete !== (value.next_cursor === null)
    || !(value.next_cursor === null || typeof value.next_cursor === 'string' && value.next_cursor.length > 0 && value.next_cursor.length <= 2048))
    throw new Error('Invalid Experience search response');
  return value as unknown as ExperienceResourceSearchPage;
}
const resourceRecordId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function resourceReply(value: unknown, operation: 'list_summary' | 'read_one') {
  const object = (row: unknown): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row);
  const exact = (row: Record<string, unknown>, keys: readonly string[]) => Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
  const label = (value: unknown) => typeof value === 'string' && value.length <= 200;
  const invalid = () => { throw new Error('Invalid Experience resource response'); };
  if (!object(value) || value.schema_version !== 'deft.experience_resource_payload.v1' || value.operation !== operation
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > 60 * 1024) return invalid();
  if (operation === 'list_summary') {
    if (!exact(value, ['schema_version', 'operation', 'items', 'next_cursor', 'freshness']) || value.freshness !== 'unknown'
      || !Array.isArray(value.items) || value.items.length > 10
      || !value.items.every(item => object(item) && exact(item, ['record_id', 'label']) && resourceRecordId(item.record_id) && label(item.label))
      || (value.next_cursor !== null && (typeof value.next_cursor !== 'string' || !value.next_cursor || value.next_cursor.length > 2048))) return invalid();
    return value as unknown as ExperienceResourceSummaryPage;
  }
  const item = value.item;
  if (!exact(value, ['schema_version', 'operation', 'item']) || !object(item)
    || !exact(item, ['record_id', 'label', 'data', 'freshness']) || !resourceRecordId(item.record_id) || !label(item.label) || item.freshness !== 'unknown'
    || !object(item.data) || Object.keys(item.data).length > 32
    || !Object.entries(item.data).every(([key, data]) => key.length > 0 && key.length <= 48 && !['__proto__', 'constructor', 'prototype'].includes(key)
      && (typeof data === 'boolean' || (typeof data === 'string' && data.length <= 4096) || (typeof data === 'number' && Number.isFinite(data))))) return invalid();
  return value as unknown as ExperienceResourceRecord;
}

export type ExperiencePrivateStateMeta = Readonly<{ record_id: string; revision: number; updated_at: string; expires_at: string }>;
export type ExperiencePrivateStateRecord = ExperiencePrivateStateMeta & Readonly<{ value: Readonly<Record<string, string | number | boolean>> }>;

export function createDeftExperienceSdk(port: ExperienceSdkPort, sessionId: string) {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(sessionId)) throw new Error('Invalid Experience session');
  let sequence = 0;
  let closed = false;
  const pending = new Map<string, { resolve(value: unknown): void; reject(reason: Error): void }>();
  let onUiEvent: ((event: unknown) => void) | undefined;
  port.onmessage = (message: MessageEvent) => {
    const value: unknown = message.data;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const reply = value as Record<string, unknown>;
    if (reply.version !== DEFT_EXPERIENCE_SDK_VERSION || reply.session_id !== sessionId) return;
    if (reply.kind === 'ui_event') { onUiEvent?.(reply.event); return; }
    if (reply.kind !== 'response' || typeof reply.request_id !== 'string') return;
    const promise = pending.get(reply.request_id);
    if (!promise) return;
    pending.delete(reply.request_id);
    if (reply.ok === true) promise.resolve(reply.output);
    else promise.reject(new Error(typeof reply.code === 'string' ? reply.code : 'UNAVAILABLE'));
  };
  const post = (message: Record<string, unknown>): number => {
    if (closed) throw new Error('Experience session closed');
    sequence += 1;
    port.postMessage({ version: DEFT_EXPERIENCE_SDK_VERSION,
      session_id: sessionId, sequence, ...message });
    return sequence;
  };
  const request = (operation: ExperienceSdkIntent, key?: string, input?: unknown): Promise<unknown> => {
    if (pending.size >= 16) return Promise.reject(new Error('Experience request limit'));
    const requestId = `request_${sequence + 1}`;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      try { post({ kind: 'request', request_id: requestId, operation, key, input }); }
      catch (error) { pending.delete(requestId); reject(error); }
    });
  };
  const resourceKey = (key: string) => {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(key)) throw new Error('Invalid resource key');
  };
  return Object.freeze({
    render(view: unknown): void { post({ kind: 'view', view }); },
    request,
    listPrivateState(key: string): Promise<Readonly<{ operation: 'list'; items: readonly ExperiencePrivateStateMeta[] }>> {
      resourceKey(key);
      return request('private_state', key, { operation: 'list' }) as Promise<{ operation: 'list'; items: ExperiencePrivateStateMeta[] }>;
    },
    readPrivateState(key: string, recordId: string): Promise<Readonly<{ operation: 'read'; item: ExperiencePrivateStateRecord }>> {
      resourceKey(key); if (!resourceRecordId(recordId)) throw new Error('Invalid private state record');
      return request('private_state', key, { operation: 'read', record_id: recordId }) as Promise<{ operation: 'read'; item: ExperiencePrivateStateRecord }>;
    },
    putPrivateState(key: string, recordId: string, revision: number, value: Readonly<Record<string, string | number | boolean>>): Promise<Readonly<{ operation: 'put'; item: ExperiencePrivateStateMeta }>> {
      resourceKey(key); if (!resourceRecordId(recordId) || !Number.isInteger(revision) || revision < 0 || revision > 2147483646
        || !value || Array.isArray(value) || Object.keys(value).length > 32 || new TextEncoder().encode(JSON.stringify(value)).byteLength > 16384) throw new Error('Invalid private state input');
      return request('private_state', key, { operation: 'put', record_id: recordId, expected_revision: revision, value }) as Promise<{ operation: 'put'; item: ExperiencePrivateStateMeta }>;
    },
    deletePrivateState(key: string, recordId: string, revision: number): Promise<Readonly<{ operation: 'delete'; record_id: string; revision: number }>> {
      resourceKey(key); if (!resourceRecordId(recordId) || !Number.isInteger(revision) || revision < 0 || revision > 2147483646) throw new Error('Invalid private state revision');
      return request('private_state', key, { operation: 'delete', record_id: recordId, expected_revision: revision }) as Promise<{ operation: 'delete'; record_id: string; revision: number }>;
    },
    listResourceSummaries(key: string, options: { limit?: number; cursor?: string } = {}): Promise<ExperienceResourceSummaryPage> {
      resourceKey(key);
      if (Object.keys(options).some(field => !['limit', 'cursor'].includes(field))
        || (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10))
        || (options.cursor !== undefined && (typeof options.cursor !== 'string' || !options.cursor || options.cursor.length > 2048))) {
        throw new Error('Invalid resource list input');
      }
      return request('resource', key, { schema_version: 'deft.experience_resource_request.v1', operation: 'list_summary', ...options })
        .then(value => resourceReply(value, 'list_summary') as ExperienceResourceSummaryPage);
    },
    readResourceRecord(key: string, recordId: string): Promise<ExperienceResourceRecord> {
      resourceKey(key);
      if (!resourceRecordId(recordId)) throw new Error('Invalid record locator');
      return request('resource', key, { schema_version: 'deft.experience_resource_request.v1', operation: 'read_one', record_id: recordId })
        .then(value => resourceReply(value, 'read_one') as ExperienceResourceRecord);
    },
    searchResourceRecords(key: string, options: { query: string; field_keys: readonly string[]; cursor?: string }): Promise<ExperienceResourceSearchPage> {
      resourceKey(key);
      if (Object.keys(options).some(field => !['query', 'field_keys', 'cursor'].includes(field))
        || typeof options.query !== 'string' || !options.query.trim() || options.query.length > 200
        || !Array.isArray(options.field_keys) || options.field_keys.length < 1 || options.field_keys.length > 32
        || new Set(options.field_keys).size !== options.field_keys.length
        || !options.field_keys.every(field => typeof field === 'string' && field.length > 0 && field.length <= 48 && !['__proto__', 'constructor', 'prototype'].includes(field))
        || options.cursor !== undefined && (typeof options.cursor !== 'string' || !options.cursor || options.cursor.length > 2048))
        throw new Error('Invalid resource search input');
      const fields = [...options.field_keys];
      return request('resource', key, { schema_version: 'deft.experience_resource_request.v2', operation: 'search',
        query: options.query, field_keys: fields, ...(options.cursor === undefined ? {} : { cursor: options.cursor }) })
        .then(value => resourceSearchReply(value, fields));
    },
    /** Open the host's owner-checked source and files panel. No URL or file bytes enter App code. */
    async openResource(key: string, recordId: string): Promise<Readonly<{ opened: true }>> {
      resourceKey(key); if (!resourceRecordId(recordId)) throw new Error('Invalid record locator');
      const result = await request('open_resource', key, { record_id: recordId });
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1
        || !('opened' in result) || result.opened !== true) throw new Error('Resource unavailable');
      return { opened: true };
    },
    onEvent(handler: (event: unknown) => void): void { onUiEvent = handler; },
    close(): void {
      if (closed) return;
      closed = true;
      for (const request of pending.values()) request.reject(new Error('Experience session closed'));
      pending.clear();
      port.onmessage = null;
      port.close();
    },
  });
}
