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
  /**
   * Whether the workspace's key for encrypted private assistant conversations
   * was given. This version never decrypts: with or without it, those
   * conversations are listed in omissions.jsonl without their text.
   */
  workspace_key: 'not_supplied' | 'supplied_not_used';
  /** The one database schema every query of the export read from. */
  database_schema: string;
  /** False when anything in scope could not be included; see omissions.jsonl. */
  /**
   * single_workspace_declared: the operator stated that this database holds
   * exactly one workspace, and the scan found no other; only then are
   * attachment bytes copied. files_copied: how many files were copied.
   */
  attachments: Readonly<{ single_workspace_declared: boolean; files_copied: number }>;
  complete: boolean;
  omissions: number;
  datasets: readonly DatasetSummary[];
  not_included: readonly string[];
}>;

/** Content kinds this exporter deliberately does not write. Shown in the manifest and README. */
export const NOT_INCLUDED: readonly string[] = [
  'Mail and mail attachments: not included by this command; the mail/ folder is reserved for them.',
  'Deleted items (anything deleted in Deft before the export, including documents in a drive\'s trash and the notes they were moved from).',
  'Scheduled messages that have not been sent, and reminders.',
  'Notifications, agent actions and approvals, agent run history, AI memory, generated briefings and standups.',
  'Integration settings, connected accounts, and every credential or secret Deft stores (passwords, sessions, tokens, keys, invite and recovery links, two-step secrets).',
  'Personal preferences (bookmarks, saved views, favorites) and version history, except the saved versions of documents: a member\'s export has those only for the documents they can edit, and a guest\'s none.',
  'The live-editing state of documents. Each document\'s content is in data/documents.jsonl and documents/.',
  'Links from module records (such as Contacts) to other Deft items, such as tasks. Links between records of the same module are included.',
];
