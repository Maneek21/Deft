import { mkdir, open, readFile, stat as fsStat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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

export class LocalFileStore implements FileStore {
  readonly rootDir: string;

  constructor(rootDir = join(process.cwd(), 'uploads')) {
    this.rootDir = resolve(rootDir);
  }

  private pathFor(key: string): string {
    const normalized = key.trim();
    if (!normalized || normalized === '.' || normalized === '..' || /[\\/]/.test(normalized)) {
      throw new Error('Invalid storage key');
    }
    return join(this.rootDir, normalized);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.pathFor(key), bytes);
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
