import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import { exposureUnavailable } from './app-experience-exposure-contract.js';

type Entry = { scope: string; group: string; kind: 'source' | 'cursor'; expires: number;
  key: string; nonce: Buffer; tag: Buffer; bytes: Buffer };
export type ProviderSourceRecord = { revision: string; label: string; data: Record<string, string | number | boolean>;
  provider_source: Record<string, unknown> };
/** Transient encrypted handles are never projections, deletion evidence or Run history.
 * Restart/eviction loses only browsing handles; the caller must reload explicitly. */
export class ExperienceProviderHandles {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly maxEntries = 4096, private readonly ownerEntries = 1000,
    private readonly ownerBytes = 16 * 1024 * 1024, private readonly now = Date.now) {
    if (![maxEntries, ownerEntries, ownerBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Invalid transient handle bound');
  }
  private remove(id: string) { const entry = this.entries.get(id); entry?.bytes.fill(0); this.entries.delete(id); }
  put(keys: AppRunKeyProvider, scope: string, group: string, kind: Entry['kind'], value: unknown, expires: number, restoredId?: string) {
    const plain = Buffer.from(JSON.stringify(value));
    if (!Number.isFinite(expires) || expires <= this.now() || plain.length > 32768) throw exposureUnavailable();
    const ref = keys.current('run_encryption'), nonce = randomBytes(12), id = restoredId ?? randomUUID();
    if (restoredId && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(restoredId)) { plain.fill(0); ref.key.fill(0); throw exposureUnavailable(); }
    try {
      const cipher = createCipheriv('aes-256-gcm', ref.key, nonce);
      cipher.setAAD(Buffer.from(JSON.stringify(['deft.experience.provider_handle.v1', id, scope, group, kind, expires])));
      const bytes = Buffer.concat([cipher.update(plain), cipher.final()]);
      if (restoredId) this.remove(id);
      for (const [key, entry] of this.entries) if (entry.expires <= this.now()) this.remove(key);
      const owned = () => [...this.entries].filter(([, entry]) => entry.group === group);
      while (owned().length >= this.ownerEntries || owned().reduce((sum, [, entry]) => sum + entry.bytes.length, 0) + bytes.length > this.ownerBytes) {
        const first = owned()[0]; if (!first) { bytes.fill(0); throw exposureUnavailable(); } this.remove(first[0]);
      }
      while (this.entries.size >= this.maxEntries) this.remove(this.entries.keys().next().value!);
      this.entries.set(id, { scope, group, kind, expires, key: ref.key_id, nonce, tag: cipher.getAuthTag(), bytes });
      return id;
    } finally { plain.fill(0); ref.key.fill(0); }
  }
  clear() { for (const id of [...this.entries.keys()]) this.remove(id); }
  read<T>(keys: AppRunKeyProvider, scope: string, kind: Entry['kind'], id: string): T | null {
    const entry = this.entries.get(id); if (!entry) return null;
    if (entry.scope !== scope || entry.kind !== kind || entry.expires <= this.now()) throw exposureUnavailable();
    const ref = keys.read('run_encryption', entry.key); if (!ref) throw exposureUnavailable();
    let plain: Buffer | undefined;
    try {
      const cipher = createDecipheriv('aes-256-gcm', ref.key, entry.nonce);
      cipher.setAAD(Buffer.from(JSON.stringify(['deft.experience.provider_handle.v1', id, entry.scope, entry.group, entry.kind, entry.expires])));
      cipher.setAuthTag(entry.tag); plain = Buffer.concat([cipher.update(entry.bytes), cipher.final()]);
      this.entries.delete(id); this.entries.set(id, entry);
      return JSON.parse(plain.toString()) as T;
    } catch { throw exposureUnavailable(); }
    finally { ref.key.fill(0); plain?.fill(0); }
  }
}
export const experienceProviderHandles = new ExperienceProviderHandles();
