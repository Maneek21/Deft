import { mkdir, readFile, stat as fsStat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type StoredFileStat = {
  size: number;
  modifiedAt: Date;
};

export interface FileStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Buffer>;
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

  get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
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
