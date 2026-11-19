import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION, NOT_INCLUDED, type DatasetSummary, type ExportManifest, type ExportScope } from './format.js';
import { ArchiveWriter } from './writer.js';
import { Snapshot } from './snapshot.js';
import { resolveScope, resolveWorkspace, type ExportContext } from './scope.js';
import { PEOPLE_AND_SPACES, type Dataset } from './datasets.js';
import { MESSAGES_AND_TASKS } from './datasets-content.js';

export type ExportOptions = Readonly<{
  databaseUrl: string;
  /** Workspace id or slug. */
  workspace: string;
  scope: ExportScope;
  /** Folder to create; it must not exist or be empty. */
  outDir: string;
  deftVersion?: string | null;
  batchSize?: number;
  onFetch?: (rows: number) => void;
  /** Test seam: called after each JSON Lines record is written. */
  onRecord?: () => void;
  /** Test seam: runs after each dataset file is complete. */
  afterDataset?: (path: string) => Promise<void>;
}>;

export type ExportResult = Readonly<{ root: string; manifest: ExportManifest }>;

export const DATASETS: readonly Dataset[] = [...PEOPLE_AND_SPACES, ...MESSAGES_AND_TASKS];

/**
 * Writes one workspace's content, for the given scope, into a new folder.
 * Needs only a database connection: it starts no app, worker or outbound call.
 * A folder without SHA256SUMS is an export that did not finish.
 */
export async function exportWorkspace(options: ExportOptions): Promise<ExportResult> {
  const snapshot = await Snapshot.open({ databaseUrl: options.databaseUrl, batchSize: options.batchSize, onFetch: options.onFetch });
  try {
    const workspace = await resolveWorkspace(snapshot, options.workspace);
    const scope = await resolveScope(snapshot, workspace.id, options.scope);
    const ctx: ExportContext = { orgId: workspace.id, scope };
    const writer = await ArchiveWriter.create(options.outDir);
    writer.onRecord = options.onRecord;
    try {
      await writer.writeJson('data/workspace.json', {
        id: workspace.id, name: workspace.name, slug: workspace.slug, timezone: workspace.timezone, created_at: workspace.created_at,
      });
      const datasets: DatasetSummary[] = [{ path: 'data/workspace.json', records: 1 }];
      for (const dataset of DATASETS) {
        if (dataset.scopes && !dataset.scopes.includes(scope.kind)) continue;
        const file = await writer.jsonl(dataset.path);
        for await (const row of snapshot.rows(dataset.query(ctx))) {
          await file.write(row);
          const omission = dataset.omission?.(row);
          if (omission) await writer.omit(omission);
        }
        await file.close();
        datasets.push({ path: dataset.path, records: file.records });
        await options.afterDataset?.(dataset.path);
      }

      let manifest!: ExportManifest;
      await writer.finish(async () => {
        manifest = {
          format: EXPORT_FORMAT,
          format_version: EXPORT_FORMAT_VERSION,
          generator: { name: 'deft workspace export', deft_version: options.deftVersion ?? null },
          workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
          scope: scope.kind === 'workspace' ? { kind: 'workspace' } : { kind: 'member', user_id: scope.user_id, role: scope.role },
          as_of: snapshot.asOf.toISOString(),
          complete: writer.omissions === 0,
          omissions: writer.omissions,
          datasets,
          not_included: NOT_INCLUDED,
        };
        await writer.writeJson('manifest.json', manifest);
      });
      return { root: writer.root, manifest };
    } catch (error) {
      // Every stream stops and SHA256SUMS is never published.
      await writer.abort();
      throw error;
    }
  } finally {
    await snapshot.close();
  }
}
