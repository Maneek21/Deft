import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { jsonToMarkdown } from '@deft/doc-schema';
import { archiveFileName, visibleFilesSql } from './attachments.js';
import { BODY_FETCH_LIMIT, col } from './datasets.js';
import { exportableMessage } from './datasets-content.js';
import { documentMarkdownQuery } from './datasets-documents.js';
import type { ExportManifest } from './format.js';
import { spaceReadable, type ExportContext } from './scope.js';
import type { Snapshot } from './snapshot.js';
import { assertArchivePath, type ArchiveFile, type ArchiveWriter } from './writer.js';

/** Escapes text for HTML. Content is always shown as text, never as markup. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/** A link to another file in the archive, relative and percent-encoded segment by segment. */
function href(path: string, depth: number): string {
  return `${'../'.repeat(depth)}${path.split('/').map(encodeURIComponent).join('/')}`;
}

const STYLE = `<style>body{font:15px/1.5 system-ui,sans-serif;max-width:56rem;margin:2rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}
table{border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:.25rem .75rem;text-align:left}.muted{color:#666}
.message{margin:.75rem 0}.reply{margin-left:2rem;border-left:3px solid #ddd;padding-left:.75rem}.text{white-space:pre-wrap}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}td,th{border-color:#333}.muted{color:#aaa}}</style>`;

function page(title: string, body: string): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>${STYLE}</head><body>${body}</body></html>\n`;
}

const LABELS: Record<string, string> = {
  'data/workspace.json': 'Workspace', 'data/members.jsonl': 'People, guests and agents', 'data/agents.jsonl': 'Agents',
  'data/spaces.jsonl': 'Spaces (public, private, direct messages)', 'data/space_members.jsonl': 'Space memberships',
  'data/messages.jsonl': 'Messages and thread replies', 'data/reactions.jsonl': 'Reactions', 'data/canvases.jsonl': 'Space canvases',
  'data/projects.jsonl': 'Projects', 'data/labels.jsonl': 'Labels', 'data/tasks.jsonl': 'Tasks', 'data/task_comments.jsonl': 'Task comments',
  'data/notes.jsonl': 'Notes', 'data/note_folders.jsonl': 'Note folders', 'data/wiki_pages.jsonl': 'Wiki pages',
  'data/events.jsonl': 'Calendar and tool events', 'data/files.jsonl': 'Attachments listed', 'data/modules.jsonl': 'Installed modules (such as Contacts)',
  'data/drives.jsonl': 'Drives', 'data/drive_members.jsonl': 'Drive members', 'data/doc_folders.jsonl': 'Folders in drives',
  'data/documents.jsonl': 'Documents', 'data/document_shares.jsonl': 'Document shares', 'data/document_versions.jsonl': 'Saved versions of documents',
  'data/document_attachments.jsonl': 'Files documents use',
};

const ATTACHMENTS_NOT_COPIED = 'Attachment files were not copied: they are copied only when the operator states that this database holds exactly one workspace (--single-workspace-database). Each file is still listed in data/files.jsonl, with the reason in omissions.jsonl.';

function scopeSentence(manifest: ExportManifest, memberName: string | null): string {
  return manifest.scope.kind === 'workspace'
    ? 'Everything in the workspace, including private spaces and direct messages.'
    : `Only what ${memberName ?? 'one member'} can see in Deft.`;
}

/** README.txt and README.html: what is in this archive, how much of each, and what is not. */
export async function writeReadme(writer: ArchiveWriter, manifest: ExportManifest, memberName: string | null, filesIncluded: number,
  documentsWritten = 0): Promise<void> {
  const omissions = [...writer.omissionSummary.values()];
  const counts = manifest.datasets.map((dataset) => [LABELS[dataset.path] ?? dataset.path, dataset.records, dataset.path] as const);
  const text = [
    `Deft workspace export: ${manifest.workspace.name}`,
    '',
    `Workspace: ${manifest.workspace.name} (${manifest.workspace.slug})`,
    `Scope: ${scopeSentence(manifest, memberName)}`,
    `As of: ${manifest.as_of} (UTC)`,
    `Complete: ${manifest.complete ? 'yes' : `no, ${manifest.omissions} item(s) could not be included (see below and omissions.jsonl)`}`,
    `Attachment files included: ${filesIncluded}`,
    `Documents as Markdown: ${documentsWritten}, one file per document in the documents folder`,
    `Workspace key: ${manifest.workspace_key === 'not_supplied' ? 'not supplied' : 'supplied, but this version does not decrypt'}; encrypted private assistant conversations are listed without their text.`,
    ...(manifest.attachments.single_workspace_declared ? [] : [ATTACHMENTS_NOT_COPIED]),
    `Database schema read: ${manifest.database_schema}`,
    '',
    'Open README.html in a web browser to read the conversations. Every data file is listed in manifest.json and',
    'described in Deft\'s documentation (docs/workspace-export.md). SHA256SUMS lets you check that no file has changed:',
    '  sha256sum -c SHA256SUMS',
    'Text people wrote is exported exactly as written, including anything they pasted into it.',
    '',
    'Counts:',
    ...counts.map(([label, records, path]) => `  ${String(records).padStart(8)}  ${label}  (${path})`),
    '',
    'Not included by this export:',
    ...manifest.not_included.map((line) => `  - ${line}`),
    '',
    omissions.length ? 'Could not be included:' : 'Nothing in scope was left out.',
    ...omissions.map((entry) => `  ${String(entry.count).padStart(8)}  ${entry.kind}: ${entry.reason}`),
    '',
  ].join('\n');
  await writer.writeText('README.txt', text);
  await writer.writeText('README.html', page(`Export of ${manifest.workspace.name}`, `<h1>Export of ${escapeHtml(manifest.workspace.name)}</h1>
<p>${escapeHtml(scopeSentence(manifest, memberName))}<br>As of ${escapeHtml(manifest.as_of)} (UTC).
${manifest.complete ? 'Everything in scope is included.' : `<strong>${manifest.omissions} item(s) could not be included</strong>; see below.`}</p>
<p><a href="conversations/index.html">Read the conversations</a> · ${filesIncluded} attachment files are in the <code>attachments</code> folder
· ${documentsWritten} documents are in the <code>documents</code> folder as Markdown.</p>
${manifest.attachments.single_workspace_declared ? '' : `<p><strong>${escapeHtml(ATTACHMENTS_NOT_COPIED)}</strong></p>`}
<h2>What is in it</h2><table><tr><th>Kind</th><th>Count</th><th>File</th></tr>${counts.map(([label, records, path]) =>
  `<tr><td>${escapeHtml(label)}</td><td>${records}</td><td><a href="${href(path, 0)}">${escapeHtml(path)}</a></td></tr>`).join('')}</table>
<h2>Not included</h2><ul>${manifest.not_included.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
<h2>Could not be included</h2>${omissions.length ? `<table><tr><th>Count</th><th>Kind</th><th>Why</th></tr>${omissions.map((entry) =>
  `<tr><td>${entry.count}</td><td>${escapeHtml(entry.kind)}</td><td>${escapeHtml(entry.reason)}</td></tr>`).join('')}</table>
<p>Each one is listed in <a href="omissions.jsonl">omissions.jsonl</a>.</p>` : '<p>Nothing.</p>'}
<p class="muted">Text people wrote is shown exactly as written. Check the files with <code>sha256sum -c SHA256SUMS</code>. Format: ${escapeHtml(manifest.format)}.</p>`));
  await writer.writeText('mail/README.txt', [
    'Mail is not included by this export command.',
    '',
    'This folder is reserved for mail and mail attachments, which a separate mail export writes.',
    'If this folder holds only this file, the archive contains no mail.',
    '',
  ].join('\n'));
}

/**
 * documents/<id>.md. An id that isn't a plain name, or whose file name the
 * archive refuses (a name Windows reserves, such as `con.md` or `COM1.md`;
 * assertArchivePath), is hashed instead (`h.`, which no plain id can start
 * with), so one odd id never stops the export.
 */
export function documentMarkdownPath(id: string): string {
  const plain = `documents/${id}.md`;
  if (/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    try {
      assertArchivePath(plain);
      return plain;
    } catch {
      // A reserved name: hashed below.
    }
  }
  return `documents/h.${createHash('sha256').update(id).digest('hex')}.md`;
}

type DocumentMarkdownRow = { id: string; title: string; content_json: Parameters<typeof jsonToMarkdown>[0] };

/**
 * documents/<id>.md for every exported document, read from the snapshot
 * BODY_FETCH_LIMIT rows at a time: its title as the first heading, then its content as Markdown
 * (jsonToMarkdown, @deft/doc-schema). An image of a Deft file is written as
 * `deft-file:<file id>`, which files.jsonl lists. A document whose content
 * can't be written as Markdown is listed in omissions.jsonl; its JSON is in
 * data/documents.jsonl all the same.
 */
export async function writeDocumentMarkdown(snapshot: Snapshot, writer: ArchiveWriter, ctx: ExportContext): Promise<number> {
  let written = 0;
  for await (const row of snapshot.rows<DocumentMarkdownRow>(documentMarkdownQuery(ctx), { fetchLimit: BODY_FETCH_LIMIT })) {
    let body: string;
    try {
      body = jsonToMarkdown(row.content_json);
    } catch {
      await writer.omit({ kind: 'document', id: row.id, reason: 'Its content could not be written as Markdown; it is in data/documents.jsonl as JSON.' });
      continue;
    }
    const title = row.title.replace(/\s+/g, ' ').trim();
    await writer.writeText(documentMarkdownPath(row.id), `${[title ? `# ${title}` : '', body].filter(Boolean).join('\n\n')}\n`);
    written += 1;
  }
  return written;
}

/** One row per message, or a single row with a null id for a space with none. */
type TranscriptRow = { id: string | null; space_id: string; space_name: string; space_type: string; is_reply: boolean; author: string | null;
  content: string | null; content_omitted: boolean; created_at: Date; files: { id: string; filename: string }[] | null };

/**
 * conversations/<space-id>.html for every exported space, written while the
 * rows stream from the snapshot: threads in order, replies under their
 * message, text escaped, attachments linked when their bytes are present.
 */
export async function writeTranscripts(snapshot: Snapshot, writer: ArchiveWriter, ctx: ExportContext): Promise<number> {
  const query = sql`WITH visible_files AS (${visibleFilesSql(ctx)})
    SELECT s.id AS space_id, s.name AS space_name, s.type AS space_type, m.id, (root.id IS NOT NULL) AS is_reply,
      coalesce(u.name, 'Unknown person') AS author,
      CASE WHEN m.metadata->>'schema_version' = 'deft.private_defty_message.v1' THEN NULL ELSE m.content END AS content,
      (m.metadata->>'schema_version' = 'deft.private_defty_message.v1') IS TRUE AS content_omitted, m.created_at,
      (SELECT json_agg(json_build_object('id', vf.id, 'filename', vf.filename) ORDER BY vf.created_at, vf.id) FROM visible_files vf
        WHERE vf.attached_as = 'message' AND vf.link_message_id = m.id) AS files
    FROM spaces s
    LEFT JOIN messages m ON m.space_id = s.id AND m.org_id = ${ctx.orgId} AND ${exportableMessage(ctx, col('m.id'))}
    LEFT JOIN messages root ON root.id = m.parent_id AND root.space_id = m.space_id AND ${exportableMessage(ctx, col('root.id'))}
    LEFT JOIN users u ON u.id = m.user_id AND EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = ${ctx.orgId} AND om.user_id = m.user_id)
    WHERE s.org_id = ${ctx.orgId} AND ${spaceReadable(ctx, col('s.id'), col('s.org_id'))}
    ORDER BY s.id, coalesce(root.created_at, m.created_at), coalesce(root.id, m.id), (root.id IS NOT NULL), m.created_at, m.id`;
  // Every exported space gets a page, even one with no messages; the index
  // document stays open until its list is complete.
  const index = await writer.open('conversations/index.html');
  await index.write(page('Conversations', '<h1>Conversations</h1><p><a href="../README.html">Back to the export</a></p><ul>')
    .replace('</body></html>\n', ''));
  const open: { current: { spaceId: string; file: ArchiveFile } | null } = { current: null };
  let spaces = 0;
  const finish = async () => {
    if (!open.current) return;
    await open.current.file.write('</body></html>\n');
    await open.current.file.close();
  };
  for await (const row of snapshot.rows<TranscriptRow>(query)) {
    if (open.current?.spaceId !== row.space_id) {
      await finish();
      spaces += 1;
      const path = `conversations/${row.space_id}.html`;
      open.current = { spaceId: row.space_id, file: await writer.open(path) };
      await index.write(`<li><a href="${href(`${row.space_id}.html`, 0)}">${escapeHtml(row.space_name)}</a> <span class="muted">${escapeHtml(row.space_type)}</span></li>`);
      await open.current.file.write(page(row.space_name, `<h1>${escapeHtml(row.space_name)}</h1><p class="muted">${escapeHtml(row.space_type)} · <a href="index.html">All conversations</a></p>`)
        .replace('</body></html>\n', ''));
    }
    if (row.id === null) {
      await open.current!.file.write('<p class="muted">No messages.</p>\n');
      continue;
    }
    const files = [];
    for (const file of row.files ?? []) {
      const path = archiveFileName(file.id, file.filename);
      const present = await stat(join(writer.root, ...path.split('/'))).then((info) => info.isFile(), () => false);
      files.push(present ? `<li><a href="${href(path, 1)}">${escapeHtml(file.filename)}</a></li>`
        : `<li>${escapeHtml(file.filename)} <span class="muted">(not included; see omissions)</span></li>`);
    }
    await open.current!.file.write(`<div class="message${row.is_reply ? ' reply' : ''}" id="m-${escapeHtml(row.id)}"><strong>${escapeHtml(row.author)}</strong>
<span class="muted">${escapeHtml(new Date(row.created_at).toISOString())}</span><div class="text">${row.content_omitted
  ? '<em class="muted">Private assistant conversation; its text was not included.</em>' : escapeHtml(row.content)}</div>${files.length ? `<ul>${files.join('')}</ul>` : ''}</div>\n`);
  }
  await finish();
  await index.write('</ul></body></html>\n');
  await index.close();
  return spaces;
}
