import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION, NOT_INCLUDED, type DatasetSummary, type ExportManifest, type ExportScope } from './format.js';
import { ArchiveWriter } from './writer.js';
import { Snapshot } from './snapshot.js';
import { resolveScope, resolveWorkspace, type ExportContext } from './scope.js';
import { PEOPLE_AND_SPACES, type Dataset } from './datasets.js';
import { MESSAGES_AND_TASKS } from './datasets-content.js';
import { NOTES_WIKI_EVENTS } from './datasets-knowledge.js';
import { exportAttachments, type CopyHooks } from './attachments.js';
import { sql } from 'drizzle-orm';
import { exportModules } from './modules.js';
import { writeReadme, writeTranscripts } from './render.js';

export type ExportOptions = Readonly<{
  databaseUrl: string;
  /** Workspace id or slug. */
  workspace: string;
  scope: ExportScope;
  /** The uploads folder holding the workspace's attachment bytes (Deft's local file store). */
  uploadsDir: string;
  /** Folder to create; it must not exist or be empty. */
  outDir: string;
  deftVersion?: string | null;
  /** The schema Deft's tables are in (default "public"). The export reads that schema alone. */
  databaseSchema?: string;
  batchSize?: number;
  onFetch?: (rows: number) => void;
  /** Test seam: called after each JSON Lines record is written. */
  onRecord?: () => void;
  /** Test seam: runs after each dataset file is complete. */
  afterDataset?: (path: string) => Promise<void>;
  /** Test seams around each attachment read. */
  hooks?: CopyHooks;
  /**
   * The operator states that this database holds exactly one workspace. Only
   * then are attachment bytes copied; the export stops if the database shows
   * another workspace. A hosted workspace's database always holds one.
   */
  singleWorkspaceDatabase?: boolean;
}>;

/** Every table the export reads, directly or through the product's visibility rules. All must be in the pinned schema. */
export const EXPORT_TABLES: readonly string[] = ['orgs', 'users', 'org_members', 'agent_employees', 'spaces', 'space_members',
  'messages', 'reactions', 'canvases', 'projects', 'labels', 'tasks', 'task_assignees', 'task_watchers', 'task_labels',
  'task_relationships', 'task_reactions', 'task_comments', 'note_folders', 'notes', 'note_shares', 'wiki_pages', 'wiki_links',
  'events', 'files', 'message_attachments', 'task_attachments', 'module_installations', 'module_versions', 'module_records',
  'module_record_relations'];

export type ExportResult = Readonly<{ root: string; manifest: ExportManifest }>;

export const DATASETS: readonly Dataset[] = [...PEOPLE_AND_SPACES, ...MESSAGES_AND_TASKS, ...NOTES_WIKI_EVENTS];

/**
 * Writes one workspace's content, for the given scope, into a new folder.
 * Needs only a database connection: it starts no app, worker or outbound call.
 * A folder without SHA256SUMS is an export that did not finish.
 */
export async function exportWorkspace(options: ExportOptions): Promise<ExportResult> {
  const snapshot = await Snapshot.open({ databaseUrl: options.databaseUrl, batchSize: options.batchSize, onFetch: options.onFetch,
    schema: options.databaseSchema });
  try {
    await snapshot.requireTables(EXPORT_TABLES);
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
      const attachments = await exportAttachments(snapshot, writer, ctx, options.uploadsDir,
        { hooks: options.hooks, singleWorkspaceDatabase: options.singleWorkspaceDatabase });
      datasets.push({ path: attachments.path, records: attachments.records });
      datasets.push(...await exportModules(snapshot, writer, ctx));
      await writeTranscripts(snapshot, writer, ctx);
      const memberName = scope.kind === 'member'
        ? (await snapshot.all<{ name: string }>(sql`SELECT name FROM users WHERE id = ${scope.user_id}`))[0]?.name ?? null : null;

      let manifest!: ExportManifest;
      await writer.finish(async () => {
        manifest = {
          format: EXPORT_FORMAT,
          format_version: EXPORT_FORMAT_VERSION,
          generator: { name: 'deft workspace export', deft_version: options.deftVersion ?? null },
          workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
          scope: scope.kind === 'workspace' ? { kind: 'workspace' } : { kind: 'member', user_id: scope.user_id, role: scope.role },
          as_of: snapshot.asOf.toISOString(),
          database_schema: snapshot.schema,
          attachments: { single_workspace_declared: attachments.single_workspace_declared, files_copied: attachments.files_copied },
          complete: writer.omissions === 0,
          omissions: writer.omissions,
          datasets,
          not_included: NOT_INCLUDED,
        };
        await writeReadme(writer, manifest, memberName, attachments.files_copied);
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
