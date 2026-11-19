import { constants, createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { copyFile, link, readdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { join } from 'node:path';
import { assertArchivePath } from './writer.js';

/**
 * Packs a folder into one POSIX tar file (pax format), streamed file by file
 * so memory does not grow with the archive. Pax records carry any path that
 * is long or not ASCII, and any size ustar cannot hold. Opens with the
 * built-in archive tools of Windows 11, macOS and Linux.
 */
const BLOCK = 512;
const USTAR_MAX_SIZE = 0o77777777777;
const PLAIN_NAME = /^[\x20-\x7e]{1,99}$/;

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function header(name: string, size: number, type: '0' | 'x', mtime: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(0o644, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(Math.min(size, USTAR_MAX_SIZE), 12), 124, 'ascii');
  block.write(octal(mtime, 12), 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

/** One pax record: "<length> <key>=<value>\n", where length counts its own digits. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return `${length}${body}`;
}

/** The header blocks for one file: a pax header when needed, then the ustar header. */
export function entryHeaders(name: string, size: number, mtime: number): Buffer {
  const records = [
    ...(PLAIN_NAME.test(name) ? [] : [paxRecord('path', name)]),
    ...(size > USTAR_MAX_SIZE ? [paxRecord('size', String(size))] : []),
  ].join('');
  const blocks: Buffer[] = [];
  if (records) {
    const pax = Buffer.from(records, 'utf8');
    blocks.push(header('PaxHeader/entry', pax.length, 'x', mtime), pax, Buffer.alloc((BLOCK - (pax.length % BLOCK)) % BLOCK));
  }
  blocks.push(header(PLAIN_NAME.test(name) ? name : 'entry', size, '0', mtime));
  return Buffer.concat(blocks);
}

/** Writes with backpressure; a failure of the output stream at any moment is reported here, never left uncaught. */
async function write(stream: WriteStream, chunk: Buffer): Promise<void> {
  if (stream.errored) throw stream.errored;
  if (stream.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => { stream.off('error', failed); resolve(); };
    const failed = (error: Error) => { stream.off('drain', done); reject(error); };
    stream.once('drain', done);
    stream.once('error', failed);
  });
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Not a regular file: ${path}`);
  }
  return files;
}

/**
 * Writes `folder` into `tarPath` under the top-level directory `topName`.
 * The tar appears only when complete, and never replaces an existing file.
 */
export async function packTar(folder: string, tarPath: string, topName: string, mtime = Math.floor(Date.now() / 1000)): Promise<void> {
  assertArchivePath(topName);
  if (topName.includes('/')) throw new Error(`Invalid archive path: ${JSON.stringify(topName)}`);
  // A staging name of this run's own, so a failure never removes another export's staging file.
  const partial = `${tarPath}.${randomUUID()}.partial`;
  const out = createWriteStream(partial, { flags: 'wx' });
  let created = false;
  out.once('open', () => { created = true; });
  out.on('error', () => undefined);
  try {
    for (const relative of await listFiles(folder)) {
      const { size } = await stat(join(folder, ...relative.split('/')));
      await write(out, entryHeaders(`${topName}/${relative}`, size, mtime));
      let written = 0;
      for await (const chunk of createReadStream(join(folder, ...relative.split('/')))) {
        written += (chunk as Buffer).length;
        await write(out, chunk as Buffer);
      }
      if (written !== size) throw new Error(`File changed while packing: ${relative}`);
      const padding = (BLOCK - (size % BLOCK)) % BLOCK;
      if (padding) await write(out, Buffer.alloc(padding));
    }
    await write(out, Buffer.alloc(BLOCK * 2));
    out.end();
    await finished(out);
    // Publish without ever replacing a file that appeared in the meantime.
    try {
      await link(partial, tarPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'ENOSYS') throw error;
      await copyFile(partial, tarPath, constants.COPYFILE_EXCL);
    }
    await rm(partial, { force: true });
  } catch (error) {
    out.destroy();
    await finished(out).catch(() => undefined);
    if (created) await rm(partial, { force: true });
    throw error;
  }
}
