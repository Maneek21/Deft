// Drives and their members (spec 5.1 and 5.2; plan Task F4).
//
// Every route reads the caller's role with driveRoleFor (lib/document-access.ts)
// for the drive's workspace, which must be the caller's: a drive they can't
// see, in this workspace or another, is a 404, never a 403.
// - Reading a drive needs view. Settings, deleting it and linking a chat need
//   full; linking also needs membership of the chat.
// - Members: full, or the admin path. An owner or admin who isn't a full
//   member of a private drive sees it listed (adminListedDriveCondition) and
//   may manage its members, adding themselves included, but can't open it
//   until they are a member. Each such change is written to the audit log,
//   every current member is sent a `document_shared` notification with the
//   `admin_change` subtype, and GET /:id/members returns the recent ones as
//   `admin_changes`, which the members panel shows as a notice.
// - A grant can't name someone who could never hold access
//   (canHoldDocumentAccess), nor a chat that isn't one of this workspace's
//   the caller can read: 400 PRINCIPAL_CANNOT_HOLD_ACCESS.
//
// Access changes (consult rule C3): removing or lowering a member, removing a
// link, lowering a default role and deleting a drive run applyAccessLossInTx
// in their transaction and finishAccessLoss after it. Changes that only add
// access emit emitDocumentAccessChanged after commit. Each mutation locks the
// drive row first and checks the caller's role under that lock, so changes
// to one drive run one after another.
//
// Live events follow rule C4 (lib/document-access-events.ts). Deleting a
// drive, or changing its Knowledge default, also raises a lifecycle event for
// each of its documents, so Knowledge withdraws or re-learns them (H4).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { docFavorites, documents, driveMembers, drives, type DocRole, type DriveMemberRow, type DriveRow } from '@deft/db/documents';
import { auditLog, orgMembers, spaceMembers, spaces, users } from '@deft/db/schema';
import { db } from '../lib/db.js';
import { logAuditEvent } from '../lib/audit.js';
import { DOC_ROLE_RANK, adminListedDriveCondition, canHoldDocumentAccess, driveRoleFor } from '../lib/document-access.js';
import { applyAccessLossInTx, finishAccessLoss, type PendingAccessLoss } from '../lib/document-access-change.js';
import {
  documentEventAudience, emitDocumentAccessChanged, emitDocumentUpdated, sendDocumentEvent, type DocumentAccessChange,
} from '../lib/document-access-events.js';
import { emitDocumentEvent } from '../lib/document-events.js';
import { driveListQuery, ensureWorkspaceDrive } from '../lib/drives.js';
import { emitVisibleNotifications } from '../lib/notification-delivery.js';
import { createNotificationIfAllowed } from '../lib/notification-policy.js';
import { asStoredNotificationType } from '../lib/notification-types.js';
import { canSeePerson, peopleViewer, visiblePersonIds } from '../lib/people-visibility.js';
import { canReadSpace, requireSpaceMembership, unjoinedPublicSpaceReadableSql } from '../lib/space-membership.js';
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

class Refused extends Error {
  constructor(readonly refusal: Refusal) { super(refusal.body.code); }
}

function answer(c: Context, r: Refusal) {
  return c.json(r.body, r.status);
}

function failed(c: Context, what: string) {
  console.error(`[drives] ${what} failed`);
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

/** Applies `change` as a loss in `tx`, to finish after commit. */
async function lossInTx(tx: Tx, change: DocumentAccessChange): Promise<PendingAccessLoss> {
  return { change, result: await applyAccessLossInTx(tx, change) };
}

/**
 * Refuses a grant to someone who could never hold access: a person must be
 * an active human member (guests included) or an agent user with an active
 * employee; a chat must be one of this workspace's that the caller can read.
 */
async function principalRefusal(tx: Tx, user: AuthUser, principalType: 'user' | 'space', principalId: string): Promise<Refusal | null> {
  if (principalType === 'user') return await canHoldDocumentAccess(principalId, user.org_id, tx) ? null : CANNOT_HOLD;
  const [chat] = await tx.select({ id: spaces.id }).from(spaces)
    .where(and(eq(spaces.id, principalId), eq(spaces.org_id, user.org_id))).limit(1);
  if (!chat || !(await canReadSpace(principalId, user.id, user.org_id))) return CANNOT_HOLD;
  return null;
}

type AdminChange = {
  change: 'added' | 'role_changed' | 'removed';
  principal_type: string;
  principal_id: string;
  role: DocRole | null;
  previous_role: DocRole | null;
};

const ADMIN_CHANGE_BODY: Record<AdminChange['change'], string> = {
  added: 'A workspace owner or admin added a member to this drive.',
  role_changed: 'A workspace owner or admin changed a member’s role on this drive.',
  removed: 'A workspace owner or admin removed a member from this drive.',
};

/**
 * After commit, for a change made through the admin path: the audit entry,
 * and a `document_shared` notification (subtype `admin_change`) to every
 * current member: the people the drive names and the people in its member
 * chats who are active humans, apart from the actor. Never throws.
 */
async function recordAdminChange(user: AuthUser, drive: DriveRow, change: AdminChange): Promise<void> {
  await logAuditEvent({
    orgId: user.org_id, actorType: 'user', actorId: user.id, action: 'drive_member_changed_by_admin',
    entityType: 'drive', entityId: drive.id,
    beforeState: change.previous_role ? { principal_type: change.principal_type, principal_id: change.principal_id, role: change.previous_role } : null,
    afterState: change.role ? { principal_type: change.principal_type, principal_id: change.principal_id, role: change.role } : null,
    metadata: change,
  });
  try {
    const result = await db.execute(sql`SELECT DISTINCT told.user_id
      FROM (
        SELECT told_member.principal_id AS user_id FROM ${driveMembers} told_member
          WHERE told_member.drive_id = ${drive.id} AND told_member.principal_type = 'user'
        UNION
        SELECT told_seat.user_id FROM ${driveMembers} told_chat
          JOIN ${spaces} told_space ON told_space.id = told_chat.principal_id AND told_space.org_id = ${user.org_id}
          JOIN ${spaceMembers} told_seat ON told_seat.space_id = told_space.id
          WHERE told_chat.drive_id = ${drive.id} AND told_chat.principal_type = 'space'
      ) told
      JOIN org_members told_membership ON told_membership.org_id = ${user.org_id} AND told_membership.user_id = told.user_id
        AND told_membership.is_active = true
      JOIN ${users} told_user ON told_user.id = told.user_id AND told_user.kind = 'human'
      WHERE told.user_id <> ${user.id}`);
    const created: Array<{ id: string; org_id: string; user_id: string }> = [];
    for (const { user_id: recipient } of result.rows as Array<{ user_id: string }>) {
      const notification = await createNotificationIfAllowed({
        org_id: user.org_id,
        user_id: recipient,
        type: asStoredNotificationType('document_shared'),
        title: `Drive members changed: ${drive.name}`,
        body: ADMIN_CHANGE_BODY[change.change],
        link: `/drive/${drive.id}`,
        metadata: { subtype: 'admin_change', drive_id: drive.id, actor_id: user.id },
      });
      if (notification) created.push(notification);
    }
    await emitVisibleNotifications(created);
  } catch {
    console.error('[drives] telling members of an admin change failed');
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
      const loss = lowered ? await lossInTx(tx, { orgId: user.org_id, driveId: drive.id }) : null;
      return { drive: updated!, role, loss, roleRaised: defaultChanged && !lowered, knowledgeDocuments };
    });
    if (outcome.loss) await finishAccessLoss(outcome.loss.change, outcome.loss.result);
    else if (outcome.roleRaised) emitDocumentAccessChanged({ orgId: user.org_id, driveId: outcome.drive.id });
    if (outcome.knowledgeDocuments && outcome.knowledgeDocuments.length > 0) {
      emitDocumentEvent({ type: 'knowledge_changed', orgId: user.org_id, documentIds: outcome.knowledgeDocuments, actorId: user.id });
      await emitDocumentUpdated(user.org_id, outcome.knowledgeDocuments);
    }
    return c.json({ drive: driveShape(outcome.drive, outcome.role, await isPinned(user.id, user.org_id, outcome.drive.id)) });
  } catch (error) {
    if (error instanceof Refused) return answer(c, error.refusal);
    return failed(c, 'update the drive');
  }
});

// DELETE /api/drives/:id (needs full): a soft delete. The Workspace and Shared notes drives stay.
driveRoutes.delete('/:id', async (c) => {
  try {
    const user = c.get('user');
    const outcome = await db.transaction(async (tx) => {
      const { drive } = await locked(tx, user, c.req.param('id'), 'full');
      if (drive.system_key) throw new Refused(refusal(409, 'This drive belongs to the workspace and can’t be deleted', 'SYSTEM_DRIVE'));
      const documentIds = (await tx.select({ id: documents.id }).from(documents).where(and(
        eq(documents.org_id, user.org_id), eq(documents.drive_id, drive.id), eq(documents.is_deleted, false),
      ))).map((row) => row.id);
      // Who could see each document, read before they are hidden, for document:updated after commit.
      const audience = await documentEventAudience(user.org_id, documentIds, tx);
      const now = new Date();
      await tx.update(drives).set({ is_deleted: true, deleted_at: now, updated_at: now }).where(eq(drives.id, drive.id));
      // A chat links one drive at most; free it for another.
      await tx.delete(driveMembers).where(and(eq(driveMembers.drive_id, drive.id), eq(driveMembers.is_link, true)));
      const loss = await lossInTx(tx, { orgId: user.org_id, driveId: drive.id, documentIds });
      return { drive, documentIds, audience, loss };
    });
    await finishAccessLoss(outcome.loss.change, outcome.loss.result);
    emitDocumentEvent({ type: 'deleted', orgId: user.org_id, documentIds: outcome.documentIds, fromDriveId: outcome.drive.id, actorId: user.id });
    sendDocumentEvent(outcome.audience, 'document:updated');
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
      return { access, member: member! };
    });
    emitDocumentAccessChanged(memberChange(user.org_id, outcome.access.drive.id, outcome.member));
    if (outcome.access.adminPath) {
      await recordAdminChange(user, outcome.access.drive, { change: 'added', principal_type: principalType, principal_id: principalId, role, previous_role: null });
    }
    return c.json({ member: memberShape(outcome.member) }, 201);
  } catch (error) {
    if (error instanceof Refused) return answer(c, error.refusal);
    // The principal triggers refuse anyone outside the workspace; the check above normally does first.
    if (pgCode(error) === '23503') return answer(c, CANNOT_HOLD);
    if (pgCode(error) === '23505') return answer(c, ALREADY_MEMBER);
    return failed(c, 'add the member');
  }
});

/** The member row `memberId` of the drive, locked; a personal drive's owner row can't be lowered or removed. */
async function lockedMember(tx: Tx, drive: DriveRow, memberId: string): Promise<DriveMemberRow> {
  const [row] = await tx.select().from(driveMembers)
    .where(and(eq(driveMembers.id, memberId), eq(driveMembers.drive_id, drive.id))).for('update');
  if (!row) throw new Refused(MEMBER_NOT_FOUND);
  if (drive.kind === 'personal' && row.principal_type === 'user' && row.principal_id === drive.owner_user_id) throw new Refused(PERSONAL_OWNER);
  return row;
}

// PATCH /api/drives/:id/members/:memberId { role } (full, or the admin path).
driveRoutes.patch('/:id/members/:memberId', async (c) => {
  try {
    const user = c.get('user');
    const parsed = memberRoleSchema.safeParse(await bodyOf(c));
    if (!parsed.success) return answer(c, invalid());
    const { role } = parsed.data;
    const outcome = await db.transaction(async (tx) => {
      const access = await locked(tx, user, c.req.param('id'), 'manage');
      const row = await lockedMember(tx, access.drive, c.req.param('memberId'));
      if (row.role === role) return { access, member: row, previous: row.role, loss: null };
      const [member] = await tx.update(driveMembers).set({ role, updated_at: new Date() }).where(eq(driveMembers.id, row.id)).returning();
      const loss = lowers(row.role, role) ? await lossInTx(tx, memberChange(user.org_id, access.drive.id, row)) : null;
      return { access, member: member!, previous: row.role, loss };
    });
    if (outcome.previous !== role) {
      if (outcome.loss) await finishAccessLoss(outcome.loss.change, outcome.loss.result);
      else emitDocumentAccessChanged(memberChange(user.org_id, outcome.access.drive.id, outcome.member));
      if (outcome.access.adminPath) {
        await recordAdminChange(user, outcome.access.drive, {
          change: 'role_changed', principal_type: outcome.member.principal_type, principal_id: outcome.member.principal_id,
          role, previous_role: outcome.previous,
        });
      }
    }
    return c.json({ member: memberShape(outcome.member) });
  } catch (error) {
    if (error instanceof Refused) return answer(c, error.refusal);
    return failed(c, 'change the member’s role');
  }
});

// DELETE /api/drives/:id/members/:memberId (full, or the admin path).
driveRoutes.delete('/:id/members/:memberId', async (c) => {
  try {
    const user = c.get('user');
    const outcome = await db.transaction(async (tx) => {
      const access = await locked(tx, user, c.req.param('id'), 'manage');
      const row = await lockedMember(tx, access.drive, c.req.param('memberId'));
      await tx.delete(driveMembers).where(eq(driveMembers.id, row.id));
      return { access, row, loss: await lossInTx(tx, memberChange(user.org_id, access.drive.id, row)) };
    });
    await finishAccessLoss(outcome.loss.change, outcome.loss.result);
    if (outcome.access.adminPath) {
      await recordAdminChange(user, outcome.access.drive, {
        change: 'removed', principal_type: outcome.row.principal_type, principal_id: outcome.row.principal_id, role: null, previous_role: outcome.row.role,
      });
    }
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
      if (!(await requireSpaceMembership(spaceId, user.id, user.org_id))) {
        throw new Refused(refusal(403, 'You can only link a chat you are in', 'SPACE_MEMBERSHIP_REQUIRED'));
      }
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
        return { member: member!, change, loss: lowers(plain.role, role) ? await lossInTx(tx, change) : null };
      }
      const [member] = await tx.insert(driveMembers).values({
        org_id: user.org_id, drive_id: access.drive.id, principal_type: 'space', principal_id: spaceId, role, is_link: true, added_by: user.id,
      }).returning();
      return { member: member!, change, loss: null };
    });
    if (outcome.loss) await finishAccessLoss(outcome.loss.change, outcome.loss.result);
    else emitDocumentAccessChanged(outcome.change);
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
      return { loss: await lossInTx(tx, { orgId: user.org_id, driveId: access.drive.id, spaceId }) };
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
