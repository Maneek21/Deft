/**
 * Exports one workspace's content to a portable archive, without the app
 * running. See docs/workspace-export.md.
 *
 *   node --import tsx src/scripts/export-workspace.ts \
 *     --workspace <id or slug> --uploads <folder> --out <file.tar> \
 *     (--whole-workspace | --member <user id or email>) \
 *     [--folder] [--workspace-key-file <path>]
 *
 * The database is read from DATABASE_URL (or --database-url). The whole
 * workspace, including private spaces and direct messages, needs the explicit
 * --whole-workspace flag; --member exports only what that person can see.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { exportWorkspace } from '../lib/workspace-export/export.js';
import { packTar } from '../lib/workspace-export/tar.js';
import { assertArchivePath } from '../lib/workspace-export/writer.js';

const USAGE = `Usage: export-workspace --workspace <id|slug> --uploads <folder> --out <file.tar | folder>
  (--whole-workspace | --member <user id or email>) [--folder] [--workspace-key-file <path>] [--database-url <url>]`;

export class UsageError extends Error {}

export type CommandOptions = {
  databaseUrl: string; workspace: string; uploads: string; out: string; folder: boolean;
  scope: { kind: 'workspace' } | { kind: 'member'; member: string }; workspaceKeyFile: string | null;
};

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      strict: true,
      options: {
        workspace: { type: 'string' }, uploads: { type: 'string' }, out: { type: 'string' }, folder: { type: 'boolean', default: false },
        'whole-workspace': { type: 'boolean', default: false }, member: { type: 'string' },
        'workspace-key-file': { type: 'string' }, 'database-url': { type: 'string' },
      },
    });
  } catch {
    // The parser's own message can repeat an argument, which may be a secret such as a database URL.
    throw new UsageError('Unknown, misplaced or incomplete argument.');
  }
}

/** Replaces anything that looks like a URL, which may carry a password, before a message is printed. */
export function redact(message: string): string {
  return message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>');
}

export function parseCommand(argv: string[], env: NodeJS.ProcessEnv): CommandOptions {
  const { values } = parse(argv);
  const databaseUrl = values['database-url'] ?? env.DATABASE_URL;
  if (!databaseUrl) throw new UsageError('Set DATABASE_URL or pass --database-url.');
  if (!values.workspace || !values.uploads || !values.out) throw new UsageError('--workspace, --uploads and --out are required.');
  if (values['whole-workspace'] === Boolean(values.member)) {
    throw new UsageError('Choose exactly one scope: --member <user id or email>, or --whole-workspace (everything, including private spaces and direct messages).');
  }
  return {
    databaseUrl, workspace: values.workspace, uploads: resolve(values.uploads), out: resolve(values.out), folder: values.folder,
    scope: values.member ? { kind: 'member', member: values.member } : { kind: 'workspace' },
    workspaceKeyFile: values['workspace-key-file'] ? resolve(values['workspace-key-file']) : null,
  };
}

async function deftVersion(): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/** Runs the export; returns the path written. The key file is only checked to exist and be non-empty; it is never read. */
export async function runCommand(options: CommandOptions): Promise<string> {
  if (options.workspaceKeyFile && !((await stat(options.workspaceKeyFile)).size > 0)) throw new UsageError('The workspace key file is empty.');
  const common = { databaseUrl: options.databaseUrl, workspace: options.workspace, scope: options.scope, uploadsDir: options.uploads,
    deftVersion: await deftVersion(), workspaceKeySupplied: Boolean(options.workspaceKeyFile) };
  if (options.folder) {
    await exportWorkspace({ ...common, outDir: options.out });
    return options.out;
  }
  if (!options.out.endsWith('.tar')) throw new UsageError('--out must name a .tar file (or add --folder to write a folder).');
  // The file's name becomes the folder inside the tar, so it must be one safe name.
  const topName = basename(options.out, '.tar');
  try {
    assertArchivePath(topName);
  } catch {
    throw new UsageError('--out must be a .tar file with an ordinary name, such as acme-export.tar.');
  }
  if (await stat(options.out).then(() => true, () => false)) throw new UsageError('The --out file already exists.');
  const staging = await mkdtemp(join(dirname(options.out), '.deft-export-'));
  try {
    const result = await exportWorkspace({ ...common, outDir: join(staging, 'export') });
    await packTar(result.root, options.out, topName, Math.floor(Date.parse(result.manifest.as_of) / 1000));
    return options.out;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const written = await runCommand(parseCommand(process.argv.slice(2), process.env));
    console.log(`Export written: ${written}`);
  } catch (error) {
    console.error(redact(error instanceof UsageError ? `${error.message}\n${USAGE}` : `Export failed: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(error instanceof UsageError ? 2 : 1);
  }
}
