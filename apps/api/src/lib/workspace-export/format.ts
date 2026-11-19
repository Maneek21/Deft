/**
 * The workspace export archive format, `deft.workspace_export.v1`.
 *
 * An archive is a folder (the command may package it as one tar file) with:
 *   manifest.json   what this archive is: workspace, scope, snapshot time,
 *                   counts per dataset, whether it is complete
 *   data/*.jsonl    one JSON record per line, UTF-8, ids as in Deft
 *   omissions.jsonl one line per thing that could not be included, and why
 *   SHA256SUMS      `sha256sum -c` compatible list of every other file
 *
 * Only the fields named in each dataset's SELECT list are written. Nothing is
 * exported by default: a column added to a table later stays out of the
 * archive until someone adds it to a dataset on purpose.
 */

export const EXPORT_FORMAT = 'deft.workspace_export.v1';
export const EXPORT_FORMAT_VERSION = 1;

export type ExportScope =
  | Readonly<{ kind: 'workspace' }>
  | Readonly<{ kind: 'member'; member: string }>;

export type ResolvedScope =
  | Readonly<{ kind: 'workspace' }>
  | Readonly<{ kind: 'member'; user_id: string; role: 'owner' | 'admin' | 'member' | 'guest' }>;

export type Omission = Readonly<{
  kind: string;
  id: string;
  reason: string;
}>;

export type DatasetSummary = Readonly<{
  path: string;
  records: number;
}>;

export type ExportManifest = Readonly<{
  format: typeof EXPORT_FORMAT;
  format_version: typeof EXPORT_FORMAT_VERSION;
  generator: Readonly<{ name: string; deft_version: string | null }>;
  workspace: Readonly<{ id: string; slug: string; name: string }>;
  scope: Readonly<{ kind: 'workspace' } | { kind: 'member'; user_id: string; role: string }>;
  /** Start time of the single database snapshot every dataset was read from. */
  as_of: string;
  /** False when anything in scope could not be included; see omissions.jsonl. */
  /**
   * shared_database: this database holds, or held, another workspace (see
   * databaseIsShared). Then attachment bytes are copied only when an operator
   * allowed it (shared_uploads_allowed). copy_allowed says whether copying was
   * allowed at all, and files_copied how many files were copied.
   */
  attachments: Readonly<{ shared_database: boolean; shared_uploads_allowed: boolean; copy_allowed: boolean; files_copied: number }>;
  complete: boolean;
  omissions: number;
  datasets: readonly DatasetSummary[];
  not_included: readonly string[];
}>;

/** Content kinds this exporter deliberately does not write. Shown in the manifest and README. */
export const NOT_INCLUDED: readonly string[] = [
  'Mail and mail attachments: not included by this command; the mail/ folder is reserved for them.',
  'Deleted items (anything deleted in Deft before the export).',
  'Scheduled messages that have not been sent, and reminders.',
  'Notifications, agent actions and approvals, agent run history, AI memory, generated briefings and standups.',
  'Integration settings, connected accounts, and every credential or secret Deft stores (passwords, sessions, tokens, keys, invite and recovery links, two-step secrets).',
  'Personal preferences (bookmarks, saved views, favorites) and version history.',
];
