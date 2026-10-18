import type { ComposerInput } from './app-experience-action-composer';
export type DraftRecoveryScope = Readonly<{ orgId: string; userId: string; installationId: string; stateKey: string; recordId: string }>;
type Row = { id: string; owner: string; revision: number; baseRevision: number; expiresAt: number; bytes: number; iv: Uint8Array; ciphertext: ArrayBuffer };
export type DraftSubmission = Readonly<{ key: string; state: 'pending' | 'known'; runId?: string }>;
const DB = 'deft-private-draft-recovery-v1';
const request = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
function done(transaction: IDBTransaction) { return new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error || Error('Recovery write aborted')); }); }
async function open(): Promise<IDBDatabase> {
  const opened = indexedDB.open(DB, 1);
  opened.onupgradeneeded = () => { opened.result.createObjectStore('keys'); const rows = opened.result.createObjectStore('drafts', { keyPath: 'id' }); rows.createIndex('owner', 'owner'); };
  return request(opened);
}
export function recoveryIdentity(scope: DraftRecoveryScope) {
  if (![scope.orgId, scope.userId, scope.installationId, scope.recordId].every(value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) || !/^[a-zA-Z0-9_]{1,80}$/.test(scope.stateKey)) throw Error('Invalid recovery scope');
  const owner = JSON.stringify([scope.orgId, scope.userId, scope.installationId, scope.stateKey]);
  return { owner, id: JSON.stringify([scope.orgId, scope.userId, scope.installationId, scope.stateKey, scope.recordId]) };
}
export async function createDraftRecoveryJournal(scope: DraftRecoveryScope) {
  const identity = recoveryIdentity(scope), database = await open();
  let key: CryptoKey;
  {
    const read = database.transaction('keys', 'readonly'); const found: unknown = await request(read.objectStore('keys').get(identity.owner));
    if (found instanceof CryptoKey) key = found;
    else {
      const generated = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const write = database.transaction('keys', 'readwrite'), completion = done(write), store = write.objectStore('keys');
      const concurrent: unknown = await request(store.get(identity.owner)); key = concurrent instanceof CryptoKey ? concurrent : generated;
      if (!(concurrent instanceof CryptoKey)) store.put(key, identity.owner); await completion;
    }
  }
  let localRevision = 0;
  const aad = (row: Pick<Row, 'baseRevision' | 'expiresAt'>) => new TextEncoder().encode(JSON.stringify([identity.id, row.baseRevision, row.expiresAt]));
  return {
    async read(): Promise<{ baseRevision: number; value: ComposerInput; submission?: DraftSubmission } | null> {
      const tx = database.transaction('drafts', 'readonly'); const row = await request(tx.objectStore('drafts').get(identity.id)) as Row | undefined;
      if (row && (row.id !== identity.id || row.owner !== identity.owner || !Number.isSafeInteger(row.revision) || row.revision < 1 || !Number.isSafeInteger(row.baseRevision) || row.baseRevision < 0 || !Number.isFinite(row.expiresAt) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 16384 || !(row.iv instanceof Uint8Array) || row.iv.length !== 12 || !(row.ciphertext instanceof ArrayBuffer) || row.ciphertext.byteLength !== row.bytes + 16)) throw Error('Invalid recovery envelope');
      localRevision = row?.revision || 0; if (!row) return null;
      if (row.expiresAt <= Date.now()) { await this.clear(); return null; }
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv as Uint8Array<ArrayBuffer>, additionalData: aad(row) }, key, row.ciphertext);
      const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decrypted));
      if (!payload || typeof payload !== 'object' || !('value' in payload) || !('submission' in payload)) throw Error('Invalid recovery envelope');
      const value = payload.value;
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 32 || Object.values(value).some(item => item !== null && !['string', 'number', 'boolean'].includes(typeof item))) throw Error('Invalid recovery data');
      const submission = payload.submission;
      if (submission !== null && (!submission || typeof submission !== 'object' || !('key' in submission) || submission.key !== scope.recordId || !('state' in submission) || !['pending','known'].includes(String(submission.state)) || ('runId' in submission && typeof submission.runId !== 'string'))) throw Error('Invalid submission recovery');
      return { baseRevision: row.baseRevision, value: value as ComposerInput, ...(submission ? { submission: submission as DraftSubmission } : {}) };
    },
    async put(baseRevision: number, value: ComposerInput, submission?: DraftSubmission) {
      const expectedLocalRevision = localRevision;
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw Error('Invalid saved revision');
      const plain = new TextEncoder().encode(JSON.stringify({value,submission:submission || null})); if (plain.byteLength > 16384) throw Error('Recovery draft too large');
      const row: Row = { ...identity, revision: expectedLocalRevision + 1, baseRevision, expiresAt: Date.now() + 30 * 86400000, bytes: plain.byteLength, iv: crypto.getRandomValues(new Uint8Array(12)), ciphertext: new ArrayBuffer(0) };
      row.ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: row.iv as Uint8Array<ArrayBuffer>, additionalData: aad(row) }, key, plain);
      const tx = database.transaction('drafts', 'readwrite'), completion = done(tx), store = tx.objectStore('drafts');
      const current = await request(store.get(identity.id)) as Row | undefined;
      if ((current?.revision || 0) !== expectedLocalRevision) { tx.abort(); await completion.catch(() => undefined); throw Error('Recovery changed in another tab'); }
      const rows = await request(store.index('owner').getAll(IDBKeyRange.only(identity.owner), 33)) as Row[];
      const retained = rows.filter(item => item.expiresAt > Date.now());
      for (const expired of rows.filter(item => item.expiresAt <= Date.now())) store.delete(expired.id);
      if (retained.length > 32 || (!current && retained.length >= 32) || retained.filter(item => item.id !== identity.id).reduce((sum, item) => sum + item.bytes, 0) + row.bytes > 131072) { tx.abort(); await completion.catch(() => undefined); throw Error('Browser draft recovery capacity reached'); }
      store.put(row); await completion; localRevision = row.revision;
    },
    async clear() {
      const expectedLocalRevision = localRevision;
      const tx = database.transaction('drafts', 'readwrite'), completion = done(tx), store = tx.objectStore('drafts');
      const current = await request(store.get(identity.id)) as Row | undefined;
      if ((current?.revision || 0) !== expectedLocalRevision) { tx.abort(); await completion.catch(() => undefined); throw Error('Recovery changed in another tab'); }
      store.delete(identity.id); await completion; localRevision = 0;
    },
    close() { database.close(); },
  };
}
