import { mkdir, open, readFile, stat as fsStat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDiskFullError, reserveStorage, storageFullError, storageLimitApplies } from './workspace-limits.js';

export type StoredFileStat = {
  size: number;
  modifiedAt: Date;
};

export interface FileStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string, options?: Readonly<{ signal?: AbortSignal; maxBytes: number }>): Promise<Buffer>;
  stat(key: string): Promise<StoredFileStat | null>;
  delete(key: string): Promise<void>;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}

/** Where a storage key lives under an uploads folder. A key is one plain file name; anything else is refused. */
export function localStorageKeyPath(rootDir: string, key: string): string {
  const normalized = key.trim();
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/]/.test(normalized)) {
    throw new Error('Invalid storage key');
  }
  return join(rootDir, normalized);
}

export class LocalFileStore implements FileStore {
  readonly rootDir: string;

  constructor(rootDir = join(process.cwd(), 'uploads')) {
    this.rootDir = resolve(rootDir);
  }

  private pathFor(key: string): string {
    return localStorageKeyPath(this.rootDir, key);
  }

  /**
   * On a hosted cell: refused with a WorkspaceLimitError when the workspace is
   * at its storage limit (workspace-limits.ts), and a write the disk refuses
   * (ENOSPC) is removed and answered the same way. Self-hosted: as before.
   */
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    let release = (): void => undefined;
    let opened = false;
    try {
      await mkdir(this.rootDir, { recursive: true });
      release = await reserveStorage(this.rootDir, bytes.byteLength);
      opened = true;
      await writeFile(path, bytes);
    } catch (error) {
      if (!isDiskFullError(error) || !storageLimitApplies()) throw error;
      console.warn('[workspace-limit] the disk refused a file write (ENOSPC)');
      if (opened) await unlink(path).catch(() => undefined);
      throw storageFullError(null);
    } finally {
      release();
    }
  }

  async get(key: string, options?: Readonly<{ signal?: AbortSignal; maxBytes: number }>): Promise<Buffer> {
    if (!options) return readFile(this.pathFor(key));
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) throw new Error('Invalid file read limit');
    options.signal?.throwIfAborted();
    const handle = await open(this.pathFor(key), 'r');
    try {
      options.signal?.throwIfAborted();
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of handle.createReadStream({ signal: options.signal, autoClose: false })) {
        size += chunk.length;
        if (size > options.maxBytes) throw new Error('File exceeds read limit');
        chunks.push(chunk);
      }
      options.signal?.throwIfAborted();
      return Buffer.concat(chunks, size);
    } finally { await handle.close(); }
  }

  async stat(key: string): Promise<StoredFileStat | null> {
    try {
      const result = await fsStat(this.pathFor(key));
      return { size: result.size, modifiedAt: result.mtime };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

export const localFileStore = new LocalFileStore();
