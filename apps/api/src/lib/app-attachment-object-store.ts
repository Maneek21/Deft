import { link, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { RESOURCE_ATTACHMENT_LIMITS } from '@deft/app-kit';
import { LocalFileStore } from './file-store.js';

export interface AppAttachmentObjectStore {
  putExclusive(objectId: string, ciphertext: Uint8Array, signal: AbortSignal): Promise<void>;
  get(objectId: string, signal: AbortSignal): Promise<Buffer>;
  delete(objectId: string): Promise<void>;
}

/** Quarantined ciphertext has no generic File row or client URL. A hard-link
 * publication is atomic and refuses an existing destination; rename would
 * overwrite one on common filesystems. Uncertain publication is never retried
 * with a new identity by this adapter. The custody row decides accessibility. */
export class LocalAppAttachmentObjectStore implements AppAttachmentObjectStore {
  readonly #files: LocalFileStore;
  constructor(rootDir = join(process.cwd(), 'uploads', 'app-attachments')) {
    this.#files = new LocalFileStore(rootDir);
  }
  #key(objectId: string): string {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(objectId)) {
      throw new TypeError('Invalid attachment object identity');
    }
    return objectId;
  }
  async putExclusive(objectId: string, ciphertext: Uint8Array, signal: AbortSignal): Promise<void> {
    const key = this.#key(objectId);
    if (ciphertext.byteLength > RESOURCE_ATTACHMENT_LIMITS.attachment_bytes) throw new TypeError('Attachment exceeds host limit');
    signal.throwIfAborted(); await mkdir(this.#files.rootDir, { recursive: true }); signal.throwIfAborted();
    // A crash before publication must leave a locator derived from the durable
    // reserved stage identity, rather than an unidentified ciphertext orphan.
    const temporary = join(this.#files.rootDir, `.pending-${key}`);
    let owned = false;
    try {
      const handle = await open(temporary, 'wx');
      owned = true;
      try { await handle.writeFile(ciphertext, { signal }); }
      finally { await handle.close(); }
      signal.throwIfAborted();
      await link(temporary, join(this.#files.rootDir, key));
      signal.throwIfAborted();
    } finally {
      // Never remove an existing pending writer when our exclusive open failed.
      if (owned) await unlink(temporary).catch(error => {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      });
    }
  }
  get(objectId: string, signal: AbortSignal): Promise<Buffer> {
    return this.#files.get(this.#key(objectId), { signal, maxBytes: RESOURCE_ATTACHMENT_LIMITS.attachment_bytes });
  }
  async delete(objectId: string): Promise<void> {
    const key = this.#key(objectId);
    await this.#files.delete(key);
    await unlink(join(this.#files.rootDir, `.pending-${key}`)).catch(error => {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    });
  }
}
