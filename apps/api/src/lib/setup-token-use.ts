/**
 * Hosted mode: remember that a setup token has been used.
 *
 * A hosted cell's first owner signs up with the one-time setup token
 * (lib/setup-token.ts). Without a record of its use, the only thing stopping a
 * second signup with the same link is the one-workspace rule, which counts
 * rows in the database. If the database is lost or replaced by an empty one
 * while the link is still valid, the link would make a new owner.
 *
 * So the signup writes a small marker file, named by the token's SHA-256
 * hash, on the uploads volume. In a hosted cell that volume belongs to the app
 * machine, not the database machine, so it survives a lost database. A
 * signup is refused when the marker for its token exists.
 *
 * Order, and what each failure does:
 *   1. Before the transaction: the marker must be absent. If it cannot be
 *      checked, the signup is refused.
 *   2. Inside the transaction, after every row is written and just before the
 *      commit: the marker is created with O_EXCL and flushed to disk. If that
 *      fails, the transaction rolls back and the signup is refused.
 *   3. Commit. A crash or a failed commit after step 2 leaves a used marker
 *      and no owner. That fails closed: the link stops working, and the
 *      hosting layer issues a fresh one (a new hash, so a new marker name).
 *
 * The uploads volume is only part of the answer: if it is lost or restored
 * from before the signup at the same time as the database, the hosting layer
 * must issue a fresh token, as it already does for a restore into new
 * volumes. Self-hosted installs never have a setup token, so none of this
 * runs for them.
 */
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { localFileStore } from './file-store.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Where markers live. A directory inside the uploads root, so it is on the
 * same volume as uploaded files and goes into the same backups. The name
 * starts with a dot and uploaded files are stored flat under random names,
 * so the two never collide. Tests point this elsewhere.
 */
export const setupTokenUseStore = {
  dir: join(localFileStore.rootDir, '.setup-token-used'),
};

/** The marker could not be checked, written or found absent: refuse. */
export class SetupTokenUseError extends Error {
  constructor(readonly reason: 'used' | 'storage') {
    super(reason === 'used' ? 'setup token already used' : 'setup token use could not be recorded');
    this.name = 'SetupTokenUseError';
  }
}

function markerPath(hashHex: string): string {
  // The hash comes from DEFT_SETUP_TOKEN_SHA256, which isSetupTokenValid has
  // already checked; check again so nothing else can become a path.
  if (!SHA256_HEX.test(hashHex)) throw new SetupTokenUseError('storage');
  return join(setupTokenUseStore.dir, hashHex);
}

/**
 * True when the marker for this token hash exists. Throws SetupTokenUseError
 * ('storage') when the answer is unknown, so the caller refuses.
 */
export async function isSetupTokenUsed(hashHex: string): Promise<boolean> {
  const path = markerPath(hashHex);
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw new SetupTokenUseError('storage');
  }
}

/**
 * Create the marker for this token hash and flush it, with its directory
 * entry, to disk. Throws SetupTokenUseError: 'used' when the marker already
 * exists, 'storage' for any other failure. On a failure after the file was
 * created, the half-made marker is removed (the signup is about to roll back,
 * so the token was not used); if even that fails, the marker stays and the
 * token stays refused.
 */
export async function markSetupTokenUsed(hashHex: string, now: Date = new Date()): Promise<void> {
  const path = markerPath(hashHex);
  try {
    await mkdir(setupTokenUseStore.dir, { recursive: true });
  } catch {
    throw new SetupTokenUseError('storage');
  }

  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new SetupTokenUseError('used');
    throw new SetupTokenUseError('storage');
  }

  try {
    try {
      await handle.writeFile(`${now.toISOString()}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(setupTokenUseStore.dir);
  } catch {
    await unlink(path).catch(() => undefined);
    throw new SetupTokenUseError('storage');
  }
}

/**
 * Flush the directory entry so the new file survives a power cut. Windows
 * cannot open a directory for fsync; hosted cells run Linux, so on Windows
 * (development only) this step is skipped.
 */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
