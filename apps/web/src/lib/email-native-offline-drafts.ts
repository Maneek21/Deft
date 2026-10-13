import { parseNativeDraftContent, type NativeDraftContent } from './email-native-drafts';

/** Local browser recovery only. This ID is not an installation or authority ID. */
export type NativeOfflineDraftScope = Readonly<{
  orgId: string;
  userId: string;
  accountId: string;
  draftId: string;
}>;

export type NativeOfflineDraftSnapshot = Readonly<{
  localRevision: number;
  baseServerRevision: number;
  content: NativeDraftContent;
  dirty: boolean;
  sendOutcome: 'none' | 'unknown';
  updatedAt: number;
}>;

export type NativeOfflineDraftReconnect = 'no_local_copy' | 'base_unchanged' | 'server_changed' | 'unknown_send_blocked';

export type NativeOfflineDraftMetadata = Readonly<{
  draftId: string;
  branchId: string | null;
  localRevision: number;
  baseServerRevision: number;
  dirty: boolean;
  sendOutcome: 'none' | 'unknown';
  updatedAt: number;
}>;

export type NativeOfflineDraftLimits = Readonly<{
  maxOwnerBytes: number;
  maxOwnerRecords: number;
  maxDraftBytes: number;
}>;

export const nativeOfflineDraftLimits: NativeOfflineDraftLimits = Object.freeze({
  maxOwnerBytes: 64 * 1024 * 1024,
  maxOwnerRecords: 200,
  maxDraftBytes: 480 * 1024,
});

export type NativeOfflineDraftStoredRow = {
  id: string;
  owner: string;
  record: string;
  branch: string;
  localRevision: number;
  baseServerRevision: number;
  dirty: boolean;
  sendOutcome: 'none' | 'unknown';
  updatedAt: number;
  bytes: number;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
};
type OfflineRow = NativeOfflineDraftStoredRow;

/** Narrow persistence seam makes CAS behavior testable without claiming browser-IDB proof. */
export interface NativeOfflineDraftDriver {
  deviceId(): Promise<string>;
  key(owner: string, create: () => Promise<CryptoKey>): Promise<CryptoKey>;
  read(id: string): Promise<OfflineRow | null>;
  list(owner: string): Promise<OfflineRow[]>;
  commit(input: {
    owner: string;
    headId: string;
    expectedRevision: number;
    head: OfflineRow;
    conflict: OfflineRow;
    limits: NativeOfflineDraftLimits;
  }): Promise<'saved' | 'conflict_saved' | 'conflict_capacity' | 'quota'>;
  remove(id: string, owner: string, expectedRevision: number): Promise<boolean>;
}

const DB = 'deft-email-offline-drafts-v1';
const DEVICE_KEY = 'browser-profile-device-id';
const textEncoder = new TextEncoder();
const validPart = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const request = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error ?? new Error('Offline storage request failed'));
});
const transactionDone = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error ?? new Error('Offline storage transaction aborted'));
  tx.onerror = () => reject(tx.error ?? new Error('Offline storage transaction failed'));
});

function createIndexedDbDriver(factory: IDBFactory): NativeOfflineDraftDriver {
  let opening: Promise<IDBDatabase> | null = null;
  const open = () => opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('drafts')) {
        const rows = db.createObjectStore('drafts', { keyPath: 'id' });
        rows.createIndex('owner', 'owner', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opening = null; reject(req.error ?? new Error('Offline database could not open')); };
    req.onblocked = () => { opening = null; reject(new Error('Offline database upgrade is blocked by another tab')); };
  });

  return {
    async deviceId() {
      const db = await open();
      const read = db.transaction('meta', 'readonly');
      const current = await request(read.objectStore('meta').get(DEVICE_KEY));
      await transactionDone(read);
      if (typeof current === 'string' && /^[0-9a-f-]{36}$/u.test(current)) return current;
      const candidate = crypto.randomUUID();
      const tx = db.transaction('meta', 'readwrite');
      const done = transactionDone(tx), store = tx.objectStore('meta');
      const raced = await request(store.get(DEVICE_KEY));
      if (typeof raced === 'string' && /^[0-9a-f-]{36}$/u.test(raced)) {
        await done;
        return raced;
      }
      store.put(candidate, DEVICE_KEY);
      await done;
      return candidate;
    },
    async key(owner, create) {
      const db = await open();
      const read = db.transaction('keys', 'readonly');
      const current: unknown = await request(read.objectStore('keys').get(owner));
      await transactionDone(read);
      if (current && typeof current === 'object' && 'type' in current && current.type === 'secret') return current as CryptoKey;
      const candidate = await create();
      const tx = db.transaction('keys', 'readwrite');
      const done = transactionDone(tx), store = tx.objectStore('keys');
      const raced: unknown = await request(store.get(owner));
      const chosen = raced && typeof raced === 'object' && 'type' in raced && raced.type === 'secret' ? raced as CryptoKey : candidate;
      if (chosen === candidate) store.put(candidate, owner);
      await done;
      return chosen;
    },
    async read(id) {
      const db = await open(), tx = db.transaction('drafts', 'readonly');
      const value: unknown = await request(tx.objectStore('drafts').get(id));
      await transactionDone(tx);
      return value && typeof value === 'object' ? value as OfflineRow : null;
    },
    async list(owner) {
      const db = await open(), tx = db.transaction('drafts', 'readonly');
      const values: unknown = await request(tx.objectStore('drafts').index('owner').getAll(IDBKeyRange.only(owner), nativeOfflineDraftLimits.maxOwnerRecords + 1));
      await transactionDone(tx);
      return Array.isArray(values) ? values as OfflineRow[] : [];
    },
    async commit(input) {
      const db = await open(), tx = db.transaction('drafts', 'readwrite');
      const done = transactionDone(tx), store = tx.objectStore('drafts');
      try {
        const current = await request(store.get(input.headId)) as OfflineRow | undefined;
        const currentRevision = current?.localRevision ?? 0;
        const rows = await request(store.index('owner').getAll(IDBKeyRange.only(input.owner), input.limits.maxOwnerRecords + 1)) as OfflineRow[];
        if (current?.sendOutcome === 'unknown' || currentRevision !== input.expectedRevision) {
          // Conflicts retain the current head; quota includes every existing row.
          const bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
          if (rows.length + 1 > input.limits.maxOwnerRecords || bytes + input.conflict.bytes > input.limits.maxOwnerBytes) {
            tx.abort(); await done.catch(() => undefined); return 'conflict_capacity';
          }
          store.put(input.conflict);
          await done;
          return 'conflict_saved';
        }
        const retained = rows.filter(row => row.id !== input.headId);
        const bytes = retained.reduce((sum, row) => sum + row.bytes, 0);
        const records = retained.length;
        if (records + 1 > input.limits.maxOwnerRecords || bytes + input.head.bytes > input.limits.maxOwnerBytes) {
          tx.abort(); await done.catch(() => undefined); return 'quota';
        }
        store.put(input.head);
        await done;
        return 'saved';
      } catch (error) {
        tx.abort(); await done.catch(() => undefined); throw error;
      }
    },
    async remove(id, owner, expectedRevision) {
      const db = await open(), tx = db.transaction('drafts', 'readwrite');
      const done = transactionDone(tx), store = tx.objectStore('drafts');
      const current = await request(store.get(id)) as OfflineRow | undefined;
      if (!current || current.owner !== owner || current.localRevision !== expectedRevision || current.sendOutcome === 'unknown') {
        tx.abort(); await done.catch(() => undefined); return false;
      }
      store.delete(id);
      await done;
      return true;
    },
  };
}

function assertScope(scope: NativeOfflineDraftScope) {
  if (![scope.orgId, scope.userId, scope.accountId, scope.draftId].every(validPart)) throw new Error('Offline draft scope is invalid');
}

export function classifyNativeOfflineDraftReconnect(local: NativeOfflineDraftSnapshot | null, serverRevision: number): NativeOfflineDraftReconnect {
  if (!Number.isSafeInteger(serverRevision) || serverRevision < 0) throw new Error('Server draft revision is invalid');
  if (!local) return 'no_local_copy';
  if (local.sendOutcome === 'unknown') return 'unknown_send_blocked';
  return local.baseServerRevision === serverRevision ? 'base_unchanged' : 'server_changed';
}

function storageError(error: unknown): NativeOfflineDraftError {
  return new NativeOfflineDraftError(error && typeof error === 'object' && 'name' in error && error.name === 'QuotaExceededError' ? 'quota' : 'storage');
}

export class NativeOfflineDraftError extends Error {
  constructor(readonly code: 'denied' | 'invalid' | 'quota' | 'conflict' | 'not_found' | 'storage') {
    super(code === 'denied' ? 'Confirm this account before opening its local draft.'
      : code === 'quota' ? 'Browser storage is full. Your editor contents are still available; no saved draft was removed.'
      : code === 'conflict' ? 'Another tab changed this local draft. Your version was kept as a separate recovery copy when space allowed.'
      : code === 'not_found' ? 'This local draft is no longer available.'
      : code === 'invalid' ? 'This local draft exceeds supported limits.'
      : 'Browser draft recovery is unavailable. Your editor contents are still available.');
  }
}

export async function createNativeEmailOfflineDraftJournal(
  scope: NativeOfflineDraftScope,
  options: {
    /** Must reflect a freshly verified account or a still-current open-tab offline lease. */
    authorize: (scope: NativeOfflineDraftScope) => boolean | Promise<boolean>;
    indexedDB?: IDBFactory;
    driver?: NativeOfflineDraftDriver;
    limits?: NativeOfflineDraftLimits;
    now?: () => number;
  },
) {
  assertScope(scope);
  const authorize = async () => {
    if (!await options.authorize(scope)) throw new NativeOfflineDraftError('denied');
  };
  const driver = options.driver ?? (typeof indexedDB !== 'undefined' ? createIndexedDbDriver(options.indexedDB ?? indexedDB) : null);
  if (!driver) throw new NativeOfflineDraftError('storage');
  const limits = options.limits ?? nativeOfflineDraftLimits;
  if (![limits.maxOwnerBytes, limits.maxOwnerRecords, limits.maxDraftBytes].every(Number.isSafeInteger)
    || limits.maxOwnerBytes < 1 || limits.maxOwnerBytes > nativeOfflineDraftLimits.maxOwnerBytes
    || limits.maxOwnerRecords < 1 || limits.maxOwnerRecords > nativeOfflineDraftLimits.maxOwnerRecords
    || limits.maxDraftBytes < 1 || limits.maxDraftBytes > nativeOfflineDraftLimits.maxDraftBytes) throw new NativeOfflineDraftError('invalid');
  const now = options.now ?? Date.now;
  let deviceId: string;
  try { deviceId = await driver.deviceId(); } catch (error) { throw storageError(error); }
  if (!/^[0-9a-f-]{36}$/u.test(deviceId)) throw new NativeOfflineDraftError('storage');
  const owner = JSON.stringify([scope.orgId, scope.userId, deviceId]);
  const record = JSON.stringify([scope.accountId, scope.draftId]);
  const headId = JSON.stringify([owner, record, 'head']);
  let key: CryptoKey;
  try { key = await driver.key(owner, () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])); }
  catch (error) { throw storageError(error); }
  const aad = (row: Pick<OfflineRow, 'owner' | 'record' | 'branch' | 'localRevision' | 'baseServerRevision' | 'dirty' | 'sendOutcome'>) => textEncoder.encode(JSON.stringify([
    'deft.email.offline-draft.v1', row.owner, row.record, row.branch, row.localRevision,
    row.baseServerRevision, row.dirty, row.sendOutcome,
  ]));
  const validRow = (row: OfflineRow | null): row is OfflineRow => Boolean(row && row.owner === owner && row.record === record
    && row.id === JSON.stringify([owner, record, row.branch])
    && Number.isSafeInteger(row.localRevision) && row.localRevision >= 1
    && Number.isSafeInteger(row.baseServerRevision) && row.baseServerRevision >= 0
    && typeof row.dirty === 'boolean' && ['none', 'unknown'].includes(row.sendOutcome)
    && Number.isFinite(row.updatedAt) && Number.isSafeInteger(row.bytes) && row.bytes >= 1 && row.bytes <= limits.maxDraftBytes
    && row.iv instanceof Uint8Array && row.iv.length === 12 && row.ciphertext instanceof ArrayBuffer
    && row.ciphertext.byteLength === row.bytes + 16);
  const decrypt = async (row: OfflineRow): Promise<NativeOfflineDraftSnapshot> => {
    if (!validRow(row)) throw new NativeOfflineDraftError('storage');
    await authorize();
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv as Uint8Array<ArrayBuffer>, additionalData: aad(row) }, key, row.ciphertext);
      const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)) as unknown;
      const content = parseNativeDraftContent(payload);
      if (textEncoder.encode(JSON.stringify(content)).byteLength > limits.maxDraftBytes) throw new Error('Oversized offline draft');
      await authorize();
      return { localRevision: row.localRevision, baseServerRevision: row.baseServerRevision, content, dirty: row.dirty, sendOutcome: row.sendOutcome, updatedAt: row.updatedAt };
    } catch (error) {
      if (error instanceof NativeOfflineDraftError) throw error;
      throw new NativeOfflineDraftError('storage');
    }
  };
  const encryptRow = async (branch: string, localRevision: number, baseServerRevision: number, contentValue: NativeDraftContent, dirty: boolean, sendOutcome: 'none' | 'unknown'): Promise<OfflineRow> => {
    const content = parseNativeDraftContent(contentValue);
    const plain = textEncoder.encode(JSON.stringify(content));
    if (plain.byteLength > limits.maxDraftBytes) throw new NativeOfflineDraftError('invalid');
    const row: OfflineRow = { id: JSON.stringify([owner, record, branch]), owner, record, branch, localRevision, baseServerRevision, dirty, sendOutcome, updatedAt: now(), bytes: plain.byteLength, iv: crypto.getRandomValues(new Uint8Array(12)), ciphertext: new ArrayBuffer(0) };
    row.ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: row.iv as Uint8Array<ArrayBuffer>, additionalData: aad(row) }, key, plain);
    return row;
  };
  const readRaw = async () => {
    await authorize();
    let row: OfflineRow | null;
    try { row = await driver.read(headId); } catch (error) { throw storageError(error); }
    return row ? decrypt(row) : null;
  };
  return {
    deviceId,
    async read() { return readRaw(); },
    async put(input: { expectedLocalRevision: number; baseServerRevision: number; content: NativeDraftContent; dirty?: boolean; sendOutcome?: 'none' | 'unknown' }) {
      await authorize();
      if (!Number.isSafeInteger(input.expectedLocalRevision) || input.expectedLocalRevision < 0
        || !Number.isSafeInteger(input.baseServerRevision) || input.baseServerRevision < 0) throw new NativeOfflineDraftError('invalid');
      const dirty = input.dirty ?? true, sendOutcome = input.sendOutcome ?? 'none';
      if (sendOutcome === 'unknown' && !dirty) throw new NativeOfflineDraftError('invalid');
      const head = await encryptRow('head', input.expectedLocalRevision + 1, input.baseServerRevision, input.content, dirty, sendOutcome);
      const conflict = await encryptRow(`conflict:${crypto.randomUUID()}`, 1, input.baseServerRevision, input.content, dirty, sendOutcome);
      // Consent may expire while WebCrypto is encrypting; check again before commit.
      await authorize();
      let result: Awaited<ReturnType<NativeOfflineDraftDriver['commit']>>;
      try { result = await driver.commit({ owner, headId, expectedRevision: input.expectedLocalRevision, head, conflict, limits }); }
      catch (error) { throw storageError(error); }
      if (result === 'quota') throw new NativeOfflineDraftError('quota');
      if (result === 'conflict_capacity') throw new NativeOfflineDraftError('conflict');
      if (result === 'conflict_saved') throw new NativeOfflineDraftError('conflict');
      return decrypt(head);
    },
    async conflicts() {
      await authorize();
      let rows: OfflineRow[];
      try { rows = await driver.list(owner); } catch (error) { throw storageError(error); }
      const result = rows.filter(row => row.record === record && row.branch.startsWith('conflict:'))
        .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
        .map(row => ({ branchId: row.branch.slice('conflict:'.length), localRevision: row.localRevision, baseServerRevision: row.baseServerRevision, dirty: row.dirty, sendOutcome: row.sendOutcome, updatedAt: row.updatedAt }));
      await authorize();
      return result;
    },
    async readConflict(branchId: string) {
      await authorize();
      if (!/^[0-9a-f-]{36}$/u.test(branchId)) throw new NativeOfflineDraftError('invalid');
      let row: OfflineRow | null;
      try { row = await driver.read(JSON.stringify([owner, record, `conflict:${branchId}`])); } catch (error) { throw storageError(error); }
      if (!row) throw new NativeOfflineDraftError('not_found');
      return decrypt(row);
    },
    async remove(expectedLocalRevision: number) {
      await authorize();
      if (!Number.isSafeInteger(expectedLocalRevision) || expectedLocalRevision < 1) throw new NativeOfflineDraftError('invalid');
      let removed: boolean;
      try { removed = await driver.remove(headId, owner, expectedLocalRevision); } catch (error) { throw storageError(error); }
      if (!removed) throw new NativeOfflineDraftError('conflict');
    },
    async listOwnerUsage() {
      await authorize();
      let rows: OfflineRow[];
      try { rows = await driver.list(owner); } catch (error) { throw storageError(error); }
      const result = { records: rows.length, bytes: rows.reduce((total, row) => total + row.bytes, 0), overLimit: rows.length > limits.maxOwnerRecords, limits };
      await authorize();
      return result;
    },
    async listAccount(): Promise<NativeOfflineDraftMetadata[]> {
      await authorize();
      let rows: OfflineRow[];
      try { rows = await driver.list(owner); } catch (error) { throw storageError(error); }
      const result = rows.flatMap((row): NativeOfflineDraftMetadata[] => {
        if (typeof row.record !== 'string' || typeof row.branch !== 'string'
          || !Number.isSafeInteger(row.bytes) || row.bytes < 1
          || !Number.isSafeInteger(row.localRevision) || row.localRevision < 1
          || !Number.isSafeInteger(row.baseServerRevision) || row.baseServerRevision < 0
          || typeof row.dirty !== 'boolean' || !['none', 'unknown'].includes(row.sendOutcome)
          || !Number.isFinite(row.updatedAt)) return [];
        let parts: unknown;
        try { parts = JSON.parse(row.record); } catch { return []; }
        if (!Array.isArray(parts) || parts.length !== 2 || parts[0] !== scope.accountId || !validPart(parts[1])) return [];
        const branchId = row.branch.startsWith('conflict:') ? row.branch.slice('conflict:'.length) : null;
        if (row.branch !== 'head' && (!branchId || !/^[0-9a-f-]{36}$/u.test(branchId))) return [];
        return [{ draftId: parts[1], branchId, localRevision: row.localRevision, baseServerRevision: row.baseServerRevision,
          dirty: row.dirty, sendOutcome: row.sendOutcome, updatedAt: row.updatedAt }];
      }).sort((a, b) => a.updatedAt - b.updatedAt || a.draftId.localeCompare(b.draftId) || (a.branchId ?? '').localeCompare(b.branchId ?? ''));
      await authorize();
      return result;
    },
  };
}
