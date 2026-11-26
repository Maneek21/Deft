// Drives and their members (spec 5.1 and 5.2; plan Task F4).
//
// Every route reads the caller's role with driveRoleFor (lib/document-access.ts)
// for the drive's workspace, which must be the caller's: a drive they can't
// see, in this workspace or another, is a 404, never a 403.
// - Reading a drive, and its tree, needs view; its trash needs edit (the
//   documents in them: lib/documents.ts). Settings and deleting it need
//   full; the Workspace, Shared notes and personal drives can't be deleted.
// - Members: full, or the admin path. An owner or admin who isn't a full
//   member of a private drive sees it listed (adminListedDriveCondition) and
//   may manage its members, adding themselves included, but can't open it
//   until they are a member. Each such change writes its audit row in the
//   same transaction (so a change never commits without it), every current
//   human member apart from the actor is sent a `document_shared`
//   notification (subtype `admin_change`), and GET /:id/members returns the
//   recent ones as `admin_changes`, which the members panel shows as a notice.
// - Links: linking a chat, or raising a link's role, needs full and
//   membership of the chat (locked until commit); lowering or removing a
//   link needs full. That holds whichever endpoint the change comes through:
//   the admin path doesn't reach link rows.
// - A grant, made or raised, can't name someone who could never hold access
//   (canHoldDocumentAccess), nor a chat of this workspace the caller can't
//   read: 400 PRINCIPAL_CANNOT_HOLD_ACCESS. Lowering or removing a grant is
//   always allowed, so stale grants can be cleaned up.
// - Adding a person or a chat, or linking a chat, sends `document_shared`
//   (subtype `drive_member`) to the person, human or agent, or to each human
//   in the chat, apart from the actor. Notifications naming a drive stay
//   listed only while the reader can view it (lib/native-mention-visibility.ts).
//
// Access changes (consult rule C3): removing or lowering a member, removing or
// lowering a link, lowering a default role and deleting a drive run
// applyAccessLossInTx in their transaction and finishAccessLoss after it.
// Changes that only add access emit emitDocumentAccessChanged after commit.
// Each mutation locks the drive row first and checks the caller's role under
// that lock, so changes to one drive run one after another, and every check
// inside it reads through the same transaction.
//
// Departed members (spec 5.2, F6): a departure freezes the person's personal
// drive (lib/drives.ts endDriveAccessOnDepartureInTx); a frozen drive gives
// nobody anything through its own grants, owners and admins included, so
// every route here answers it with 404. Only the workspace owner lists frozen
// drives (GET /frozen) and hands one on (POST /:id/handover); anyone else
// gets 403 OWNER_ONLY. The handover makes it a private drive with the new
// holder at full, audited in the same transaction, and tells the holder.
// Owners and admins list the private drives no active member holds full on
// in their own name (GET /without-manager), and give one a manager through
// the admin path above.
//
// Lock order (lockActorInTx, lib/drive-locks.ts): every drive write (create,
// settings, delete, member add, change and removal, link and unlink), and
// every folder and document write (lib/documents.ts), first takes the actor's
// room-access lock (lib/room-access-lock.ts), then their org_members row FOR
// SHARE, then the drive row, then anything under it (a chat seat FOR SHARE,
// member rows, folders and documents; a document move locks both drives in
// id order). That is the departure path's own order: removing someone,
// changing their workspace role and removing them from a chat all take
// their room-access lock first, then their membership rows (a removal then
// freezes their drive). So an actor's demotion, removal or loss of a chat
// waits for a write they have started, or the write waits and then reads
// the change, and nothing deadlocks against a departure. The share lock on
// the membership row also holds against changes that don't take the
// room-access lock (deleting an agent employee locks the agent's rows).
//
// A grant made or raised also locks its recipient between the actor and the
// drive (lockRecipientInTx): a person's org_members row, then an agent's
// employee row, FOR SHARE, or a chat's spaces row FOR SHARE, and checks the
// recipient under those locks. A removal locks the person's room-access lock,
// then their users and org_members rows FOR UPDATE, then their drive; a pause
// (manageAgent) locks their users and org_members rows, then updates the
// employee; archiving a chat updates its spaces row and nothing here. Each
// takes the recipient's rows in the same order as a grant and holds nothing
// a grant takes before them, so one waits for the other and none cycles.
//
// The privileged reads (the members panel, drives without a manager, frozen
// drives) and the tree and trash run their authorization and their data
// reads in one read-only, repeatable-read transaction (READ_SNAPSHOT), so
// both see one snapshot.
//
// Deleting a drive, or changing its Knowledge default, raises a lifecycle
// event for each of its documents, so Knowledge withdraws or re-learns them
// (H4). Neither sends a socket event: after a delete nobody can view the
// documents any more (rule C4).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { docFavorites, documents, driveMembers, drives, type DocRole, type DriveMemberRow, type DriveRow } from '@deft/db/documents';
import { auditLog, orgMembers, spaceMembers, spaces, users } from '@deft/db/schema';
import { db } from '../lib/db.js';
import { DOC_ROLE_RANK, canHoldDocumentAccess, driveRoleFor, roleAtLeast } from '../lib/document-access.js';
import { accessLossInTx, finishAccessLoss } from '../lib/document-access-change.js';
import { emitDocumentAccessChanged, type DocumentAccessChange } from '../lib/document-access-events.js';
import { emitDocumentEvent } from '../lib/document-events.js';
import { driveTrash, driveTree } from '../lib/documents.js';
import { driveAccess, lockActorInTx, type DriveAccess } from '../lib/drive-locks.js';
import { orgNeedsMove } from '../lib/drives-move/pending.js';
import {
  canHoldDocumentAccessLocked, driveListQuery, drivesWithoutManagerQuery, ensurePersonalDrive, ensureWorkspaceDrive, finishDriveHandover, frozenDrivesQuery,
  handOverPersonalDriveInTx, PrincipalCannotHoldAccessError,
} from '../lib/drives.js';
import { emitVisibleNotifications } from '../lib/notification-delivery.js';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { createNotificationIfAllowed } from '../lib/notification-policy.js';
import { asStoredNotificationType } from '../lib/notification-types.js';
import { isPausedStart } from '../lib/paused-start.js';
import { canSeePerson, peopleViewer, visiblePersonIds } from '../lib/people-visibility.js';
import { jsonBody } from '../lib/request-body.js';
import { canReadSpace, unjoinedPublicSpaceReadableSql } from '../lib/space-membership.js';
import type { AuthUser } from '../middleware/auth.js';

export const driveRoutes = new Hono();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<typeof db, 'select' | 'execute'>;
type Refusal = { status: 400 | 403 | 404 | 409; body: { error: string; code: string } };

const refusal = (status: Refusal['status'], error: string, code: string): Refusal => ({ status, body: { error, code } });
const NOT_FOUND = refusal(404, 'Drive not found', 'NOT_FOUND');
const FORBIDDEN_ROLE = refusal(403, 'You need full access to this drive', 'FORBIDDEN_ROLE');
const FORBIDDEN_EDIT = refusal(403, 'You need edit access to this drive', 'FORBIDDEN_ROLE');
const invalid = (error = 'Invalid input') => refusal(400, error, 'VALIDATION_ERROR');
const CANNOT_HOLD = refusal(400, 'That person or chat can’t be given access to this drive', 'PRINCIPAL_CANNOT_HOLD_ACCESS');
const MEMBER_NOT_FOUND = refusal(404, 'Member not found', 'NOT_FOUND');
const PERSONAL_OWNER = refusal(409, 'The owner of a personal drive keeps full access to it', 'PERSONAL_DRIVE_OWNER');
const ALREADY_MEMBER = refusal(409, 'Already a member of this drive; change their role instead', 'ALREADY_MEMBER');
const ALREADY_LINKED = refusal(409, 'This chat is already linked to a drive', 'SPACE_ALREADY_LINKED');
const NOT_IN_CHAT = refusal(403, 'You can only link a chat you are in', 'SPACE_MEMBERSHIP_REQUIRED');
const OWNER_ONLY = refusal(403, 'Only the workspace owner can see or hand on a departed person’s drive', 'OWNER_ONLY');
const OWNERS_AND_ADMINS = refusal(403, 'Only workspace owners and admins can see drives without a manager', 'FORBIDDEN');
const NOT_FROZEN = refusal(409, 'Only a frozen personal drive can be handed on', 'DRIVE_NOT_FROZEN');

class Refused extends Error {
  constructor(readonly refusal: Refusal) { super(refusal.body.code); }
}

function answer(c: Context, r: Refusal) {
  return c.json(r.body, r.status);
}

/** A 500 that names the step to the caller; the log line is fixed text, never a request value. */
function failed(c: Context, what: string) {
  console.error('[drives] a drive request failed');
  return c.json({ error: `Failed to ${what}`, code: 'INTERNAL_ERROR' }, 500);
}

/** A PostgreSQL error code, through drizzle's wrapper. */
function pgCode(error: unknown): string | undefined {
  const own = (error as { code?: unknown } | null)?.code;
  if (typeof own === 'string') return own;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof cause === 'string' ? cause : undefined;
}

const roleSchema = z.enum(['full', 'edit', 'comment', 'view']);
const defaultRoleSchema = z.enum(['edit', 'comment', 'view']);
const nameSchema = z.string().trim().min(1).max(200);
const iconSchema = z.string().trim().min(1).max(64).nullable();

const createSchema = z.object({
  name: nameSchema,
  kind: z.enum(['open', 'private']),
  default_role: defaultRoleSchema.optional(),
  icon: iconSchema.optional(),
});
/** Kind can't change: an unknown key, `kind` included, is refused. */
const updateSchema = z.object({
  name: nameSchema.optional(),
  icon: iconSchema.optional(),
  default_role: defaultRoleSchema.optional(),
  agent_suggest_only: z.boolean().optional(),
  knowledge_default: z.boolean().optional(),
}).strict();
const addMemberSchema = z.object({
  principal_type: z.enum(['user', 'space']),
  principal_id: z.string().trim().min(1).max(200),
  role: roleSchema,
});
const memberRoleSchema = z.object({ role: roleSchema });
const linkSchema = z.object({ space_id: z.string().trim().min(1).max(200), role: roleSchema });
const handoverSchema = z.object({ user_id: z.string().trim().min(1).max(200) });

/**
 * The caller's role in their workspace: an active human membership, read
 * through `reader`. With `lock`, the membership row is share-locked until
 * commit, so the role holds for the change made under it.
 */
async function workspaceRole(reader: Reader, user: AuthUser, lock = false): Promise<string | null> {
  const query = reader.select({ role: orgMembers.role }).from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.user_id))
    .where(and(eq(orgMembers.org_id, user.org_id), eq(orgMembers.user_id, user.id), eq(orgMembers.is_active, true), eq(users.kind, 'human')))
    .limit(1);
  const [membership] = lock ? await query.for('share', { of: orgMembers }) : await query;
  return membership?.role ?? null;
}

/** Null when `access` allows `need`; else the refusal. `manage` is full, or the admin path. */
function refuse(access: DriveAccess | null, need: 'view' | 'edit' | 'full' | 'manage'): Refusal | null {
  if (!access) return NOT_FOUND;
  if (need === 'manage' && (access.role === 'full' || access.adminPath)) return null;
  if (access.role === null) return NOT_FOUND;
  if (need === 'view') return null;
  if (need === 'edit') return roleAtLeast(access.role, 'edit') ? null : FORBIDDEN_EDIT;
  return access.role === 'full' ? null : FORBIDDEN_ROLE;
}

async function locked(tx: Tx, user: AuthUser, driveId: string, need: 'view' | 'full' | 'manage'): Promise<DriveAccess> {
  const access = await driveAccess(tx, user, driveId, true);
  const refused = refuse(access, need);
  if (refused) throw new Refused(refused);
  return access!;
}

/** One snapshot for a privileged read's authorization and its data (header). */
const READ_SNAPSHOT: PgTransactionConfig = { isolationLevel: 'repeatable read', accessMode: 'read only' };

async function isPinned(userId: string, orgId: string, driveId: string, reader: Reader = db): Promise<boolean> {
  const [pin] = await reader.select({ id: docFavorites.id }).from(docFavorites).where(and(
    eq(docFavorites.org_id, orgId), eq(docFavorites.user_id, userId), eq(docFavorites.target_type, 'drive'), eq(docFavorites.target_id, driveId),
  )).limit(1);
  return Boolean(pin);
}

function driveShape(drive: DriveRow, role: DocRole | null, pinned: boolean) {
  return {
    id: drive.id,
    name: drive.name,
    icon: drive.icon,
    kind: drive.kind,
    system_key: drive.system_key,
    role,
    default_role: drive.default_role,
    frozen: drive.frozen_at !== null,
    pinned,
    admin_listed: false,
    agent_suggest_only: drive.agent_suggest_only,
    knowledge_default: drive.knowledge_default,
    created_at: drive.created_at,
    updated_at: drive.updated_at,
  };
}

function memberShape(row: DriveMemberRow, name: string | null = null) {
  return {
    id: row.id,
    principal_type: row.principal_type,
    principal_id: row.principal_id,
    role: row.role,
    is_link: row.is_link,
    name,
    added_by: row.added_by,
    created_at: row.created_at,
  };
}

const lowers = (from: DocRole | null, to: DocRole | null) =>
  from !== null && (to === null || DOC_ROLE_RANK[to] < DOC_ROLE_RANK[from]);

/** The access change a member row's principal makes on its drive. */
function memberChange(orgId: string, driveId: string, row: Pick<DriveMemberRow, 'principal_type' | 'principal_id'>): DocumentAccessChange {
  return row.principal_type === 'user'
    ? { orgId, driveId, userIds: [row.principal_id] }
    : { orgId, driveId, spaceId: row.principal_id };
}

/**
 * A grant's recipient, locked in its slot of the lock order (after the actor,
 * before the drive; header) and checked under the locks. A person:
 * their org_members row and (an agent's) employee row FOR SHARE, then
 * canHoldDocumentAccess (an active human member, guests included, or an
 * agent user with an active employee), so a deactivation or pause commits
 * first and is seen, or waits for the grant. A chat: its spaces row FOR
 * SHARE, then the caller's authority to share with it (canReadSpace), so an
 * archive (which ends unjoined reading) commits first and is seen, or waits.
 * Returns the refusal for a grant made or raised, or null; the caller throws
 * it after the drive's own checks.
 */
async function lockRecipientInTx(tx: Tx, user: AuthUser, principalType: 'user' | 'space', principalId: string): Promise<Refusal | null> {
  if (principalType === 'user') return await canHoldDocumentAccessLocked(tx, user.org_id, principalId) ? null : CANNOT_HOLD;
  await lockChatInTx(tx, user, principalId);
  return await canReadSpace(principalId, user.id, user.org_id, tx) ? null : CANNOT_HOLD;
}

/** A chat's spaces row FOR SHARE, in the recipient slot of the lock order (header). */
async function lockChatInTx(tx: Tx, user: AuthUser, spaceId: string): Promise<void> {
  await tx.select({ id: spaces.id }).from(spaces).where(and(eq(spaces.id, spaceId), eq(spaces.org_id, user.org_id))).for('share');
}

/**
 * The link rule's chat check: the caller's own seat in the chat, in this
 * workspace, share-locked until commit, so leaving the chat can't commit
 * between this check and the link.
 */
async function requireChatSeatLocked(tx: Tx, user: AuthUser, spaceId: string): Promise<void> {
  const [seat] = await tx.select({ id: spaceMembers.id }).from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.space_id))
    .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, user.id), eq(spaces.org_id, user.org_id)))
    .for('share', { of: spaceMembers });
  if (!seat) throw new Refused(NOT_IN_CHAT);
}

type AdminChange = {
  change: 'added' | 'role_changed' | 'removed';
  principal_type: string;
  principal_id: string;
  role: DocRole | null;
  previous_role: DocRole | null;
};

/**
 * The admin path's audit row, in the change's own transaction: the columns
 * logAuditEvent writes, but a failure rolls the change back with it.
 */
async function auditAdminChangeInTx(tx: Tx, user: AuthUser, drive: DriveRow, change: AdminChange): Promise<void> {
  const grant = (role: DocRole | null) => (role ? { principal_type: change.principal_type, principal_id: change.principal_id, role } : null);
  await tx.insert(auditLog).values({
    org_id: user.org_id,
    actor_type: 'user',
    actor_id: user.id,
    action: 'drive_member_changed_by_admin',
    entity_type: 'drive',
    entity_id: drive.id,
    before_state: grant(change.previous_role),
    after_state: grant(change.role),
    metadata: change,
  });
}

/** The active humans among `people` (a statement with a `user_id` column), apart from the actor. */
async function activeHumans(orgId: string, actorId: string, people: SQL): Promise<string[]> {
  const result = await db.execute(sql`SELECT DISTINCT told.user_id FROM (${people}) told
    JOIN ${orgMembers} told_membership ON told_membership.org_id = ${orgId} AND told_membership.user_id = told.user_id
      AND told_membership.is_active = true
    JOIN ${users} told_user ON told_user.id = told.user_id AND told_user.kind = 'human'
    WHERE told.user_id <> ${actorId}
    ORDER BY told.user_id`);
  return (result.rows as Array<{ user_id: string }>).map((row) => row.user_id);
}

/** The people a drive's members name, and the people in its member chats. */
function drivePeopleSql(orgId: string, driveId: string): SQL {
  return sql`SELECT told_member.principal_id AS user_id FROM ${driveMembers} told_member
      WHERE told_member.drive_id = ${driveId} AND told_member.principal_type = 'user'
    UNION
    SELECT told_seat.user_id FROM ${driveMembers} told_chat
      JOIN ${spaces} told_space ON told_space.id = told_chat.principal_id AND told_space.org_id = ${orgId}
      JOIN ${spaceMembers} told_seat ON told_seat.space_id = told_space.id
      WHERE told_chat.drive_id = ${driveId} AND told_chat.principal_type = 'space'`;
}

/** The people in the chat `spaceId` of `orgId`. */
function chatPeopleSql(orgId: string, spaceId: string): SQL {
  return sql`SELECT told_seat.user_id FROM ${spaceMembers} told_seat
    JOIN ${spaces} told_space ON told_space.id = told_seat.space_id AND told_space.org_id = ${orgId}
    WHERE told_seat.space_id = ${spaceId}`;
}

type Notice = { subtype: 'admin_change' | 'drive_member'; title: string; body: string };

/**
 * After commit: a `document_shared` notification to each recipient. Each one
 * is created on its own, so a failure for one person never stops the rest.
 * Never throws.
 */
async function tell(user: AuthUser, drive: DriveRow, recipients: readonly string[], notice: Notice): Promise<void> {
  const created: Array<{ id: string; org_id: string; user_id: string }> = [];
  for (const recipient of recipients) {
    try {
      const notification = await createNotificationIfAllowed({
        org_id: user.org_id,
        user_id: recipient,
        type: asStoredNotificationType('document_shared'),
        title: notice.title,
        body: notice.body,
        link: `/drive/${drive.id}`,
        metadata: notice.subtype === 'admin_change'
          ? { subtype: 'admin_change', drive_id: drive.id, actor_id: user.id }
          : { subtype: 'drive_member', drive_id: drive.id },
      });
      if (notification) created.push(notification);
    } catch {
      console.error('[drives] a drive notification could not be created');
    }
  }
  try {
    await emitVisibleNotifications(created);
  } catch {
    console.error('[drives] drive notifications could not be sent');
  }
}

const ADMIN_CHANGE_BODY: Record<AdminChange['change'], string> = {
  added: 'A workspace owner or admin added a member to this drive.',
  role_changed: 'A workspace owner or admin changed a member’s role on this drive.',
  removed: 'A workspace owner or admin removed a member from this drive.',
};

/**
 * After commit, for a change made through the admin path: every current
 * human member apart from the actor is sent the `admin_change` notice,
 * naming the admin who acted. That includes anyone the change just added,
 * who also gets their `drive_member` notice. Agents read their work through
 * MCP and aren't sent it.
 */
async function tellMembersOfAdminChange(user: AuthUser, drive: DriveRow, change: AdminChange['change']): Promise<void> {
  try {
    const recipients = await activeHumans(user.org_id, user.id, drivePeopleSql(user.org_id, drive.id));
    await tell(user, drive, recipients, { subtype: 'admin_change', title: `Drive members changed: ${drive.name}`, body: ADMIN_CHANGE_BODY[change] });
  } catch {
    console.error('[drives] telling members of an admin change failed');
  }
}

/**
 * After commit: the people a new grant reaches are told the drive was shared
 * with them, apart from the actor. A grant to a person tells that person,
 * human or agent, while they can hold access (canHoldDocumentAccess). A grant
 * to a chat, or a link, tells the humans in the chat.
 */
async function tellAdded(user: AuthUser, drive: DriveRow, principalType: 'user' | 'space', principalId: string): Promise<void> {
  try {
    if (principalType === 'user') {
      if (principalId === user.id || !(await canHoldDocumentAccess(principalId, user.org_id))) return;
      await tell(user, drive, [principalId], { subtype: 'drive_member', title: `Drive shared with you: ${drive.name}`, body: 'You can now open this drive.' });
      return;
    }
    const recipients = await activeHumans(user.org_id, user.id, chatPeopleSql(user.org_id, principalId));
    await tell(user, drive, recipients, {
      subtype: 'drive_member', title: `Drive shared with you: ${drive.name}`, body: 'This drive was shared with a chat you are in.',
    });
  } catch {
    console.error('[drives] telling new members failed');
  }
}

// GET /api/drives: the drives the caller can open, and those an owner or admin sees listed.
driveRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    await ensureWorkspaceDrive(user.org_id);
    const result = await db.execute(driveListQuery(user.id, user.org_id));
    const rows = result.rows as Array<{
      id: string; name: string; icon: string | null; kind: string; system_key: string | null; default_role: string | null;
      frozen: boolean; role: DocRole | null; admin_listed: boolean; pinned: boolean; is_mine: boolean; is_member: boolean;
      owner_user_id: string | null;
    }>;
    // owner_name: for another person's personal drive, the owner's name, or null when the people rule
    // (a guest sees only people they share a chat with) hides them. The owner's id is never returned.
    const ownerIds = [...new Set(rows.filter((row) => row.kind === 'personal' && row.is_mine !== true && row.owner_user_id).map((row) => row.owner_user_id!))];
    const ownerNames = new Map<string, string>();
    if (ownerIds.length > 0) {
      const visible = await visiblePersonIds(await peopleViewer(user.org_id, user.id));
      for (const owner of await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ownerIds))) {
        if (canSeePerson(visible, owner.id)) ownerNames.set(owner.id, owner.name);
      }
    }
    // is_member: a direct grant, or a seat in a chat of this workspace that holds one (never an admin's implicit access or an open drive's default).
    // is_mine: the caller's own personal drive.
    // notes_move_pending: a paused start doesn't move notes (F14); the drive pages say they move when the workspace resumes.
    // A start that isn't paused moves them before it listens, so it is false there.
    const notesMovePending = isPausedStart() ? await orgNeedsMove(user.org_id) : false;
    return c.json({
      notes_move_pending: notesMovePending,
      drives: rows.map((row) => ({
        id: row.id, name: row.name, icon: row.icon, kind: row.kind, system_key: row.system_key, role: row.role,
        default_role: row.default_role, frozen: row.frozen, pinned: row.pinned, admin_listed: row.role === null && row.admin_listed,
        is_member: row.is_member === true, is_mine: row.is_mine === true,
        owner_name: row.kind === 'personal' && row.is_mine !== true && row.owner_user_id ? (ownerNames.get(row.owner_user_id) ?? null) : null,
      })),
    });
  } catch {
    return failed(c, 'list drives');
  }
});

// GET /api/drives/without-manager (owners and admins): the private drives
// no active member holds full on in their own name. Registered before /:id.
driveRoutes.get('/without-manager', async (c) => {
  try {
    const user = c.get('user');
    const rows = await db.transaction(async (tx) => {
      const role = await workspaceRole(tx, user);
      if (role !== 'owner' && role !== 'admin') return null;
      const listed = await tx.execute(drivesWithoutManagerQuery(user.org_id));
      return listed.rows as Array<{ id: string; name: string; icon: string | null; created_at: Date | string; member_count: number }>;
    }, READ_SNAPSHOT);
    if (!rows) return answer(c, OWNERS_AND_ADMINS);
    return c.json({
      drives: rows.map((row) => ({
        id: row.id, name: row.name, icon: row.icon, member_count: Number(row.member_count), created_at: row.created_at,
      })),
    });
  } catch {
    return failed(c, 'list drives without a manager');
  }
});

// GET /api/drives/frozen (the workspace owner only): the frozen personal
// drives the owner can hand on, with the person who left each. Registered
// before /:id.
driveRoutes.get('/frozen', async (c) => {
  try {
    const user = c.get('user');
    const rows = await db.transaction(async (tx) => {
      if ((await workspaceRole(tx, user)) !== 'owner') return null;
      const frozen = await tx.execute(frozenDrivesQuery(user.org_id));
      return frozen.rows as Array<{ id: string; frozen_at: Date | string; former_owner_id: string; former_owner_name: string | null }>;
    }, READ_SNAPSHOT);
    if (!rows) return answer(c, OWNER_ONLY);
    return c.json({
      drives: rows.map((row) => ({
        id: row.id, frozen_at: row.frozen_at, former_owner: { id: row.former_owner_id, name: row.former_owner_name },
      })),
    });
  } catch {
    return failed(c, 'list frozen drives');
  }
});

// POST /api/drives/mine: the caller's own personal drive, made if it isn't
// there yet (idempotent). Every person has one, guests included. Registered before /:id.
driveRoutes.post('/mine', async (c) => {
  try {
    const user = c.get('user');
    const drive = await ensurePersonalDrive(user.org_id, user.id);
    return c.json({ drive: { ...driveShape(drive, 'full', false), is_mine: true, is_member: true } });
  } catch (error) {
    if (error instanceof PrincipalCannotHoldAccessError) {
      return answer(c, refusal(403, 'Not an active member of this workspace', 'ORG_MEMBERSHIP_INACTIVE'));
    }
    return failed(c, 'open your drive');
  }
});

// POST /api/drives: any full member creates an open or private drive and gets full access to it.
driveRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const parsed = createSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return answer(c, invalid());
    const { name, kind, icon } = parsed.data;
    if (kind === 'private' && parsed.data.default_role) return answer(c, invalid('A private drive has no default role'));
    const drive = await db.transaction(async (tx) => {
      // The membership is checked under its share lock, before the drive or
      // the owner row exists: a change to guest can't commit in between.
      const role = await lockActorInTx(tx, user);
      if (role === 'guest') throw new Refused(refusal(403, 'Guests can’t create drives', 'GUEST_FORBIDDEN'));
      if (!role || !(await canHoldDocumentAccess(user.id, user.org_id, tx))) {
        throw new Refused(refusal(403, 'Not an active member of this workspace', 'ORG_MEMBERSHIP_INACTIVE'));
      }
      const [created] = await tx.insert(drives).values({
        org_id: user.org_id, name, icon: icon ?? null, kind,
        default_role: kind === 'open' ? (parsed.data.default_role ?? 'edit') : null, created_by: user.id,
      }).returning();
      await tx.insert(driveMembers).values({
        org_id: user.org_id, drive_id: created!.id, principal_type: 'user', principal_id: user.id, role: 'full', added_by: user.id,
      });
      return created!;
    });
    return c.json({ drive: { ...driveShape(drive, 'full', false), is_member: true, is_mine: false } }, 201);
  } catch (error) {
    if (error instanceof Refused) return answer(c, error.refusal);
    return failed(c, 'create the drive');
  }
});

// GET /api/drives/:id (needs view).
driveRoutes.get('/:id', async (c) => {
  try {
    const user = c.get('user');
    const access = await driveAccess(db, user, c.req.param('id'));
    const refused = refuse(access, 'view');
    if (refused) return answer(c, refused);
    return c.json({ drive: driveShape(access!.drive, access!.role, await isPinned(user.id, user.org_id, access!.drive.id)) });
  } catch {
    return failed(c, 'load the drive');
  }
});

// PATCH /api/drives/:id { name?, icon?, default_role?, agent_suggest_only?, knowledge_default? } (needs full).
driveRoutes.patch('/:id', async (c) => {
  try {
    const user = c.get('user');
    const parsed = updateSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return answer(c, invalid());
    const patch = parsed.data;
    const outcome = await db.transaction(async (tx) => {
      await lockActorInTx(tx, user);
      const { drive, role } = await locked(tx, user, c.req.param('id'), 'full');
      if (patch.default_role !== undefined && drive.kind !== 'open') throw new Refused(invalid('Only an open drive has a default role'));
      const set: Partial<typeof drives.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.icon !== undefined) set.icon = patch.icon;
      if (patch.default_role !== undefined) set.default_role = patch.default_role;
      if (patch.agent_suggest_only !== undefined) set.agent_suggest_only = patch.agent_suggest_only;
      if (patch.knowledge_default !== undefined) set.knowledge_default = patch.knowledge_default;
      if (Object.keys(set).length === 0) return { drive, role, loss: null, roleRaised: false, knowledgeDocuments: null };
      const [updated] = await tx.update(drives).set({ ...set, updated_at: new Date() }).where(eq(drives.id, drive.id)).returning();
      const defaultChanged = patch.default_role !== undefined && patch.default_role !== drive.default_role;
      const lowered = defaultChanged && lowers(drive.default_role, patch.default_role!);
      const knowledgeChanged = patch.knowledge_default !== undefined && patch.knowledge_default !== drive.knowledge_default;
      const knowledgeDocuments = knowledgeChanged
        ? (await tx.select({ id: documents.id }).from(documents).where(and(
          eq(documents.org_id, user.org_id), eq(documents.drive_id, drive.id), eq(documents.is_deleted, false),
        ))).map((row) => row.id)
        : null;
      // A lower default role takes access away from every member it reaches.
      const loss = lowered ? await accessLossInTx(tx, { orgId: user.org_id, driveId: drive.id }) : null;
      return { drive: updated!, role, loss, roleRaised: defaultChanged && !lowered, knowledgeDocuments };
    });
    if (outcome.loss) await finishAccessLoss(outcome.loss.change, outcome.loss.result);
    else if (outcome.roleRaised) emitDocumentAccessChanged({ orgId: user.org_id, driveId: outcome.drive.id });
    if (outcome.knowledgeDocuments && outcome.knowledgeDocuments.length > 0) {
      emitDocumentEvent({ type: 'knowledge_changed', orgId: user.org_id, documentIds: outcome.knowledgeDocuments, actorId: user.id });
    }
    return c.json({ drive: driveShape(outcome.drive, outcome.role, await isPinned(user.id, user.org_id, outcome.drive.id)) });
  } catch (error) {
    if (error instanceof Refused) return answer(c, error.refusal);
    return failed(c, 'update the drive');
  }
});

// DELETE /api/drives/:id (needs full): a soft delete. The Workspace, Shared notes and personal drives stay.
driveRoutes.delete('/:id', async (c) => {
  try {
    const user = c.get('user');
    const outcome = await db.transaction(async (tx) => {
      await lockActorInTx(tx, user);
      const { drive } = await locked(tx, user, c.req.param('id'), 'full');
      if (drive.system_key) throw new Refused(refusal(409, 'This drive belongs to the workspace and can’t be deleted', 'SYSTEM_DRIVE'));
      // It holds every personal document: deleting it would trash them all at once.
      if (drive.kind === 'personal') throw new Refused(refusal(409, 'A personal drive can’t be deleted', 'PERSONAL_DRIVE'));
      const documentIds = (await tx.select({ id: documents.id }).from(documents).where(and(
        eq(documents.org_id, user.org_id), eq(documents.drive_id, drive.id), eq(documents.is_deleted, false),
      ))).map((row) => row.id);
      const now = new Date();
      await tx.update(drives).set({ is_deleted: true, deleted_at: now, updated_at: now }).where(eq(drives.id, drive.id));
      // A chat links one drive at most; free it for another.
      await tx.delete(driveMembers).where(and(eq(driveMembers.drive_id, drive.id), eq(driveMembers.is_link, true)));
      const loss = await accessLossInTx(tx, { orgId: user.org_id, driveId: drive.id, documentIds });
      return { drive, documentIds, loss };
    });
    await finishAccessLoss(outcome.loss.change, outcome.loss.result);
    emitDocumentEvent({ type: 'deleted', orgId: user.org_id, documentIds: outcome.documentIds, fromDriveId: outcome.drive.id, actorId: user.id });
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Refused) return answer(c, error.refusal);
    return failed(c, 'delete the drive');
  }
});

// GET /api/drives/:id/members (full, or the admin path).
driveRoutes.get('/:id/members', async (c) => {
  try {
    const user = c.get('user');
    // Authorization and every read below share one snapshot (READ_SNAPSHOT).
    const result = await db.transaction(async (tx) => {
      const access = await driveAccess(tx, user, c.req.param('id'));
      const refused = refuse(access, 'manage');
      if (refused) return { ok: false as const, refused };
      const drive = access!.drive;
      const rows = await tx.select().from(driveMembers).where(eq(driveMembers.drive_id, drive.id))
        .orderBy(asc(driveMembers.created_at), asc(driveMembers.id));
      // Names follow the people rule (a guest sees only people they share a
      // chat with) and the chat rule (a chat's name only for those who can read it).
      const names = new Map<string, string>();
      const userIds = rows.filter((row) => row.principal_type === 'user').map((row) => row.principal_id);
      if (userIds.length > 0) {
        const visible = await visiblePersonIds(await peopleViewer(user.org_id, user.id, tx), tx);
        for (const person of await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))) {
          if (canSeePerson(visible, person.id)) names.set(person.id, person.name);
        }
      }
      const spaceIds = rows.filter((row) => row.principal_type === 'space').map((row) => row.principal_id);
      if (spaceIds.length > 0) {
        const readable = await tx.select({ id: spaces.id, name: spaces.name }).from(spaces).where(and(
          inArray(spaces.id, spaceIds), eq(spaces.org_id, user.org_id),
          or(
            sql`EXISTS (SELECT 1 FROM ${spaceMembers} WHERE ${spaceMembers.space_id} = ${spaces.id} AND ${spaceMembers.user_id} = ${user.id})`,
            unjoinedPublicSpaceReadableSql(user.id),
          ),
        ));
        for (const chat of readable) names.set(chat.id, chat.name);
      }
      const changes = await tx.select({ id: auditLog.id, actor_id: auditLog.actor_id, metadata: auditLog.metadata, created_at: auditLog.created_at })
        .from(auditLog)
        .where(and(
          eq(auditLog.org_id, user.org_id), eq(auditLog.entity_type, 'drive'), eq(auditLog.entity_id, drive.id),
          eq(auditLog.action, 'drive_member_changed_by_admin'),
        ))
        .orderBy(desc(auditLog.created_at))
        .limit(20);
      return { ok: true as const, body: {
        members: rows.map((row) => memberShape(row, names.get(row.principal_id) ?? null)),
        admin_changes: changes.map((entry) => {
          const meta = (entry.metadata ?? {}) as Partial<AdminChange>;
          return {
            id: entry.id, actor_id: entry.actor_id, change: meta.change ?? null, principal_type: meta.principal_type ?? null,
            principal_id: meta.principal_id ?? null, role: meta.role ?? null, previous_role: meta.previous_role ?? null, created_at: entry.created_at,
          };
        }),
        admin_path: access!.adminPath,
      } };
    }, READ_SNAPSHOT);
    if (!result.ok) return answer(c, result.refused);
    return c.json(result.body);
  } catch {
    return failed(c, 'list the drive’s members');
  }
});

// POST /api/drives/:id/members { principal_type, principal_id, role } (full, or the admin path).
driveRoutes.post('/:id/members', async (c) => {
  try {
    const user = c.get('user');
    const parsed = addMemberSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return answer(c, invalid());
    const { principal_type: principalType, principal_id: principalId, role } = parsed.data;
    const outcome = await db.transaction(async (tx) => {
      await lockActorInTx(tx, user);
      const recipientRefusal = await lockRecipientInTx(tx, user, principalType, principalId);
      const access = await locked(tx, user, c.req.param('id'), 'manage');
      if (recipientRefusal) throw new Refused(recipientRefusal);
      const [existing] = await tx.select({ id: driveMembers.id }).from(driveMembers).where(and(
        eq(driveMembers.drive_id, access.drive.id), eq(driveMembers.principal_type, principalType), eq(driveMembers.principal_id, principalId),
      )).limit(1);
      if (existing) throw new Refused(ALREADY_MEMBER);
      const [member] = await tx.insert(driveMembers).values({
        org_id: user.org_id, drive_id: access.drive.id, principal_type: principalType, principal_id: principalId, role, added_by: user.id,
      }).returning();
      if (access.adminPath) {
        await auditAdminChangeInTx(tx, user, access.drive, { change: 'added', principal_type: principalType, principal_id: principalId, role, previous_role: null });
      }
      return { access, member: member! };
    });
    emitDocumentAccessChanged(memberChange(user.org_id, outcome.access.drive.id, outcome.member));
    await tellAdded(user, outcome.access.drive, principalType, principalId);
    if (outcome.access.adminPath) await tellMembersOfAdminChange(user, outcome.access.drive, 'added');
    return c.json({ member: memberShape(outcome.member) }, 201);
  } catch (error) {
    if (error instanceof Refused) return answer(c, error.refusal);
    // The principal triggers refuse anyone outside the workspace; the check above normally does first.
    if (pgCode(error) === '23503') return answer(c, CANNOT_HOLD);
    if (pgCode(error) === '23505') return answer(c, ALREADY_MEMBER);
    return failed(c, 'add the member');
  }
});

/**
 * The member row `memberId` of the drive, locked. A personal drive's owner
 * row can't be lowered or removed. A link row follows the link rule: only
 * full access changes it, never the admin path.
 */
async function lockedMember(tx: Tx, access: DriveAccess, memberId: string): Promise<DriveMemberRow> {
  const { drive } = access;
  const [row] = await tx.select().from(driveMembers)
    .where(and(eq(driveMembers.id, memberId), eq(driveMembers.drive_id, drive.id))).for('update');
  if (!row) throw new Refused(MEMBER_NOT_FOUND);
  if (drive.kind === 'personal' && row.principal_type === 'user' && row.principal_id === drive.owner_user_id) throw new Refused(PERSONAL_OWNER);
  if (row.is_link && access.role !== 'full') throw new Refused(FORBIDDEN_ROLE);
  return row;
}

// PATCH /api/drives/:id/members/:memberId { role } (full, or the admin path; a link row needs full).
driveRoutes.patch('/:id/members/:memberId', async (c) => {
  try {
    const user = c.get('user');
    const parsed = memberRoleSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return answer(c, invalid());
    const { role } = parsed.data;
    const outcome = await db.transaction(async (tx) => {
      // The lock order in the header: actor, recipient, drive; raising a link
      // row then share-locks the caller's chat seat. The row's principal is
      // read first to lock it in its slot; a member row's principal never
      // changes, and lockedMember re-reads the row under the drive lock.
      await lockActorInTx(tx, user);
      const [target] = await tx.select({ principal_type: driveMembers.principal_type, principal_id: driveMembers.principal_id })
        .from(driveMembers)
        .where(and(eq(driveMembers.id, c.req.param('memberId')), eq(driveMembers.drive_id, c.req.param('id')))).limit(1);
      const recipientRefusal = target ? await lockRecipientInTx(tx, user, target.principal_type, target.principal_id) : null;
      const access = await locked(tx, user, c.req.param('id'), 'manage');
      const row = await lockedMember(tx, access, c.req.param('memberId'));
      if (row.role === role) return { access, member: row, previous: row.role, loss: null };
      const lowered = lowers(row.role, role);
      if (!lowered) {
        // A stronger grant is a new grant: the recipient rule, and for a link the link rule.
        if (row.is_link) await requireChatSeatLocked(tx, user, row.principal_id);
        if (recipientRefusal) throw new Refused(recipientRefusal);
      }
      const [member] = await tx.update(driveMembers).set({ role, updated_at: new Date() }).where(eq(driveMembers.id, row.id)).returning();
      if (access.adminPath) {
        await auditAdminChangeInTx(tx, user, access.drive, {
          change: 'role_changed', principal_type: row.principal_type, principal_id: row.principal_id, role, previous_role: row.role,
        });
      }
      const loss = lowered ? await accessLossInTx(tx, memberChange(user.org_id, access.drive.id, row)) : null;
      return { access, member: member!, previous: row.role, loss };
    });
    if (outcome.previous !== role) {
      if (outcome.loss) await finishAccessLoss(outcome.loss.change, outcome.loss.result);
      else emitDocumentAccessChanged(memberChange(user.org_id, outcome.access.drive.id, outcome.member));
      if (outcome.access.adminPath) await tellMembersOfAdminChange(user, outcome.access.drive, 'role_changed');
    }
    return c.json({ member: memberShape(outcome.member) });
  } catch (error) {
    if (error instanceof Refused) return answer(c, error.refusal);
    return failed(c, 'change the member’s role');
  }
});

// DELETE /api/drives/:id/members/:memberId (full, or the admin path; a link row needs full).
driveRoutes.delete('/:id/members/:memberId', async (c) => {
  try {
    const user = c.get('user');
    const outcome = await db.transaction(async (tx) => {
      await lockActorInTx(tx, user);
      const access = await locked(tx, user, c.req.param('id'), 'manage');
      const row = await lockedMember(tx, access, c.req.param('memberId'));
      await tx.delete(driveMembers).where(eq(driveMembers.id, row.id));
      if (access.adminPath) {
        await auditAdminChangeInTx(tx, user, access.drive, {
          change: 'removed', principal_type: row.principal_type, principal_id: row.principal_id, role: null, previous_role: row.role,
        });
      }
      return { access, loss: await accessLossInTx(tx, memberChange(user.org_id, access.drive.id, row)) };
    });
    await finishAccessLoss(outcome.loss.change, outcome.loss.result);
    if (outcome.access.adminPath) await tellMembersOfAdminChange(user, outcome.access.drive, 'removed');
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Refused) return answer(c, error.refusal);
    return failed(c, 'remove the member');
  }
});

// POST /api/drives/:id/link-space { space_id, role }: the chat's own drive. Needs full and membership of the chat.
driveRoutes.post('/:id/link-space', async (c) => {
  try {
    const user = c.get('user');
    const parsed = linkSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return answer(c, invalid());
    const { space_id: spaceId, role } = parsed.data;
    const outcome = await db.transaction(async (tx) => {
      // The lock order in the header: actor, the chat (recipient), drive,
      // then the caller's seat in the chat, the link's authority check.
      await lockActorInTx(tx, user);
      await lockChatInTx(tx, user, spaceId);
      const access = await locked(tx, user, c.req.param('id'), 'full');
      await requireChatSeatLocked(tx, user, spaceId);
      const [linked] = await tx.select({ id: driveMembers.id }).from(driveMembers).where(and(
        eq(driveMembers.org_id, user.org_id), eq(driveMembers.principal_type, 'space'), eq(driveMembers.principal_id, spaceId),
        eq(driveMembers.is_link, true),
      )).limit(1);
      if (linked) throw new Refused(ALREADY_LINKED);
      // A chat that is already a plain member of this drive becomes its link.
      const [plain] = await tx.select().from(driveMembers).where(and(
        eq(driveMembers.drive_id, access.drive.id), eq(driveMembers.principal_type, 'space'), eq(driveMembers.principal_id, spaceId),
      )).for('update');
      const change: DocumentAccessChange = { orgId: user.org_id, driveId: access.drive.id, spaceId };
      if (plain) {
        const [member] = await tx.update(driveMembers).set({ is_link: true, role, updated_at: new Date() }).where(eq(driveMembers.id, plain.id)).returning();
        return { access, member: member!, change, loss: lowers(plain.role, role) ? await accessLossInTx(tx, change) : null };
      }
      const [member] = await tx.insert(driveMembers).values({
        org_id: user.org_id, drive_id: access.drive.id, principal_type: 'space', principal_id: spaceId, role, is_link: true, added_by: user.id,
      }).returning();
      return { access, member: member!, change, loss: null };
    });
    if (outcome.loss) await finishAccessLoss(outcome.loss.change, outcome.loss.result);
    else emitDocumentAccessChanged(outcome.change);
    await tellAdded(user, outcome.access.drive, 'space', spaceId);
    return c.json({ member: memberShape(outcome.member) }, 201);
  } catch (error) {
    if (error instanceof Refused) return answer(c, error.refusal);
    // Two links racing for one chat: the partial unique index lets one in.
    if (pgCode(error) === '23505') return answer(c, ALREADY_LINKED);
    return failed(c, 'link the chat');
  }
});

// DELETE /api/drives/:id/link-space/:spaceId (needs full).
driveRoutes.delete('/:id/link-space/:spaceId', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('spaceId');
    const outcome = await db.transaction(async (tx) => {
      await lockActorInTx(tx, user);
      const access = await locked(tx, user, c.req.param('id'), 'full');
      const removed = await tx.delete(driveMembers).where(and(
        eq(driveMembers.drive_id, access.drive.id), eq(driveMembers.principal_type, 'space'), eq(driveMembers.principal_id, spaceId),
        eq(driveMembers.is_link, true),
      )).returning({ id: driveMembers.id });
      if (removed.length === 0) throw new Refused(refusal(404, 'This chat isn’t linked to the drive', 'NOT_FOUND'));
      return { loss: await accessLossInTx(tx, { orgId: user.org_id, driveId: access.drive.id, spaceId }) };
    });
    await finishAccessLoss(outcome.loss.change, outcome.loss.result);
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Refused) return answer(c, error.refusal);
    return failed(c, 'unlink the chat');
  }
});

// POST /api/drives/:id/handover { user_id } (the workspace owner only): a
// frozen personal drive becomes a private drive held by `user_id` at full
// (lib/drives.ts handOverPersonalDriveInTx), and the holder is told. The
// owner role is checked first, so nobody else learns whether a drive exists.
// The answer carries the caller's own role on the drive and their pin.
//
// Lock order: the owner's org_members row FOR SHARE; the holder's
// org_members row, then (an agent's) employee row, FOR SHARE; the frozen
// drive FOR UPDATE; then its drive_members rows and the audit row. A removal
// with a replacement (routes/members.ts reassignMemberOwnership) takes its
// member's room-access lock, users and org_members rows FOR UPDATE, then
// their unfrozen personal drive FOR UPDATE, then the replacement's
// org_members and employee rows FOR SHARE. The two never wait on each other
// in turn: they never lock the same drive (this one only a frozen drive, a
// removal only an unfrozen one, and a removal's freeze skips frozen drives);
// both take holders' rows only FOR SHARE, which don't conflict; and when the
// holder here is someone being removed, the removal holds their row first
// and waits for nothing this route holds.
driveRoutes.post('/:id/handover', async (c) => {
  try {
    const user = c.get('user');
    const parsed = handoverSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return answer(c, invalid());
    const outcome = await db.transaction(async (tx) => {
      if ((await workspaceRole(tx, user, true)) !== 'owner') throw new Refused(OWNER_ONLY);
      const holderEligible = await canHoldDocumentAccessLocked(tx, user.org_id, parsed.data.user_id);
      const [drive] = await tx.select().from(drives)
        .where(and(eq(drives.id, c.req.param('id')), eq(drives.org_id, user.org_id), eq(drives.is_deleted, false)))
        .for('update');
      if (!drive) throw new Refused(NOT_FOUND);
      if (drive.kind !== 'personal' || drive.frozen_at === null) throw new Refused(NOT_FROZEN);
      if (!holderEligible) throw new Refused(CANNOT_HOLD);
      const handed = await handOverPersonalDriveInTx(tx, drive, parsed.data.user_id, user.id, 'handover');
      // The answer is read here, so nothing after the commit can fail it.
      const role = await driveRoleFor(user.id, user.org_id, drive.id, tx);
      return { ...handed, role, pinned: await isPinned(user.id, user.org_id, drive.id, tx) };
    });
    // Committed: the access change and the holder's notice, never failing the answer.
    try {
      await finishDriveHandover(outcome.handover);
    } catch {
      console.error('[drives] finishing a handover after commit failed');
    }
    return c.json({ drive: driveShape(outcome.drive, outcome.role, outcome.pinned) });
  } catch (error) {
    if (error instanceof Refused) return answer(c, error.refusal);
    if (error instanceof PrincipalCannotHoldAccessError) return answer(c, CANNOT_HOLD);
    return failed(c, 'hand the drive on');
  }
});

// GET /api/drives/:id/tree (needs view): the drive's folders, and the
// documents in it the caller can see (lib/documents.ts driveTree). The role
// and the lists come from one snapshot (READ_SNAPSHOT).
driveRoutes.get('/:id/tree', async (c) => {
  try {
    const user = c.get('user');
    const result = await db.transaction(async (tx) => {
      const access = await driveAccess(tx, user, c.req.param('id'));
      const refused = refuse(access, 'view');
      if (refused) return { ok: false as const, refused };
      return { ok: true as const, body: await driveTree(tx, user.id, user.org_id, access!.drive.id) };
    }, READ_SNAPSHOT);
    if (!result.ok) return answer(c, result.refused);
    return c.json(result.body);
  } catch {
    return failed(c, 'load the drive’s documents');
  }
});

// GET /api/drives/:id/trash (needs edit): documents deleted in the last 30
// days (lib/documents.ts driveTrash). The access check doesn't see deleted
// documents, so the drive role is the gate. The role and the list come from
// one snapshot (READ_SNAPSHOT).
driveRoutes.get('/:id/trash', async (c) => {
  try {
    const user = c.get('user');
    const result = await db.transaction(async (tx) => {
      const access = await driveAccess(tx, user, c.req.param('id'));
      const refused = refuse(access, 'edit');
      if (refused) return { ok: false as const, refused };
      return { ok: true as const, items: await driveTrash(tx, user.org_id, access!.drive.id) };
    }, READ_SNAPSHOT);
    if (!result.ok) return answer(c, result.refused);
    return c.json({ items: result.items });
  } catch {
    return failed(c, 'load the drive’s trash');
  }
});

// POST /api/drives/:id/pin (needs view): a per-person favourite.
driveRoutes.post('/:id/pin', async (c) => {
  try {
    const user = c.get('user');
    const access = await driveAccess(db, user, c.req.param('id'));
    const refused = refuse(access, 'view');
    if (refused) return answer(c, refused);
    await db.insert(docFavorites)
      .values({ org_id: user.org_id, user_id: user.id, target_type: 'drive', target_id: access!.drive.id })
      .onConflictDoNothing({ target: [docFavorites.user_id, docFavorites.target_type, docFavorites.target_id] });
    return c.json({ pinned: true });
  } catch {
    return failed(c, 'pin the drive');
  }
});

// DELETE /api/drives/:id/pin: removes only the caller's own favourite.
driveRoutes.delete('/:id/pin', async (c) => {
  try {
    const user = c.get('user');
    await db.delete(docFavorites).where(and(
      eq(docFavorites.org_id, user.org_id), eq(docFavorites.user_id, user.id), eq(docFavorites.target_type, 'drive'),
      eq(docFavorites.target_id, c.req.param('id')),
    ));
    return c.json({ pinned: false });
  } catch {
    return failed(c, 'unpin the drive');
  }
});
