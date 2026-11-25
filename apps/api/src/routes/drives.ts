// Drives and their members (spec 5.1 and 5.2; plan Task F4).
//
// Every route reads the caller's role with driveRoleFor (lib/document-access.ts)
// for the drive's workspace, which must be the caller's: a drive they can't
// see, in this workspace or another, is a 404, never a 403.
// - Reading a drive needs view. Settings and deleting it need full; the
//   Workspace, Shared notes and personal drives can't be deleted.
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
//   (subtype `drive_member`) to the person, or to each human in the chat,
//   apart from the actor. Notifications naming a drive stay listed only while
//   the reader can view it (lib/native-mention-visibility.ts).
//
// Access changes (consult rule C3): removing or lowering a member, removing or
// lowering a link, lowering a default role and deleting a drive run
// applyAccessLossInTx in their transaction and finishAccessLoss after it.
// Changes that only add access emit emitDocumentAccessChanged after commit.
// Each mutation locks the drive row first and checks the caller's role under
// that lock, so changes to one drive run one after another, and every check
// inside it reads through the same transaction.
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
import { DOC_ROLE_RANK, adminListedDriveCondition, canHoldDocumentAccess, driveRoleFor } from '../lib/document-access.js';
import { accessLossInTx, finishAccessLoss } from '../lib/document-access-change.js';
import { emitDocumentAccessChanged, type DocumentAccessChange } from '../lib/document-access-events.js';
import { emitDocumentEvent } from '../lib/document-events.js';
import { driveListQuery, ensureWorkspaceDrive } from '../lib/drives.js';
import { emitVisibleNotifications } from '../lib/notification-delivery.js';
import { createNotificationIfAllowed } from '../lib/notification-policy.js';
import { asStoredNotificationType } from '../lib/notification-types.js';
import { canSeePerson, peopleViewer, visiblePersonIds } from '../lib/people-visibility.js';
import { canReadSpace, unjoinedPublicSpaceReadableSql } from '../lib/space-membership.js';
import type { AuthUser } from '../middleware/auth.js';

export const driveRoutes = new Hono();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<typeof db, 'select' | 'execute'>;
type Refusal = { status: 400 | 403 | 404 | 409; body: { error: string; code: string } };

const refusal = (status: Refusal['status'], error: string, code: string): Refusal => ({ status, body: { error, code } });
const NOT_FOUND = refusal(404, 'Drive not found', 'NOT_FOUND');
const FORBIDDEN_ROLE = refusal(403, 'You need full access to this drive', 'FORBIDDEN_ROLE');
const invalid = (error = 'Invalid input') => refusal(400, error, 'VALIDATION_ERROR');
const CANNOT_HOLD = refusal(400, 'That person or chat can’t be given access to this drive', 'PRINCIPAL_CANNOT_HOLD_ACCESS');
const MEMBER_NOT_FOUND = refusal(404, 'Member not found', 'NOT_FOUND');
const PERSONAL_OWNER = refusal(409, 'The owner of a personal drive keeps full access to it', 'PERSONAL_DRIVE_OWNER');
const ALREADY_MEMBER = refusal(409, 'Already a member of this drive; change their role instead', 'ALREADY_MEMBER');
const ALREADY_LINKED = refusal(409, 'This chat is already linked to a drive', 'SPACE_ALREADY_LINKED');
const NOT_IN_CHAT = refusal(403, 'You can only link a chat you are in', 'SPACE_MEMBERSHIP_REQUIRED');

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

const bodyOf = (c: Context) => c.req.json().catch(() => ({}));

/** What the caller holds on a live drive of their workspace. */
type DriveAccess = { drive: DriveRow; role: DocRole | null; adminPath: boolean };

/**
 * The drive and the caller's role on it, or null when it doesn't exist, is
 * deleted or belongs to another workspace. `adminPath` is set for an owner
 * or admin, without full access, on a private drive they see listed. With
 * `lock`, the drive row is locked first (FOR UPDATE), so the role is read
 * after any change to the drive committed before.
 */
async function driveAccess(reader: Reader, user: AuthUser, driveId: string, lock = false): Promise<DriveAccess | null> {
  const query = reader.select().from(drives)
    .where(and(eq(drives.id, driveId), eq(drives.org_id, user.org_id), eq(drives.is_deleted, false)));
  const [drive] = lock ? await query.for('update') : await query;
  if (!drive) return null;
  const role = await driveRoleFor(user.id, user.org_id, drive.id, reader);
  let adminPath = false;
  if (role !== 'full' && drive.kind === 'private') {
    const [listed] = await reader.select({ id: drives.id }).from(drives)
      .where(and(eq(drives.id, drive.id), adminListedDriveCondition(user.id, user.org_id))).limit(1);
    adminPath = Boolean(listed);
  }
  return { drive, role, adminPath };
}

/** Null when `access` allows `need`; else the refusal. `manage` is full, or the admin path. */
function refuse(access: DriveAccess | null, need: 'view' | 'full' | 'manage'): Refusal | null {
  if (!access) return NOT_FOUND;
  if (need === 'manage' && (access.role === 'full' || access.adminPath)) return null;
  if (access.role === null) return NOT_FOUND;
  if (need === 'view') return null;
  return access.role === 'full' ? null : FORBIDDEN_ROLE;
}

async function locked(tx: Tx, user: AuthUser, driveId: string, need: 'view' | 'full' | 'manage'): Promise<DriveAccess> {
  const access = await driveAccess(tx, user, driveId, true);
  const refused = refuse(access, need);
  if (refused) throw new Refused(refused);
  return access!;
}

async function isPinned(userId: string, orgId: string, driveId: string): Promise<boolean> {
  const [pin] = await db.select({ id: docFavorites.id }).from(docFavorites).where(and(
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
 * Refuses a grant, made or raised, to someone who could never hold access: a
 * person must be an active human member (guests included) or an agent user
 * with an active employee; a chat must be one of this workspace's that the
 * caller can read. Reads through `tx`.
 */
async function principalRefusal(tx: Tx, user: AuthUser, principalType: 'user' | 'space', principalId: string): Promise<Refusal | null> {
  if (principalType === 'user') return await canHoldDocumentAccess(principalId, user.org_id, tx) ? null : CANNOT_HOLD;
  return await canReadSpace(principalId, user.id, user.org_id, tx) ? null : CANNOT_HOLD;
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

/** The person a principal names, or the people in the chat it names. */
function principalPeopleSql(orgId: string, principalType: 'user' | 'space', principalId: string): SQL {
  return principalType === 'user'
    ? sql`SELECT ${principalId}::text AS user_id`
    : sql`SELECT told_seat.user_id FROM ${spaceMembers} told_seat
        JOIN ${spaces} told_space ON told_space.id = told_seat.space_id AND told_space.org_id = ${orgId}
        WHERE told_seat.space_id = ${principalId}`;
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
 * human member apart from the actor (and anyone `alreadyTold`) is sent the
 * `admin_change` notice. Agents read their work through MCP and aren't sent it.
 */
async function tellMembersOfAdminChange(user: AuthUser, drive: DriveRow, change: AdminChange['change'], alreadyTold: readonly string[] = []): Promise<void> {
  try {
    const recipients = (await activeHumans(user.org_id, user.id, drivePeopleSql(user.org_id, drive.id)))
      .filter((id) => !alreadyTold.includes(id));
    await tell(user, drive, recipients, { subtype: 'admin_change', title: `Drive members changed: ${drive.name}`, body: ADMIN_CHANGE_BODY[change] });
  } catch {
    console.error('[drives] telling members of an admin change failed');
  }
}

/**
 * After commit: the person a new grant names, or each human in the chat it
 * names, apart from the actor, is told the drive was shared with them.
 * Returns who was told.
 */
async function tellAdded(user: AuthUser, drive: DriveRow, principalType: 'user' | 'space', principalId: string): Promise<string[]> {
  try {
    const recipients = await activeHumans(user.org_id, user.id, principalPeopleSql(user.org_id, principalType, principalId));
    await tell(user, drive, recipients, {
      subtype: 'drive_member',
      title: `Drive shared with you: ${drive.name}`,
      body: principalType === 'user' ? 'You can now open this drive.' : 'This drive was shared with a chat you are in.',
    });
    return recipients;
  } catch {
    console.error('[drives] telling new members failed');
    return [];
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
      frozen: boolean; role: DocRole | null; admin_listed: boolean; pinned: boolean;
    }>;
    return c.json({
      drives: rows.map((row) => ({
        id: row.id, name: row.name, icon: row.icon, kind: row.kind, system_key: row.system_key, role: row.role,
        default_role: row.default_role, frozen: row.frozen, pinned: row.pinned, admin_listed: row.role === null && row.admin_listed,
      })),
    });
  } catch {
    return failed(c, 'list drives');
  }
});

// POST /api/drives: any full member creates an open or private drive and gets full access to it.
driveRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const parsed = createSchema.safeParse(await bodyOf(c));
    if (!parsed.success) return answer(c, invalid());
    const { name, kind, icon } = parsed.data;
    if (kind === 'private' && parsed.data.default_role) return answer(c, invalid('A private drive has no default role'));
    const [membership] = await db.select({ role: orgMembers.role }).from(orgMembers)
      .where(and(eq(orgMembers.org_id, user.org_id), eq(orgMembers.user_id, user.id), eq(orgMembers.is_active, true))).limit(1);
    if (membership?.role === 'guest') return c.json({ error: 'Guests can’t create drives', code: 'GUEST_FORBIDDEN' }, 403);
    if (!membership || !(await canHoldDocumentAccess(user.id, user.org_id))) {
      return c.json({ error: 'Not an active member of this workspace', code: 'ORG_MEMBERSHIP_INACTIVE' }, 403);
    }
    const drive = await db.transaction(async (tx) => {
      const [created] = await tx.insert(drives).values({
        org_id: user.org_id, name, icon: icon ?? null, kind,
        default_role: kind === 'open' ? (parsed.data.default_role ?? 'edit') : null, created_by: user.id,
      }).returning();
      await tx.insert(driveMembers).values({
        org_id: user.org_id, drive_id: created!.id, principal_type: 'user', principal_id: user.id, role: 'full', added_by: user.id,
      });
      return created!;
    });
    return c.json({ drive: driveShape(drive, 'full', false) }, 201);
  } catch {
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
    const parsed = updateSchema.safeParse(await bodyOf(c));
    if (!parsed.success) return answer(c, invalid());
    const patch = parsed.data;
    const outcome = await db.transaction(async (tx) => {
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
    const access = await driveAccess(db, user, c.req.param('id'));
    const refused = refuse(access, 'manage');
    if (refused) return answer(c, refused);
    const drive = access!.drive;
    const rows = await db.select().from(driveMembers).where(eq(driveMembers.drive_id, drive.id))
      .orderBy(asc(driveMembers.created_at), asc(driveMembers.id));
    // Names follow the people rule (a guest sees only people they share a
    // chat with) and the chat rule (a chat's name only for those who can read it).
    const names = new Map<string, string>();
    const userIds = rows.filter((row) => row.principal_type === 'user').map((row) => row.principal_id);
    if (userIds.length > 0) {
      const visible = await visiblePersonIds(await peopleViewer(user.org_id, user.id));
      for (const person of await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))) {
        if (canSeePerson(visible, person.id)) names.set(person.id, person.name);
      }
    }
    const spaceIds = rows.filter((row) => row.principal_type === 'space').map((row) => row.principal_id);
    if (spaceIds.length > 0) {
      const readable = await db.select({ id: spaces.id, name: spaces.name }).from(spaces).where(and(
        inArray(spaces.id, spaceIds), eq(spaces.org_id, user.org_id),
        or(
          sql`EXISTS (SELECT 1 FROM ${spaceMembers} WHERE ${spaceMembers.space_id} = ${spaces.id} AND ${spaceMembers.user_id} = ${user.id})`,
          unjoinedPublicSpaceReadableSql(user.id),
        ),
      ));
      for (const chat of readable) names.set(chat.id, chat.name);
    }
    const changes = await db.select({ id: auditLog.id, actor_id: auditLog.actor_id, metadata: auditLog.metadata, created_at: auditLog.created_at })
      .from(auditLog)
      .where(and(
        eq(auditLog.org_id, user.org_id), eq(auditLog.entity_type, 'drive'), eq(auditLog.entity_id, drive.id),
        eq(auditLog.action, 'drive_member_changed_by_admin'),
      ))
      .orderBy(desc(auditLog.created_at))
      .limit(20);
    return c.json({
      members: rows.map((row) => memberShape(row, names.get(row.principal_id) ?? null)),
      admin_changes: changes.map((entry) => {
        const meta = (entry.metadata ?? {}) as Partial<AdminChange>;
        return {
          id: entry.id, actor_id: entry.actor_id, change: meta.change ?? null, principal_type: meta.principal_type ?? null,
          principal_id: meta.principal_id ?? null, role: meta.role ?? null, previous_role: meta.previous_role ?? null, created_at: entry.created_at,
        };
      }),
      admin_path: access!.adminPath,
    });
  } catch {
    return failed(c, 'list the drive’s members');
  }
});

// POST /api/drives/:id/members { principal_type, principal_id, role } (full, or the admin path).
driveRoutes.post('/:id/members', async (c) => {
  try {
    const user = c.get('user');
    const parsed = addMemberSchema.safeParse(await bodyOf(c));
    if (!parsed.success) return answer(c, invalid());
    const { principal_type: principalType, principal_id: principalId, role } = parsed.data;
    const outcome = await db.transaction(async (tx) => {
      const access = await locked(tx, user, c.req.param('id'), 'manage');
      const refused = await principalRefusal(tx, user, principalType, principalId);
      if (refused) throw new Refused(refused);
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
    const told = await tellAdded(user, outcome.access.drive, principalType, principalId);
    if (outcome.access.adminPath) await tellMembersOfAdminChange(user, outcome.access.drive, 'added', told);
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
    const parsed = memberRoleSchema.safeParse(await bodyOf(c));
    if (!parsed.success) return answer(c, invalid());
    const { role } = parsed.data;
    const outcome = await db.transaction(async (tx) => {
      const access = await locked(tx, user, c.req.param('id'), 'manage');
      const row = await lockedMember(tx, access, c.req.param('memberId'));
      if (row.role === role) return { access, member: row, previous: row.role, loss: null };
      const lowered = lowers(row.role, role);
      if (!lowered) {
        // A stronger grant is a new grant: the principal rule, and for a link the link rule.
        if (row.is_link) await requireChatSeatLocked(tx, user, row.principal_id);
        const refused = await principalRefusal(tx, user, row.principal_type, row.principal_id);
        if (refused) throw new Refused(refused);
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
    const parsed = linkSchema.safeParse(await bodyOf(c));
    if (!parsed.success) return answer(c, invalid());
    const { space_id: spaceId, role } = parsed.data;
    const outcome = await db.transaction(async (tx) => {
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
