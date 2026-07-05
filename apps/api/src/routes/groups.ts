import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq, and, count, inArray } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { orgMembers, userGroups, userGroupMembers } from '@deft/db/schema';
import { OrgMembershipError, requireOrgAdminOrOwner } from '../lib/org-membership.js';
import type { AuthUser } from '../middleware/auth.js';

export const groupRoutes = new Hono();

const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

function forbidden(c: Context, err: unknown) {
  if (err instanceof OrgMembershipError) {
    return c.json({ error: err.message, code: err.code }, err.status as 403);
  }
  return c.json({ error: 'Forbidden', code: 'FORBIDDEN' }, 403);
}

async function requireGroupManager(user: AuthUser) {
  return requireOrgAdminOrOwner(user.org_id, user.id);
}

async function getGroupForOrg(orgId: string, groupId: string) {
  const [group] = await db
    .select({ id: userGroups.id })
    .from(userGroups)
    .where(and(eq(userGroups.id, groupId), eq(userGroups.org_id, orgId)))
    .limit(1);
  return group ?? null;
}

async function validateActiveOrgUserIds(orgId: string, userIds: unknown): Promise<string[] | null> {
  if (!Array.isArray(userIds)) return null;
  const unique = Array.from(new Set(userIds));
  if (unique.some((id) => typeof id !== 'string' || id.trim().length === 0)) return null;
  if (unique.length === 0) return [];

  const activeRows = await db
    .select({ user_id: orgMembers.user_id })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.org_id, orgId),
        eq(orgMembers.is_active, true),
        inArray(orgMembers.user_id, unique as string[]),
      ),
    );
  const active = new Set(activeRows.map((row) => row.user_id));
  const missing = (unique as string[]).filter((id) => !active.has(id));
  return missing.length === 0 ? (unique as string[]) : null;
}

// GET /api/groups — list all groups for org (with member count)
groupRoutes.get('/', async (c) => {
  const user = c.get('user');

  const groups = await db.select({
    id: userGroups.id,
    org_id: userGroups.org_id,
    name: userGroups.name,
    handle: userGroups.handle,
    description: userGroups.description,
    created_by: userGroups.created_by,
    created_at: userGroups.created_at,
    updated_at: userGroups.updated_at,
    member_count: count(userGroupMembers.id),
  })
    .from(userGroups)
    .leftJoin(userGroupMembers, eq(userGroups.id, userGroupMembers.group_id))
    .where(eq(userGroups.org_id, user.org_id))
    .groupBy(userGroups.id);

  return c.json(groups);
});

// POST /api/groups — create group
groupRoutes.post('/', async (c) => {
  const user = c.get('user');
  try {
    await requireGroupManager(user);
  } catch (err) {
    return forbidden(c, err);
  }

  const body = await c.req.json();
  const { name, handle, description, member_ids } = body;

  if (typeof name !== 'string' || name.trim().length === 0 || typeof handle !== 'string' || handle.trim().length === 0) {
    return c.json({ error: 'name and handle are required', code: 'VALIDATION_ERROR' }, 400);
  }

  const normalizedHandle = handle.trim().toLowerCase();
  if (!HANDLE_REGEX.test(normalizedHandle)) {
    return c.json({ error: 'Handle must be lowercase alphanumeric with hyphens only', code: 'VALIDATION_ERROR' }, 400);
  }

  const memberIds = member_ids === undefined ? [] : await validateActiveOrgUserIds(user.org_id, member_ids);
  if (!memberIds) {
    return c.json({ error: 'Group members must be active users in this organization', code: 'INVALID_MEMBERS' }, 400);
  }

  // Check uniqueness within org
  const [existing] = await db.select({ id: userGroups.id })
    .from(userGroups)
    .where(and(eq(userGroups.org_id, user.org_id), eq(userGroups.handle, normalizedHandle)))
    .limit(1);

  if (existing) {
    return c.json({ error: 'Handle already taken', code: 'HANDLE_TAKEN' }, 409);
  }

  const [group] = await db.insert(userGroups).values({
    org_id: user.org_id,
    name: name.trim(),
    handle: normalizedHandle,
    description: typeof description === 'string' && description.trim().length > 0 ? description.trim() : null,
    created_by: user.id,
  }).returning();

  // Add initial members if provided
  if (memberIds.length > 0) {
    await db.insert(userGroupMembers).values(
      memberIds.map((userId: string) => ({
        group_id: group!.id,
        user_id: userId,
      }))
    );
  }

  return c.json(group, 201);
});

// PATCH /api/groups/:id — update group
groupRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  try {
    await requireGroupManager(user);
  } catch (err) {
    return forbidden(c, err);
  }

  const id = c.req.param('id');
  const body = await c.req.json();
  const { name, handle, description } = body;

  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      return c.json({ error: 'name must be a non-empty string', code: 'VALIDATION_ERROR' }, 400);
    }
    updates.name = name.trim();
  }
  if (description !== undefined) {
    if (description !== null && typeof description !== 'string') {
      return c.json({ error: 'description must be a string or null', code: 'VALIDATION_ERROR' }, 400);
    }
    updates.description = typeof description === 'string' && description.trim().length > 0 ? description.trim() : null;
  }

  if (handle !== undefined) {
    if (typeof handle !== 'string' || handle.trim().length === 0) {
      return c.json({ error: 'handle must be a non-empty string', code: 'VALIDATION_ERROR' }, 400);
    }
    const normalizedHandle = handle.trim().toLowerCase();
    if (!HANDLE_REGEX.test(normalizedHandle)) {
      return c.json({ error: 'Handle must be lowercase alphanumeric with hyphens only', code: 'VALIDATION_ERROR' }, 400);
    }

    // Check uniqueness (excluding self)
    const [existing] = await db.select({ id: userGroups.id })
      .from(userGroups)
      .where(and(
        eq(userGroups.org_id, user.org_id),
        eq(userGroups.handle, normalizedHandle),
      ))
      .limit(1);

    if (existing && existing.id !== id) {
      return c.json({ error: 'Handle already taken', code: 'HANDLE_TAKEN' }, 409);
    }

    updates.handle = normalizedHandle;
  }

  const [updated] = await db.update(userGroups)
    .set(updates)
    .where(and(eq(userGroups.id, id), eq(userGroups.org_id, user.org_id)))
    .returning();

  if (!updated) {
    return c.json({ error: 'Group not found', code: 'NOT_FOUND' }, 404);
  }

  return c.json(updated);
});

// DELETE /api/groups/:id — delete group + members
groupRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  try {
    await requireGroupManager(user);
  } catch (err) {
    return forbidden(c, err);
  }

  const id = c.req.param('id');

  const group = await getGroupForOrg(user.org_id, id);
  if (!group) {
    return c.json({ error: 'Group not found', code: 'NOT_FOUND' }, 404);
  }

  await db.delete(userGroupMembers).where(eq(userGroupMembers.group_id, id));
  const [deleted] = await db.delete(userGroups)
    .where(and(eq(userGroups.id, id), eq(userGroups.org_id, user.org_id)))
    .returning();

  if (!deleted) {
    return c.json({ error: 'Group not found', code: 'NOT_FOUND' }, 404);
  }

  return c.json({ success: true });
});

// POST /api/groups/:id/members — add members
groupRoutes.post('/:id/members', async (c) => {
  const user = c.get('user');
  try {
    await requireGroupManager(user);
  } catch (err) {
    return forbidden(c, err);
  }

  const id = c.req.param('id');
  const body = await c.req.json();
  const { user_ids } = body;

  if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
    return c.json({ error: 'user_ids array required', code: 'VALIDATION_ERROR' }, 400);
  }

  const group = await getGroupForOrg(user.org_id, id);
  if (!group) {
    return c.json({ error: 'Group not found', code: 'NOT_FOUND' }, 404);
  }

  const userIds = await validateActiveOrgUserIds(user.org_id, user_ids);
  if (!userIds) {
    return c.json({ error: 'Group members must be active users in this organization', code: 'INVALID_MEMBERS' }, 400);
  }

  const members = await db.insert(userGroupMembers)
    .values(userIds.map((userId: string) => ({
      group_id: id,
      user_id: userId,
    })))
    .onConflictDoNothing()
    .returning();

  return c.json(members, 201);
});

// DELETE /api/groups/:id/members/:userId — remove member
groupRoutes.delete('/:id/members/:userId', async (c) => {
  const user = c.get('user');
  try {
    await requireGroupManager(user);
  } catch (err) {
    return forbidden(c, err);
  }

  const groupId = c.req.param('id');
  const userId = c.req.param('userId');

  const group = await getGroupForOrg(user.org_id, groupId);
  if (!group) {
    return c.json({ error: 'Group not found', code: 'NOT_FOUND' }, 404);
  }

  await db.delete(userGroupMembers)
    .where(and(
      eq(userGroupMembers.group_id, groupId),
      eq(userGroupMembers.user_id, userId),
    ));

  return c.json({ success: true });
});
