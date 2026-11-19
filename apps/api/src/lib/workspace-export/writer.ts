import { createHash, type Hash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, rename } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, join, resolve, sep } from 'node:path';
import type { Omission } from './format.js';

/** A path inside the archive: forward slashes, no empty, `.` or `..` segments,
 * no control characters or characters Windows cannot store. */
export function assertArchivePath(path: string): void {
  const segments = path.split('/');
  const bad = segments.some((part) => !part || part === '.' || part === '..' || part.length > 200
    || /[\u0000-\u001f\u007f<>:"\\|?*]/u.test(part) || /[. ]$/u.test(part));
  if (bad || path.length > 1000) throw new Error(`Invalid archive path: ${JSON.stringify(path)}`);
}

/** One archive file being written: every byte is hashed on its way to disk. */
export class ArchiveFile {
  private readonly hash: Hash = createHash('sha256');
  private bytes = 0;
  private closed = false;

  constructor(readonly path: string, private readonly stream: WriteStream, private readonly onClose: (path: string, sha256: string, bytes: number) => Promise<void>) {}

  /** Waits for the disk to catch up when the stream buffer is full, so memory stays bounded. */
  async write(chunk: string | Uint8Array): Promise<void> {
    if (this.closed) throw new Error(`Archive file already closed: ${this.path}`);
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.hash.update(buffer);
    this.bytes += buffer.length;
    if (!this.stream.write(buffer)) await once(this.stream, 'drain');
  }

  async close(): Promise<{ sha256: string; bytes: number }> {
    if (this.closed) throw new Error(`Archive file already closed: ${this.path}`);
    this.closed = true;
    this.stream.end();
    await once(this.stream, 'close');
    const sha256 = this.hash.digest('hex');
    await this.onClose(this.path, sha256, this.bytes);
    return { sha256, bytes: this.bytes };
  }

  /** Stops writing and leaves the partial file out of SHA256SUMS. The caller removes it. */
  async abandon(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stream.destroy();
    await once(this.stream, 'close').catch(() => undefined);
  }
}

export class JsonlFile {
  records = 0;
  constructor(private readonly file: ArchiveFile) {}
  async write(record: unknown): Promise<void> {
    this.records += 1;
    await this.file.write(`${JSON.stringify(record)}\n`);
  }
  close() { return this.file.close(); }
}

/**
 * Writes an archive folder. SHA256SUMS and omissions.jsonl are appended as
 * each file closes, so nothing in the writer grows with the workspace's size.
 */
export class ArchiveWriter {
  private sums!: WriteStream;
  private omissionsFile!: JsonlFile;

  private constructor(readonly root: string) {}

  /** The folder must not exist yet, or be empty. */
  static async create(root: string): Promise<ArchiveWriter> {
    const absolute = resolve(root);
    await mkdir(absolute, { recursive: true });
    if ((await readdir(absolute)).length > 0) throw new Error(`Output folder is not empty: ${absolute}`);
    const writer = new ArchiveWriter(absolute);
    writer.sums = createWriteStream(join(absolute, 'SHA256SUMS.partial'), { flags: 'wx' });
    writer.omissionsFile = new JsonlFile(await writer.open('omissions.jsonl'));
    return writer;
  }

  get omissions(): number { return this.omissionsFile.records; }

  async open(path: string): Promise<ArchiveFile> {
    assertArchivePath(path);
    if (path === 'SHA256SUMS' || path === 'SHA256SUMS.partial') throw new Error('Reserved archive path');
    const absolute = join(this.root, ...path.split('/'));
    if (!absolute.startsWith(this.root + sep)) throw new Error(`Archive path escapes the folder: ${path}`);
    await mkdir(dirname(absolute), { recursive: true });
    const stream = createWriteStream(absolute, { flags: 'wx' });
    await once(stream, 'open');
    return new ArchiveFile(path, stream, async (closedPath, sha256) => {
      if (!this.sums.write(`${sha256}  ${closedPath}\n`)) await once(this.sums, 'drain');
    });
  }

  async jsonl(path: string): Promise<JsonlFile> {
    return new JsonlFile(await this.open(path));
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    const file = await this.open(path);
    await file.write(`${JSON.stringify(value, null, 2)}\n`);
    await file.close();
  }

  async writeText(path: string, text: string): Promise<void> {
    const file = await this.open(path);
    await file.write(text);
    await file.close();
  }

  async omit(omission: Omission): Promise<void> {
    await this.omissionsFile.write(omission);
  }

  /** Closes omissions.jsonl, writes the manifest last among content files, then publishes SHA256SUMS. */
  async finish(writeManifest: () => Promise<void>): Promise<void> {
    await this.omissionsFile.close();
    await writeManifest();
    this.sums.end();
    await once(this.sums, 'close');
    await rename(join(this.root, 'SHA256SUMS.partial'), join(this.root, 'SHA256SUMS'));
  }
}
