/**
 * Two workspaces in one database for the workspace exporter's tests.
 *
 * Workspace A holds every kind of content with ordinary text. Workspace B
 * holds the same kinds, and every text value in B contains B_MARKER, so any
 * B content that reaches an export of A is found by a byte search. Every
 * secret-bearing column we know of, in both workspaces, holds a value
 * containing SECRET_MARKER, which must never appear in any export.
 */
import { createHash, randomUUID } from 'node:crypto';
import { link, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

export const B_MARKER = 'BWORKSPACEMARK';
export const SECRET_MARKER = 'SECRETMARK';

type Row = Record<string, unknown>;

export class Seeder {
  constructor(readonly client: pg.Client) {}
  async insert(table: string, row: Row): Promise<void> {
    const keys = Object.keys(row);
    const values = keys.map((key) => {
      const value = row[key];
      return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) ? JSON.stringify(value) : value;
    });
    await this.client.query(
      `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(', ')})`,
      values,
    );
  }
  /** Plants a secret marker naming the column, so a leak says where it came from. */
  secret(column: string): string {
    return `${SECRET_MARKER}-${column}-${randomUUID().slice(0, 8)}`;
  }
}

export type WorkspaceIds = {
  orgId: string; slug: string;
  owner: string; member: string; other: string; guest: string; former: string; agentUser: string; agentEmployee: string;
  spaces: Record<'general' | 'publicUnjoined' | 'privateOthers' | 'privateWithMember' | 'dmMemberOther' | 'dmOwnerOther'
    | 'archivedPrivateWithMember' | 'archivedPublic' | 'groupDm' | 'agentConversation', string>;
};

export type ContentIds = {
  messages: Record<string, string>; tasks: Record<string, string>; projects: Record<string, string>; labels: Record<string, string>;
  /** The private assistant conversation, owned by the workspace owner. */
  sealedSpace: string;
  notes: Record<string, string>; wiki: Record<string, string>; events: Record<string, string>; folders: Record<string, string>;
};

export type ExportWorld = {
  a: WorkspaceIds & ContentIds & { files: Record<string, string> }; b: WorkspaceIds & ContentIds & { files: Record<string, string> };
  shared: string; ids: string[];
  /** The uploads folder both workspaces store their attachment bytes in. */
  uploadsDir: string;
  /** Exact strings (beyond SECRET_MARKER) that must never appear in an export, such as base64 ciphertext. */
  forbidden: string[];
};

const text = (isB: boolean, value: string) => (isB ? `${value} ${B_MARKER}` : value);

async function seedWorkspace(s: Seeder, label: string, isB: boolean, ids: string[]): Promise<WorkspaceIds> {
  const id = () => { const value = randomUUID(); ids.push(value); return value; };
  const orgId = id();
  const slug = `ex1-${label}-${orgId.slice(0, 8)}`;
  await s.insert('orgs', { id: orgId, name: text(isB, `Workspace ${label}`), slug, ai_config: { api_key: s.secret('orgs.ai_config') } });
  const person = async (name: string, role: string, isActive = true, kind = 'human') => {
    const userId = id();
    await s.insert('users', {
      id: userId, email: `${label}-${name}-${userId.slice(0, 8)}@example.test`, name: text(isB, `${label} ${name}`), kind,
      is_agent: kind === 'agent', title: text(isB, `${name} title`), password_hash: s.secret('users.password_hash'),
      ics_publish_token: s.secret('users.ics_publish_token'), email_verified: true,
    });
    await s.insert('org_members', { id: id(), org_id: orgId, user_id: userId, role, is_active: isActive });
    return userId;
  };
  const owner = await person('owner', 'owner');
  const member = await person('member', 'member');
  const other = await person('other', 'member');
  const guest = await person('guest', 'guest');
  const former = await person('former', 'member', false);
  const agentUser = await person('agent', 'member', true, 'agent');
  const agentEmployee = id();
  await s.insert('agent_employees', {
    id: agentEmployee, org_id: orgId, user_id: agentUser, name: text(isB, `${label} agent`), slug: `agent-${agentEmployee.slice(0, 8)}`,
    role: 'project_manager', system_prompt: s.secret('agent_employees.system_prompt'), mcp_token_hash: s.secret('agent_employees.mcp_token_hash'),
    job_title: text(isB, 'Agent job'), is_byoa: true, created_by: owner,
  });
  await s.client.query('UPDATE users SET agent_employee_id = $2 WHERE id = $1', [agentUser, agentEmployee]);

  const space = async (name: string, type: string, members: string[], archived = false) => {
    const spaceId = id();
    await s.insert('spaces', { id: spaceId, org_id: orgId, name: text(isB, `${label} ${name}`), type, is_archived: archived,
      description: text(isB, `${name} description`), topic: text(isB, `${name} topic`), created_by: owner });
    for (const userId of members) await s.insert('space_members', { id: id(), space_id: spaceId, user_id: userId });
    return spaceId;
  };
  const spaces = {
    general: await space('general', 'public', [owner, member, other, guest, former]),
    publicUnjoined: await space('public-unjoined', 'public', [other]),
    privateOthers: await space('private-others', 'private', [owner, other]),
    privateWithMember: await space('private-with-member', 'private', [member, other, guest]),
    dmMemberOther: await space('dm-member-other', 'dm', [member, other]),
    dmOwnerOther: await space('dm-owner-other', 'dm', [owner, other]),
    archivedPrivateWithMember: await space('archived-private', 'private', [member], true),
    archivedPublic: await space('archived-public', 'public', [other], true),
    groupDm: await space('group-dm', 'group_dm', [owner, member, guest]),
    agentConversation: await space('agent-conversation', 'agent_conversation', [other, agentUser]),
  };

  // Credentials and links Deft stores for this workspace. None may be exported.
  await s.insert('invites', { id: id(), org_id: orgId, token: s.secret('invites.token'), invited_by: owner });
  await s.insert('web_sessions', { id: id(), org_id: orgId, user_id: member, refresh_token_hash: s.secret('web_sessions.refresh_token_hash'),
    expires_at: new Date(Date.now() + 86_400_000) });
  await s.insert('connected_accounts', { id: id(), org_id: orgId, user_id: member, provider: 'google_calendar',
    access_token_encrypted: s.secret('connected_accounts.access_token_encrypted'),
    refresh_token_encrypted: s.secret('connected_accounts.refresh_token_encrypted') });
  await s.insert('ics_subscriptions', { id: id(), org_id: orgId, user_id: member, ics_url: `https://calendar.example.test/${s.secret('ics_subscriptions.ics_url')}.ics` });
  await s.insert('ics_publish_tokens', { id: id(), org_id: orgId, user_id: member, token: s.secret('ics_publish_tokens.token') });
  await s.insert('api_keys', { id: id(), org_id: orgId, name: 'key', key_hash: s.secret('api_keys.key_hash'), key_prefix: 'dk_test',
    permissions: ['read'], created_by: owner });
  await s.insert('agent_webhooks', { id: id(), org_id: orgId, agent_employee_id: agentEmployee, slug: `hook-${orgId.slice(0, 8)}`,
    secret_hash: s.secret('agent_webhooks.secret_hash'), hmac_key_encrypted: s.secret('agent_webhooks.hmac_key_encrypted') });
  await s.insert('user_two_step', { user_id: owner, secret_encrypted: s.secret('user_two_step.secret_encrypted'),
    pending_secret_encrypted: s.secret('user_two_step.pending_secret_encrypted') });
  await s.insert('user_two_step_recovery_codes', { id: id(), user_id: owner, code_hash: s.secret('user_two_step_recovery_codes.code_hash') });

  return { orgId, slug, owner, member, other, guest, former, agentUser, agentEmployee, spaces };
}

/**
 * Messages and tasks for one workspace. A private assistant conversation is
 * sealed the way the product seals one, so its ciphertext is real.
 */
async function seedContent(s: Seeder, ws: WorkspaceIds, isB: boolean, ids: string[], forbidden: string[]): Promise<ContentIds> {
  const id = () => { const value = randomUUID(); ids.push(value); return value; };
  const messages: Record<string, string> = {};
  const message = async (key: string, spaceId: string, userId: string, extra: Row = {}) => {
    messages[key] = id();
    await s.insert('messages', { id: messages[key], org_id: ws.orgId, space_id: spaceId, user_id: userId,
      content: text(isB, `message ${key}`), ...extra });
    return messages[key]!;
  };
  for (const [key, spaceId] of Object.entries(ws.spaces)) {
    if (key === 'agentConversation') continue;
    const root = await message(key, spaceId, ws.other);
    await message(`${key}-reply`, spaceId, ws.other, { parent_id: root });
  }
  await message('linkPreview', ws.spaces.general, ws.member, { metadata: { link_previews: [{ url: `https://x.test/${s.secret('messages.metadata')}` }] } });
  await message('deleted', ws.spaces.general, ws.member, { is_deleted: true });
  await message('replyToDeleted', ws.spaces.general, ws.other, { parent_id: messages.deleted });
  await message('toolResult', ws.spaces.agentConversation, ws.agentUser, { metadata: { kind: 'tool_result' } });
  await message('hidden', ws.spaces.agentConversation, ws.agentUser, { metadata: { hidden: true } });
  await message('byFormer', ws.spaces.general, ws.former);
  await s.insert('reactions', { id: id(), message_id: messages.general, user_id: ws.member, emoji: '👍' });
  await s.insert('canvases', { id: id(), org_id: ws.orgId, space_id: ws.spaces.privateOthers, title: text(isB, 'canvas'),
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: text(isB, 'canvas text') }] }] }, last_edited_by: ws.other });

  // A private assistant conversation, sealed exactly as the product does.
  const { ensureDeftyEmployee } = await import('../../src/lib/ensure-defty-membership.js');
  const defty = await ensureDeftyEmployee(ws.orgId);
  const sealedSpace = id();
  await s.insert('spaces', { id: sealedSpace, org_id: ws.orgId, name: text(isB, 'private assistant'), type: 'agent_conversation', created_by: ws.owner });
  for (const userId of [ws.owner, defty.userId]) await s.insert('space_members', { id: id(), space_id: sealedSpace, user_id: userId });
  const sealId = id();
  await s.insert('app_private_defty_seals', { id: sealId, org_id: ws.orgId, space_id: sealedSpace, owner_user_id: ws.owner, defty_user_id: defty.userId });
  const ciphertext = Buffer.from(s.secret('private_defty.ciphertext')).toString('base64');
  forbidden.push(ciphertext);
  messages.privateAssistant = id();
  await s.client.query('BEGIN');
  await s.client.query("SELECT set_config('deft.private_defty_write', $1, true)", [sealId]);
  await s.insert('messages', { id: messages.privateAssistant, org_id: ws.orgId, space_id: sealedSpace, user_id: ws.owner,
    content: '[Private context prompt]', metadata: { schema_version: 'deft.private_defty_message.v1', seal_id: sealId, grant_id: id(),
      request_id: randomUUID(), role: 'user', envelope: { schema_version: 'deft.secret.v1', algorithm: 'aes-256-gcm', key_version: 'k1',
        nonce_b64: Buffer.alloc(12, 1).toString('base64'), ciphertext_b64: ciphertext, auth_tag_b64: Buffer.alloc(16, 2).toString('base64') } } });
  await s.client.query('COMMIT');

  const projects = { live: id(), deleted: id() };
  const prefix = ws.orgId.replace(/[^a-z]/g, '').slice(0, 4).toUpperCase() || 'X';
  await s.insert('projects', { id: projects.live, org_id: ws.orgId, name: text(isB, 'project'), prefix: `P${prefix}`, lead_id: ws.owner });
  await s.insert('projects', { id: projects.deleted, org_id: ws.orgId, name: text(isB, 'deleted project'), prefix: `D${prefix}`,
    is_deleted: true, deleted_at: new Date() });
  const labels = { bug: id() };
  await s.insert('labels', { id: labels.bug, org_id: ws.orgId, name: text(isB, 'bug'), color: '#f00' });
  const tasks: Record<string, string> = {};
  let number = 0;
  const task = async (key: string, extra: Row = {}, projectId = projects.live) => {
    tasks[key] = id();
    await s.insert('tasks', { id: tasks[key], org_id: ws.orgId, project_id: projectId, number: ++number, title: text(isB, `task ${key}`),
      description: text(isB, `description ${key}`), created_by: ws.owner, ...extra });
    return tasks[key]!;
  };
  await task('open', { assignee_id: ws.member, metadata: { custom: s.secret('tasks.metadata') } });
  await task('subtask', { parent_task_id: tasks.open });
  await task('restricted', { metadata: { visibility: 'restricted', visible_user_ids: [ws.other] } });
  await task('restrictedWatched', { metadata: { visibility: 'restricted' } });
  await task('restrictedAssigned', { metadata: { visibility: 'restricted' } });
  await task('deleted', { is_deleted: true });
  await task('inDeletedProject', {}, projects.deleted);
  await s.insert('task_watchers', { id: id(), task_id: tasks.restrictedWatched, user_id: ws.member });
  await s.insert('task_assignees', { id: id(), task_id: tasks.restrictedAssigned, user_id: ws.guest });
  await s.insert('task_assignees', { id: id(), task_id: tasks.open, user_id: ws.other });
  await s.insert('task_labels', { task_id: tasks.open, label_id: labels.bug });
  await s.insert('task_relationships', { id: id(), source_task_id: tasks.open, target_task_id: tasks.restricted, type: 'blocks' });
  await s.insert('task_reactions', { id: id(), org_id: ws.orgId, task_id: tasks.open, user_id: ws.member, emoji: '🎉' });
  for (const key of ['open', 'restricted', 'deleted']) {
    await s.insert('task_comments', { id: id(), org_id: ws.orgId, task_id: tasks[key], user_id: ws.other, content: text(isB, `comment on ${key}`) });
  }
  await s.insert('task_comments', { id: id(), org_id: ws.orgId, task_id: tasks.open, user_id: ws.other, content: text(isB, 'deleted comment'), is_deleted: true });

  // Notes: private, workspace-wide, shared, visible to a space, deleted.
  const folders = { owner: id(), other: id() };
  await s.insert('note_folders', { id: folders.owner, org_id: ws.orgId, user_id: ws.owner, name: text(isB, 'owner folder') });
  await s.insert('note_folders', { id: folders.other, org_id: ws.orgId, user_id: ws.other, name: text(isB, 'other folder') });
  const notes: Record<string, string> = {};
  const note = async (key: string, userId: string, extra: Row = {}) => {
    notes[key] = id();
    await s.insert('notes', { id: notes[key], org_id: ws.orgId, user_id: userId, title: text(isB, `note ${key}`),
      content: `<p>${text(isB, `note body ${key}`)}</p>`, ...extra });
  };
  await note('privateOther', ws.other, { folder_id: folders.other });
  await note('orgWide', ws.other, { visibility: 'org', folder_id: folders.other });
  await note('sharedWithMember', ws.other);
  await note('spacePrivateWithMember', ws.other, { visibility: 'space', visibility_space_id: ws.spaces.privateWithMember });
  await note('spacePrivateOthers', ws.owner, { visibility: 'space', visibility_space_id: ws.spaces.privateOthers });
  await note('ownerPrivate', ws.owner, { folder_id: folders.owner });
  await note('deleted', ws.member, { is_deleted: true });
  await s.insert('note_shares', { id: id(), note_id: notes.sharedWithMember, shared_with_user_id: ws.member });

  // Wiki: workspace, personal, space, deleted, and a page routed from mail to one person.
  const wiki: Record<string, string> = {};
  const page = async (key: string, extra: Row) => {
    wiki[key] = id();
    await s.insert('wiki_pages', { id: wiki[key], org_id: ws.orgId, type: 'concept', title: text(isB, `wiki ${key}`),
      slug: `${key.toLowerCase()}-${wiki[key]!.slice(0, 8)}`, content: text(isB, `wiki body ${key}`),
      metadata: { private_note: s.secret('wiki_pages.metadata') }, previous_content: s.secret('wiki_pages.previous_content'), ...extra });
  };
  await page('org', { scope: 'org', user_id: ws.owner });
  await page('personalOther', { scope: 'user', user_id: ws.other });
  await page('spacePrivateOthers', { scope: 'space', space_id: ws.spaces.privateOthers });
  await page('spacePrivateWithMember', { scope: 'space', space_id: ws.spaces.privateWithMember });
  await page('deleted', { scope: 'org', is_deleted: true });
  await page('routedToMember', { scope: 'user', user_id: ws.member, created_via: 'app_integration_capture' });
  await s.insert('wiki_links', { id: id(), org_id: ws.orgId, source_page_id: wiki.org, target_page_id: wiki.personalOther });
  await s.insert('wiki_links', { id: id(), org_id: ws.orgId, source_page_id: wiki.org, target_page_id: wiki.spacePrivateWithMember });

  // Events, all tomorrow so the Calendar route can be asked about them.
  const events: Record<string, string> = {};
  const tomorrow = new Date(Date.now() + 86_400_000);
  const event = async (key: string, userId: string | null, extra: Row = {}) => {
    events[key] = id();
    await s.insert('events', { id: events[key], org_id: ws.orgId, source: 'native', event_type: 'calendar_event', title: text(isB, `event ${key}`),
      body: text(isB, `event body ${key}`), timestamp: tomorrow, user_id: userId, metadata: {
        start: tomorrow.toISOString(), end: new Date(tomorrow.getTime() + 3_600_000).toISOString(), location: text(isB, 'room'),
        attendees: [{ email: 'guest@example.test', displayName: text(isB, 'attendee'), token: s.secret('events.attendee') }],
        hangoutLink: `https://meet.example.test/${s.secret('events.hangoutLink')}`, status: 'confirmed', allDay: false,
        app_calendar_source: { source_scope_key: s.secret('events.app_calendar_source'), event: {
          start: { value: '20261201T090000', value_type: 'date_time', time_zone: 'Europe/London', instant: '2026-12-01T09:00:00.000Z' },
          end: { value: '20261201T100000', value_type: 'date_time', time_zone: 'Europe/London', instant: '2026-12-01T10:00:00.000Z' },
          rrule: 'FREQ=WEEKLY;COUNT=4', exdates: [], recurrence_id: null, uid: s.secret('events.uid') } },
      }, ...extra });
  };
  await event('member', ws.member);
  await event('other', ws.other);
  await event('noOwner', null, { source: 'github', event_type: 'pr_merged' });
  await event('memberCanceled', ws.member);
  await s.client.query(`UPDATE events SET metadata = jsonb_set(metadata, '{status}', '"canceled"') WHERE id = $1`, [events.memberCanceled]);
  // Malformed metadata: an object where text is expected must not be written out.
  await event('nested', ws.member);
  await s.client.query(`UPDATE events SET metadata = jsonb_set(metadata, '{location}', jsonb_build_object('hidden', $2::text)) WHERE id = $1`,
    [events.nested, s.secret('events.location_object')]);
  // A share kept after its recipient left the workspace.
  await s.insert('note_shares', { id: id(), note_id: notes.orgWide, shared_with_user_id: ws.former });

  return { messages, tasks, projects, labels, notes, wiki, events, folders, sealedSpace };
}

/**
 * Attachments of every link kind and every failure the exporter must report,
 * stored in one uploads folder shared by both workspaces.
 */
async function seedFiles(s: Seeder, ws: WorkspaceIds & ContentIds, isB: boolean, ids: string[], uploadsDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const file = async (key: string, options: { bytes?: string | null; message?: string[]; task?: string[]; legacyMessage?: string; legacyTask?: string;
    uploadedBy?: string; extra?: Row; recordedSize?: number; recordedHash?: string | null; storageKey?: string } = {}) => {
    const fileId = randomUUID(); ids.push(fileId); files[key] = fileId;
    const bytes = Buffer.from(options.bytes ?? text(isB, `bytes of ${key}`));
    const storageKey = options.storageKey ?? `${fileId}.bin`;
    if (options.bytes !== null && !options.storageKey) await writeFile(join(uploadsDir, storageKey), bytes);
    await s.insert('files', { id: fileId, org_id: ws.orgId, uploaded_by: options.uploadedBy ?? ws.other, filename: text(isB, `${key}.txt`),
      mime_type: 'text/plain', size_bytes: options.recordedSize ?? bytes.length, storage_key: storageKey,
      content_sha256: options.recordedHash === undefined ? `sha256:${createHash('sha256').update(bytes).digest('hex')}` : options.recordedHash,
      message_id: options.legacyMessage ?? null, task_id: options.legacyTask ?? null, ...options.extra });
    for (const [position, messageId] of (options.message ?? []).entries()) {
      await s.insert('message_attachments', { org_id: ws.orgId, message_id: messageId, file_id: fileId, position });
    }
    for (const [position, taskId] of (options.task ?? []).entries()) {
      await s.insert('task_attachments', { org_id: ws.orgId, task_id: taskId, file_id: fileId, position });
    }
  };
  await file('onGeneral', { message: [ws.messages.general!] });
  await file('onGeneral2', { message: [ws.messages['general-reply']!] });
  await file('onPrivateOthers', { message: [ws.messages.privateOthers!] });
  await file('onDm', { message: [ws.messages.dmMemberOther!] });
  await file('onOpenTask', { task: [ws.tasks.open!] });
  await file('onRestrictedTask', { task: [ws.tasks.restricted!] });
  await file('legacyWatchedTask', { legacyTask: ws.tasks.restrictedWatched! });
  await file('legacyDm', { legacyMessage: ws.messages.dmOwnerOther! });
  await file('legacyTaskBeforeMessage', { legacyTask: ws.tasks.restricted!, legacyMessage: ws.messages.general! });
  await file('unattachedMember', { uploadedBy: ws.member });
  await file('unattachedOther', { uploadedBy: ws.other });
  await file('ambiguous', { message: [ws.messages.general!, ws.messages['general-reply']!] });
  await file('blocked', { message: [ws.messages.general!], extra: { processing_status: 'blocked' } });
  await file('onDeletedMessage', { message: [ws.messages.deleted!] });
  await file('missing', { bytes: null, message: [ws.messages.general!], recordedSize: 10, recordedHash: null });
  await file('sizeMismatch', { message: [ws.messages.general!], recordedSize: 3, recordedHash: null });
  await file('hashMismatch', { message: [ws.messages.general!], recordedHash: `sha256:${'0'.repeat(64)}` });
  // The typed link decides even when the legacy column names something else.
  await file('typedOverLegacy', { message: [ws.messages.privateOthers!], legacyTask: ws.tasks.open! });
  await file('messageAndTask', { message: [ws.messages.general!], task: [ws.tasks.open!] });
  await file('onDeletedTask', { task: [ws.tasks.deleted!] });
  await file('stagedByMember', { uploadedBy: ws.member, extra: { staged_expires_at: new Date(Date.now() + 3_600_000) } });
  return files;
}

/**
 * A rows that reach B's bytes through another name for the same file: a
 * padded name, a differently cased name, and a hard link. Each copies B's
 * size and checksum, so only the provenance checks can keep B's bytes out.
 */
async function seedFileAliases(s: Seeder, a: WorkspaceIds & ContentIds, aFiles: Record<string, string>, bFiles: Record<string, string>,
  uploadsDir: string, ids: string[]): Promise<void> {
  const source = async (fileId: string) => (await s.client.query<{ storage_key: string; size_bytes: number; content_sha256: string }>(
    'SELECT storage_key, size_bytes, content_sha256 FROM files WHERE id = $1', [fileId])).rows[0]!;
  const alias = async (key: string, storageKey: string, from: { size_bytes: number; content_sha256: string }) => {
    aFiles[key] = randomUUID();
    ids.push(aFiles[key]!);
    await s.insert('files', { id: aFiles[key], org_id: a.orgId, uploaded_by: a.member, filename: `${key}.txt`, mime_type: 'text/plain',
      size_bytes: from.size_bytes, storage_key: storageKey, content_sha256: from.content_sha256 });
    await s.insert('message_attachments', { org_id: a.orgId, message_id: a.messages.general, file_id: aFiles[key], position: 10 });
  };
  const padded = await source(bFiles.onOpenTask!);
  await alias('paddedAlias', ` ${padded.storage_key} `, padded);
  await alias('caseAlias', padded.storage_key.toUpperCase(), padded);
  const linked = await source(bFiles.onDm!);
  const linkName = `${randomUUID()}-link.bin`;
  await link(join(uploadsDir, linked.storage_key), join(uploadsDir, linkName));
  await alias('hardLink', linkName, linked);
}

/** Seeds A and B, a person who belongs to both, and malformed cross-workspace links. */
export async function seedExportWorld(client: pg.Client, uploadsDir: string): Promise<ExportWorld> {
  const s = new Seeder(client);
  const ids: string[] = [];
  const forbidden: string[] = [];
  const aIds = await seedWorkspace(s, 'a', false, ids);
  const bIds = await seedWorkspace(s, 'b', true, ids);
  const a = { ...aIds, ...await seedContent(s, aIds, false, ids, forbidden) };
  const b = { ...bIds, ...await seedContent(s, bIds, true, ids, forbidden) };
  // A person in both workspaces, a member of a private space in each.
  const shared = randomUUID();
  ids.push(shared);
  await s.insert('users', { id: shared, email: `shared-${shared.slice(0, 8)}@example.test`, name: 'Shared person', kind: 'human' });
  for (const [ws, spaceId] of [[a, a.spaces.privateWithMember], [b, b.spaces.privateOthers]] as const) {
    await s.insert('org_members', { id: randomUUID(), org_id: ws.orgId, user_id: shared, role: 'member' });
    await s.insert('space_members', { id: randomUUID(), space_id: spaceId, user_id: shared });
  }
  // Malformed: a B-only person listed as a member of an A space, and an A
  // member listed in a B space. Neither may put B into A's export.
  await s.insert('space_members', { id: randomUUID(), space_id: a.spaces.general, user_id: b.owner });
  await s.insert('space_members', { id: randomUUID(), space_id: b.spaces.general, user_id: a.member });
  // A space created by a B person.
  await client.query('UPDATE spaces SET created_by = $2 WHERE id = $1', [a.spaces.publicUnjoined, b.owner]);
  // Malformed links from A content to B rows or B people.
  await s.insert('reactions', { id: randomUUID(), message_id: a.messages.general, user_id: b.owner, emoji: '👎' });
  await s.insert('task_labels', { task_id: a.tasks.open, label_id: b.labels.bug });
  await s.insert('task_relationships', { id: randomUUID(), source_task_id: a.tasks.open, target_task_id: b.tasks.open, type: 'relates_to' });
  await s.insert('task_relationships', { id: randomUUID(), source_task_id: b.tasks.open, target_task_id: a.tasks.open, type: 'relates_to' });
  await s.insert('task_comments', { id: randomUUID(), org_id: a.orgId, task_id: b.tasks.open, user_id: b.owner, content: `misfiled ${B_MARKER}` });
  await s.insert('task_watchers', { id: randomUUID(), task_id: a.tasks.open, user_id: b.owner });
  await client.query('UPDATE tasks SET parent_task_id = $2 WHERE id = $1', [a.tasks.restricted, b.tasks.open]);
  await client.query('UPDATE messages SET parent_id = $2 WHERE id = $1', [a.messages.byFormer, b.messages.general]);
  await s.insert('note_shares', { id: randomUUID(), note_id: a.notes.sharedWithMember, shared_with_user_id: b.owner });
  // An A note folder owned by a B person.
  await s.insert('note_folders', { id: randomUUID(), org_id: a.orgId, user_id: b.owner, name: 'misfiled folder' });
  await s.insert('wiki_links', { id: randomUUID(), org_id: a.orgId, source_page_id: a.wiki.org, target_page_id: b.wiki.org });
  await client.query('UPDATE notes SET folder_id = $2, visibility_space_id = $3 WHERE id = $1', [a.notes.orgWide, b.folders.other, b.spaces.general]);
  await client.query('UPDATE events SET user_id = $2 WHERE id = $1', [a.events.noOwner, b.owner]);
  const aFiles = await seedFiles(s, a, false, ids, uploadsDir);
  const bFiles = await seedFiles(s, b, true, ids, uploadsDir);
  // An A row that names B's stored bytes, and a B file whose legacy column points at an A message.
  // Same name, size and checksum as B's file, so only the ownership check can keep B's bytes out.
  const bFile = (await client.query<{ storage_key: string; size_bytes: number; content_sha256: string }>(
    'SELECT storage_key, size_bytes, content_sha256 FROM files WHERE id = $1', [bFiles.onGeneral])).rows[0]!;
  aFiles.namesBStorage = randomUUID();
  ids.push(aFiles.namesBStorage);
  await s.insert('files', { id: aFiles.namesBStorage, org_id: a.orgId, uploaded_by: a.member, filename: 'stolen.txt', mime_type: 'text/plain',
    size_bytes: bFile.size_bytes, storage_key: bFile.storage_key, content_sha256: bFile.content_sha256 });
  await s.insert('message_attachments', { org_id: a.orgId, message_id: a.messages.general, file_id: aFiles.namesBStorage, position: 9 });
  await client.query('UPDATE files SET message_id = $2 WHERE id = $1', [bFiles.unattachedOther, a.messages.general]);
  await seedFileAliases(s, a, aFiles, bFiles, uploadsDir, ids);
  return { a: { ...a, files: aFiles }, b: { ...b, files: bFiles }, shared, ids, forbidden, uploadsDir };
}

/**
 * Deletes what the world created, children first, best effort: a sealed
 * private assistant conversation is permanent by design, so its space, its
 * workspace and its people stay behind in the disposable test database.
 * The shared Defty system user is never deleted.
 */
export async function dropExportWorld(client: pg.Client, world: ExportWorld): Promise<void> {
  const orgs = [world.a.orgId, world.b.orgId];
  const users = (await client.query<{ user_id: string }>(`SELECT m.user_id FROM org_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ANY($1) AND u.email IS DISTINCT FROM 'deft-agent@system.local'`, [orgs])).rows.map((row) => row.user_id);
  for (const statement of [
    'DELETE FROM message_attachments WHERE org_id = ANY($1)',
    'DELETE FROM task_attachments WHERE org_id = ANY($1)',
    'DELETE FROM files WHERE org_id = ANY($1)',
    'DELETE FROM note_shares WHERE note_id IN (SELECT id FROM notes WHERE org_id = ANY($1))',
    'DELETE FROM notes WHERE org_id = ANY($1)',
    'DELETE FROM note_folders WHERE org_id = ANY($1)',
    'DELETE FROM wiki_links WHERE org_id = ANY($1)',
    'DELETE FROM wiki_pages WHERE org_id = ANY($1)',
    'DELETE FROM events WHERE org_id = ANY($1)',
    'DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE org_id = ANY($1))',
    'DELETE FROM task_comments WHERE org_id = ANY($1)',
    'DELETE FROM task_reactions WHERE org_id = ANY($1)',
    'DELETE FROM task_relationships WHERE source_task_id IN (SELECT id FROM tasks WHERE org_id = ANY($1)) OR target_task_id IN (SELECT id FROM tasks WHERE org_id = ANY($1))',
    'DELETE FROM task_labels WHERE task_id IN (SELECT id FROM tasks WHERE org_id = ANY($1))',
    'DELETE FROM task_watchers WHERE task_id IN (SELECT id FROM tasks WHERE org_id = ANY($1))',
    'DELETE FROM task_assignees WHERE task_id IN (SELECT id FROM tasks WHERE org_id = ANY($1))',
    'UPDATE tasks SET parent_task_id = NULL WHERE org_id = ANY($1)',
    'DELETE FROM tasks WHERE org_id = ANY($1)',
    'DELETE FROM projects WHERE org_id = ANY($1)',
    'DELETE FROM labels WHERE org_id = ANY($1)',
    'DELETE FROM canvases WHERE org_id = ANY($1)',
    'UPDATE messages SET parent_id = NULL WHERE org_id = ANY($1) AND space_id NOT IN (SELECT space_id FROM app_private_defty_seals)',
    'DELETE FROM messages WHERE org_id = ANY($1) AND space_id NOT IN (SELECT space_id FROM app_private_defty_seals)',
    'DELETE FROM user_two_step_recovery_codes WHERE user_id = ANY($2)',
    'DELETE FROM user_two_step WHERE user_id = ANY($2)',
    'DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = ANY($1))',
    'DELETE FROM agent_webhooks WHERE org_id = ANY($1)',
    'DELETE FROM api_keys WHERE org_id = ANY($1)',
    'DELETE FROM ics_publish_tokens WHERE org_id = ANY($1)',
    'DELETE FROM ics_subscriptions WHERE org_id = ANY($1)',
    'DELETE FROM connected_accounts WHERE org_id = ANY($1)',
    'DELETE FROM web_sessions WHERE org_id = ANY($1)',
    'DELETE FROM invites WHERE org_id = ANY($1)',
    'DELETE FROM spaces WHERE org_id = ANY($1)',
    'UPDATE users SET agent_employee_id = NULL WHERE id = ANY($2)',
    'DELETE FROM agent_employees WHERE org_id = ANY($1)',
    'DELETE FROM org_members WHERE org_id = ANY($1)',
    'DELETE FROM users WHERE id = ANY($2)',
    'DELETE FROM orgs WHERE id = ANY($1)',
  ]) {
    await client.query(statement.replace('$2', '$1'), [statement.includes('$2') ? users : orgs]).catch(() => undefined);
  }
}
