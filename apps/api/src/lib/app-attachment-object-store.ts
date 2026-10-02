import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RESOURCE_ATTACHMENT_LIMITS } from '@deft/app-kit';
import { LocalFileStore } from './file-store.js';

export interface AppAttachmentObjectStore {
  putExclusive(objectId: string, ciphertext: Uint8Array, signal: AbortSignal): Promise<void>;
  get(objectId: string, signal: AbortSignal): Promise<Buffer>;
  delete(objectId: string): Promise<void>;
}

/** Quarantined ciphertext has no generic File row or client URL. Direct wx
 * writes may be partial while uploading; only complete verified bytes can gain
 * ready authority. Purge permanently replaces the destination with an empty
 * inode, fencing late/restarted writers without a ciphertext temporary path. */
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
    const handle = await open(join(this.#files.rootDir, key), 'wx');
    try {
      await handle.writeFile(ciphertext, { signal });
      signal.throwIfAborted();
    } finally { await handle.close(); }
  }
  get(objectId: string, signal: AbortSignal): Promise<Buffer> {
    return this.#files.get(this.#key(objectId), { signal, maxBytes: RESOURCE_ATTACHMENT_LIMITS.attachment_bytes });
  }
  async delete(objectId: string): Promise<void> {
    const key = this.#key(objectId);
    await mkdir(this.#files.rootDir, { recursive: true });
    // Atomic replacement keeps the reserved namespace occupied after purge.
    // Concurrent marker interference must fail closed: an empty destination
    // can still belong to an uploading writer, so it is not proof of retirement.
    const marker = join(this.#files.rootDir, `.retiring-${key}`);
    await writeFile(marker, Buffer.alloc(0));
    try { await rename(marker, join(this.#files.rootDir, key)); }
    finally {
      await unlink(marker).catch(error => {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      });
    }
    // Compatibility with the unfrozen hard-link draft: remove its known
    // pending ciphertext too. New writers never create that path.
    await unlink(join(this.#files.rootDir, `.pending-${key}`)).catch(error => {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    });
  }
}
