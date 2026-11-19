import { createHash, type Hash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { copyFile, link, mkdir, readdir, rm } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Omission } from './format.js';

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/iu;

/** A path inside the archive: forward slashes, no empty, `.` or `..` segments,
 * no control characters, characters or device names Windows cannot store. */
export function assertArchivePath(path: string): void {
  const segments = path.split('/');
  const bad = segments.some((part) => !part || part === '.' || part === '..' || part.length > 200
    || /[\u0000-\u001f\u007f<>:"\\|?*]/u.test(part) || /[. ]$/u.test(part) || WINDOWS_DEVICE.test(part));
  if (bad || path.length > 1000) throw new Error(`Invalid archive path: ${JSON.stringify(path)}`);
}

/**
 * Keeps a stream's asynchronous failure instead of letting it escape as an
 * uncaught exception: it is reported by the next write, drain or close.
 */
function guard<T extends Writable>(stream: T): T {
  stream.on('error', () => undefined);
  return stream;
}

function failure(stream: Writable): Error | null {
  return stream.errored ?? (stream.destroyed && !stream.writableFinished ? new Error('Archive stream closed') : null);
}

/** Writes and, when the buffer is full, waits for it to empty; rejects on any stream failure. */
async function writeTo(stream: Writable, chunk: Uint8Array): Promise<void> {
  const before = failure(stream);
  if (before) throw before;
  if (stream.write(chunk)) return;
  await new Promise<void>((resolveDrain, reject) => {
    const cleanup = () => { stream.off('drain', drained); stream.off('error', failed); stream.off('close', closed); };
    const drained = () => { cleanup(); resolveDrain(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const closed = () => { cleanup(); reject(failure(stream) ?? new Error('Archive stream closed')); };
    stream.on('drain', drained);
    stream.on('error', failed);
    stream.on('close', closed);
  });
}

/** One archive file being written: every byte is hashed on its way to disk. */
export class ArchiveFile {
  private readonly hash: Hash = createHash('sha256');
  private bytes = 0;
  private closed = false;

  constructor(readonly path: string, readonly absolutePath: string, private readonly stream: Writable,
    private readonly onClose: (file: ArchiveFile, sha256: string) => Promise<void>) {
    guard(stream);
  }

  /** Waits for the disk to catch up when the stream buffer is full, so memory stays bounded. */
  async write(chunk: string | Uint8Array): Promise<void> {
    if (this.closed) throw new Error(`Archive file already closed: ${this.path}`);
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.hash.update(buffer);
    this.bytes += buffer.length;
    await writeTo(this.stream, buffer);
  }

  async close(): Promise<{ sha256: string; bytes: number }> {
    if (this.closed) throw new Error(`Archive file already closed: ${this.path}`);
    this.closed = true;
    this.stream.end();
    await finished(this.stream);
    const sha256 = this.hash.digest('hex');
    await this.onClose(this, sha256);
    return { sha256, bytes: this.bytes };
  }

  /** Stops writing and leaves the partial file out of SHA256SUMS. */
  async abandon(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stream.destroy();
    await finished(this.stream).catch(() => undefined);
  }
}

export class JsonlFile {
  records = 0;
  constructor(private readonly file: ArchiveFile, private readonly onRecord?: () => void) {}
  async write(record: unknown): Promise<void> {
    this.records += 1;
    await this.file.write(`${JSON.stringify(record)}\n`);
    this.onRecord?.();
  }
  close() { return this.file.close(); }
}

/**
 * Writes an archive folder. SHA256SUMS and omissions.jsonl are appended as
 * each file closes, so nothing in the writer grows with the workspace's size.
 * On any failure, abort() stops every stream; a folder without SHA256SUMS is
 * an export that did not finish.
 */
export class ArchiveWriter {
  private sums!: Writable;
  private omissionsFile!: JsonlFile;
  private readonly openFiles = new Set<ArchiveFile>();
  /** How many omissions of each kind and reason; reasons are a fixed set, so this stays small. */
  readonly omissionSummary = new Map<string, { kind: string; reason: string; count: number }>();
  /** Test seam: called after every JSON Lines record is written. */
  onRecord?: () => void;

  private constructor(readonly root: string) {}

  /** The folder must not exist yet, or be empty. */
  static async create(root: string): Promise<ArchiveWriter> {
    const absolute = resolve(root);
    await mkdir(absolute, { recursive: true });
    if ((await readdir(absolute)).length > 0) throw new Error(`Output folder is not empty: ${absolute}`);
    const writer = new ArchiveWriter(absolute);
    writer.sums = guard(createWriteStream(join(absolute, 'SHA256SUMS.partial'), { flags: 'wx' }));
    try {
      writer.omissionsFile = new JsonlFile(await writer.open('omissions.jsonl'));
    } catch (error) {
      // The caller never gets this writer, so close what it already opened.
      await writer.abort();
      throw error;
    }
    return writer;
  }

  get omissions(): number { return this.omissionsFile.records; }

  async open(path: string): Promise<ArchiveFile> {
    assertArchivePath(path);
    if (path === 'SHA256SUMS' || path === 'SHA256SUMS.partial') throw new Error('Reserved archive path');
    const absolute = join(this.root, ...path.split('/'));
    if (!absolute.startsWith(this.root + sep)) throw new Error(`Archive path escapes the folder: ${path}`);
    await mkdir(dirname(absolute), { recursive: true });
    // Wait until the file is really created (exclusively), so a file someone else put here is never ours to delete.
    const stream = createWriteStream(absolute, { flags: 'wx' });
    await new Promise<void>((resolveOpen, rejectOpen) => {
      stream.once('open', () => { stream.off('error', rejectOpen); resolveOpen(); });
      stream.once('error', rejectOpen);
    });
    const file = new ArchiveFile(path, absolute, stream, async (closedFile, sha256) => {
      this.openFiles.delete(closedFile);
      await writeTo(this.sums, Buffer.from(`${sha256}  ${closedFile.path}\n`, 'utf8'));
    });
    this.openFiles.add(file);
    return file;
  }

  async jsonl(path: string): Promise<JsonlFile> {
    return new JsonlFile(await this.open(path), () => this.onRecord?.());
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

  /** Drops a partly written file: it is removed and never listed in SHA256SUMS. */
  async discard(file: ArchiveFile): Promise<void> {
    this.openFiles.delete(file);
    await file.abandon();
    await rm(file.absolutePath, { force: true });
  }

  async omit(omission: Omission): Promise<void> {
    const key = `${omission.kind}|${omission.reason}`;
    const entry = this.omissionSummary.get(key) ?? { kind: omission.kind, reason: omission.reason, count: 0 };
    entry.count += 1;
    this.omissionSummary.set(key, entry);
    await this.omissionsFile.write(omission);
  }

  /** Closes omissions.jsonl, writes the manifest last among content files, then publishes SHA256SUMS. */
  async finish(writeManifest: () => Promise<void>): Promise<void> {
    await this.omissionsFile.close();
    await writeManifest();
    this.sums.end();
    await finished(this.sums);
    // Publish without ever replacing a SHA256SUMS that appeared in the meantime.
    const partial = join(this.root, 'SHA256SUMS.partial');
    try {
      await link(partial, join(this.root, 'SHA256SUMS'));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'ENOSYS') throw error;
      await copyFile(partial, join(this.root, 'SHA256SUMS'), constants.COPYFILE_EXCL);
    }
    await rm(partial, { force: true });
  }

  /** Stops every stream after a failure. SHA256SUMS is never published. */
  async abort(): Promise<void> {
    for (const file of this.openFiles) await file.abandon();
    this.openFiles.clear();
    this.sums.destroy();
    await finished(this.sums).catch(() => undefined);
  }
}
