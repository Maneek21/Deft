import { Hono } from 'hono';
import { eq, and, sql, count } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { userGroups, userGroupMembers } from '@deft/db/schema';

export const groupRoutes = new Hono();

const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

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
  const body = await c.req.json();
  const { name, handle, description, member_ids } = body;

  if (!name || !handle) {
    return c.json({ error: 'name and handle are required', code: 'VALIDATION_ERROR' }, 400);
  }

  const normalizedHandle = handle.toLowerCase();
  if (!HANDLE_REGEX.test(normalizedHandle)) {
    return c.json({ error: 'Handle must be lowercase alphanumeric with hyphens only', code: 'VALIDATION_ERROR' }, 400);
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
    name,
    handle: normalizedHandle,
    description: description || null,
    created_by: user.id,
  }).returning();

  // Add initial members if provided
  if (member_ids && Array.isArray(member_ids) && member_ids.length > 0) {
    await db.insert(userGroupMembers).values(
      member_ids.map((userId: string) => ({
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
  const id = c.req.param('id');
  const body = await c.req.json();
  const { name, handle, description } = body;

  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;

  if (handle !== undefined) {
    const normalizedHandle = handle.toLowerCase();
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
  const id = c.req.param('id');

  // Delete members first
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
  const id = c.req.param('id');
  const body = await c.req.json();
  const { user_ids } = body;

  if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
    return c.json({ error: 'user_ids array required', code: 'VALIDATION_ERROR' }, 400);
  }

  const members = await db.insert(userGroupMembers)
    .values(user_ids.map((userId: string) => ({
      group_id: id,
      user_id: userId,
    })))
    .onConflictDoNothing()
    .returning();

  return c.json(members, 201);
});

// DELETE /api/groups/:id/members/:userId — remove member
groupRoutes.delete('/:id/members/:userId', async (c) => {
  const groupId = c.req.param('id');
  const userId = c.req.param('userId');

  await db.delete(userGroupMembers)
    .where(and(
      eq(userGroupMembers.group_id, groupId),
      eq(userGroupMembers.user_id, userId),
    ));

  return c.json({ success: true });
});
