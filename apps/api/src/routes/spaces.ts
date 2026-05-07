import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { spaces, spaceMembers, users, messages } from '@deft/db/schema';
import { getIO } from '../socket.js';
import { requireSpaceMembership } from '../lib/space-membership.js';

export const spaceRoutes = new Hono();

const VALID_SPACE_TYPES = ['public', 'private', 'dm', 'group_dm'] as const;

const createSpaceSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional().default('public'),
  description: z.string().nullable().optional(),
  user_ids: z.array(z.string()).optional(), // For DMs: array of user IDs to include
});

const updateSpaceSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  topic: z.string().optional(),
});

// POST /api/spaces — create space
spaceRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json();
    const parsed = createSpaceSchema.safeParse(body);
    if (!parsed.success) {
      console.error('Create space validation error:', parsed.error.format());
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const { name, description, user_ids } = parsed.data;
    const type = (VALID_SPACE_TYPES as readonly string[]).includes(parsed.data.type)
      ? (parsed.data.type as typeof VALID_SPACE_TYPES[number])
      : 'public';

    // Check for existing DM before creating a duplicate
    if (type === 'dm' && user_ids && user_ids.length > 0) {
      const targetUserId = user_ids[0]!;
      const existingDms = await db.select({ space_id: spaceMembers.space_id })
        .from(spaceMembers)
        .innerJoin(spaces, eq(spaces.id, spaceMembers.space_id))
        .where(and(
          eq(spaces.type, 'dm'),
          eq(spaces.org_id, user.org_id),
          eq(spaceMembers.user_id, user.id),
        ));

      for (const dm of existingDms) {
        const otherMember = await db.select()
          .from(spaceMembers)
          .where(and(
            eq(spaceMembers.space_id, dm.space_id),
            eq(spaceMembers.user_id, targetUserId),
          ))
          .limit(1);

        if (otherMember.length > 0) {
          // DM already exists, return it
          const [existingSpace] = await db.select().from(spaces).where(eq(spaces.id, dm.space_id)).limit(1);
          return c.json(existingSpace, 200);
        }
      }
    }

    const [space] = await db.insert(spaces).values({
      org_id: user.org_id,
      name,
      type,
      description,
      created_by: user.id,
    }).returning();

    // Add creator as member
    await db.insert(spaceMembers).values({
      space_id: space!.id,
      user_id: user.id,
    });

    // For DMs: add all specified users as members
    if ((type === 'dm' || type === 'group_dm') && user_ids && user_ids.length > 0) {
      const memberValues = user_ids
        .filter((uid) => uid !== user.id) // Don't duplicate creator
        .map((uid) => ({
          space_id: space!.id,
          user_id: uid,
        }));

      if (memberValues.length > 0) {
        await db.insert(spaceMembers).values(memberValues);
      }
    }

    // Broadcast space:created via socket to org
    const io = getIO();
    if (io) {
      io.to(`org:${user.org_id}`).emit('space:created', space);
    }

    return c.json(space, 201);
  } catch (err) {
    console.error('Failed to create space:', err);
    return c.json({ error: 'Failed to create space', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/spaces — list spaces for current org (with last_read_message_id)
spaceRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');

    const orgSpaces = await db.select({
      id: spaces.id,
      name: spaces.name,
      type: spaces.type,
      description: spaces.description,
      topic: spaces.topic,
      is_default: spaces.is_default,
      is_archived: spaces.is_archived,
      is_muted: spaceMembers.is_muted,
      created_at: spaces.created_at,
      last_read_message_id: spaceMembers.last_read_message_id,
      last_read_at: spaceMembers.last_read_at,
    })
      .from(spaces)
      .innerJoin(spaceMembers, and(
        eq(spaces.id, spaceMembers.space_id),
        eq(spaceMembers.user_id, user.id),
      ))
      .where(
        and(
          eq(spaces.org_id, user.org_id),
          eq(spaces.is_archived, false),
        )
      );

    return c.json(orgSpaces);
  } catch (err) {
    console.error('Failed to fetch spaces:', err);
    return c.json({ error: 'Failed to fetch spaces', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/spaces/unread — get unread counts for all spaces (must be before /:id)
spaceRoutes.get('/unread', async (c) => {
  try {
    const user = c.get('user');

    const userSpaces = await db.select({
      space_id: spaceMembers.space_id,
      last_read_at: spaceMembers.last_read_at,
    })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaceMembers.space_id, spaces.id))
      .where(and(
        eq(spaceMembers.user_id, user.id),
        eq(spaces.org_id, user.org_id),
        eq(spaces.is_archived, false),
      ));

    const counts: { space_id: string; unread: number }[] = [];

    for (const s of userSpaces) {
      const lastRead = s.last_read_at || new Date(0);
      const [result] = await db.select({
        count: sql<number>`count(*)::int`,
      })
        .from(messages)
        .where(and(
          eq(messages.space_id, s.space_id),
          sql`${messages.created_at} > ${lastRead}`,
          eq(messages.is_deleted, false),
          sql`${messages.user_id} != ${user.id}`,
          sql`${messages.parent_id} IS NULL`,
        ));

      const count = result?.count || 0;
      if (count > 0) {
        counts.push({ space_id: s.space_id, unread: count });
      }
    }

    return c.json(counts);
  } catch (err) {
    console.error('Failed to fetch unread counts:', err);
    return c.json({ error: 'Failed to fetch unread counts', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/spaces/:id — get single space
spaceRoutes.get('/:id', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('id');

    const [space] = await db.select()
      .from(spaces)
      .where(and(eq(spaces.id, spaceId), eq(spaces.org_id, user.org_id)))
      .limit(1);

    if (!space) {
      return c.json({ error: 'Space not found', code: 'NOT_FOUND' }, 404);
    }

    return c.json(space);
  } catch (err) {
    console.error('Failed to fetch space:', err);
    return c.json({ error: 'Failed to fetch space', code: 'INTERNAL_ERROR' }, 500);
  }
});

// PATCH /api/spaces/:id — update space (name, description, topic)
spaceRoutes.patch('/:id', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('id');
    const body = await c.req.json();
    const parsed = updateSpaceSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const [existing] = await db.select()
      .from(spaces)
      .where(and(eq(spaces.id, spaceId), eq(spaces.org_id, user.org_id)))
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Space not found', code: 'NOT_FOUND' }, 404);
    }

    // Only creator can update (could extend to admin/owner check)
    if (existing.created_by !== user.id) {
      return c.json({ error: 'Forbidden', code: 'FORBIDDEN' }, 403);
    }

    const updateData: Record<string, any> = {};
    if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
    if (parsed.data.description !== undefined) updateData.description = parsed.data.description;
    if (parsed.data.topic !== undefined) updateData.topic = parsed.data.topic;

    if (Object.keys(updateData).length === 0) {
      return c.json({ error: 'No fields to update', code: 'VALIDATION_ERROR' }, 400);
    }

    const [updated] = await db.update(spaces)
      .set(updateData)
      .where(eq(spaces.id, spaceId))
      .returning();

    return c.json(updated);
  } catch (err) {
    console.error('Failed to update space:', err);
    return c.json({ error: 'Failed to update space', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/spaces/:id/members — list members of a space
spaceRoutes.get('/:id/members', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('id');

    // Verify space belongs to user's org
    const [space] = await db.select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.id, spaceId), eq(spaces.org_id, user.org_id)))
      .limit(1);

    if (!space) {
      return c.json({ error: 'Space not found', code: 'NOT_FOUND' }, 404);
    }

    const isMember = await requireSpaceMembership(spaceId, user.id);
    if (!isMember) return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);

    const members = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      avatar_url: users.avatar_url,
      kind: users.kind,
      last_seen_at: users.last_seen_at,
      status_emoji: users.status_emoji,
      status_text: users.status_text,
      joined_at: spaceMembers.joined_at,
      is_muted: spaceMembers.is_muted,
    })
      .from(spaceMembers)
      .innerJoin(users, eq(spaceMembers.user_id, users.id))
      .where(eq(spaceMembers.space_id, spaceId));

    return c.json(members);
  } catch (err) {
    console.error('Failed to fetch space members:', err);
    return c.json({ error: 'Failed to fetch space members', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/spaces/:id/members — add member to space
spaceRoutes.post('/:id/members', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('id');
    const body = await c.req.json();
    const { user_id } = body;

    if (!user_id || typeof user_id !== 'string') {
      return c.json({ error: 'user_id required', code: 'VALIDATION_ERROR' }, 400);
    }

    // Verify space belongs to user's org
    const [space] = await db.select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.id, spaceId), eq(spaces.org_id, user.org_id)))
      .limit(1);

    if (!space) {
      return c.json({ error: 'Space not found', code: 'NOT_FOUND' }, 404);
    }

    const isMember = await requireSpaceMembership(spaceId, user.id);
    if (!isMember) return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);

    // Check if already a member
    const [existing] = await db.select()
      .from(spaceMembers)
      .where(
        and(
          eq(spaceMembers.space_id, spaceId),
          eq(spaceMembers.user_id, user_id),
        )
      )
      .limit(1);

    if (existing) {
      return c.json({ error: 'User is already a member', code: 'CONFLICT' }, 409);
    }

    const [member] = await db.insert(spaceMembers).values({
      space_id: spaceId,
      user_id,
    }).returning();

    return c.json(member, 201);
  } catch (err) {
    console.error('Failed to add space member:', err);
    return c.json({ error: 'Failed to add member', code: 'INTERNAL_ERROR' }, 500);
  }
});

// PATCH /api/spaces/:id/mute — toggle mute for current user
spaceRoutes.patch('/:id/mute', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('id');
    const { muted } = await c.req.json();

    await db.update(spaceMembers)
      .set({ is_muted: !!muted })
      .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, user.id)));

    return c.json({ success: true, muted: !!muted });
  } catch (err) {
    console.error('Failed to toggle mute:', err);
    return c.json({ error: 'Failed to toggle mute', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/spaces/:id/read — mark space as read
spaceRoutes.post('/:id/read', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('id');

    // Get the latest message in this space
    const [latestMessage] = await db.select({ id: messages.id })
      .from(messages)
      .where(eq(messages.space_id, spaceId))
      .orderBy(desc(messages.created_at))
      .limit(1);

    const updateData: Record<string, any> = {
      last_read_at: new Date(),
    };

    if (latestMessage) {
      updateData.last_read_message_id = latestMessage.id;
    }

    await db.update(spaceMembers)
      .set(updateData)
      .where(
        and(
          eq(spaceMembers.space_id, spaceId),
          eq(spaceMembers.user_id, user.id),
        )
      );

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to mark space as read:', err);
    return c.json({ error: 'Failed to mark space as read', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/spaces/:id/members/:userId — remove member from space
spaceRoutes.delete('/:id/members/:userId', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('id');
    const userId = c.req.param('userId');

    // Don't match the "me" route
    if (userId === 'me') {
      return c.notFound();
    }

    // Verify space belongs to user's org
    const [space] = await db.select()
      .from(spaces)
      .where(and(eq(spaces.id, spaceId), eq(spaces.org_id, user.org_id)))
      .limit(1);

    if (!space) {
      return c.json({ error: 'Space not found', code: 'NOT_FOUND' }, 404);
    }

    // Only creator can remove members
    if (space.created_by !== user.id) {
      return c.json({ error: 'Forbidden', code: 'FORBIDDEN' }, 403);
    }

    const deleted = await db.delete(spaceMembers)
      .where(
        and(
          eq(spaceMembers.space_id, spaceId),
          eq(spaceMembers.user_id, userId),
        )
      )
      .returning();

    if (deleted.length === 0) {
      return c.json({ error: 'User is not a member of this space', code: 'NOT_FOUND' }, 404);
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to remove space member:', err);
    return c.json({ error: 'Failed to remove member', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/spaces/:id/members/me — leave space
spaceRoutes.delete('/:id/members/me', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('id');

    const deleted = await db.delete(spaceMembers)
      .where(
        and(
          eq(spaceMembers.space_id, spaceId),
          eq(spaceMembers.user_id, user.id),
        )
      )
      .returning();

    if (deleted.length === 0) {
      return c.json({ error: 'Not a member of this space', code: 'NOT_FOUND' }, 404);
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to leave space:', err);
    return c.json({ error: 'Failed to leave space', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/spaces/:id — archive (soft delete) a space
spaceRoutes.delete('/:id', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('id');

    const [space] = await db.select()
      .from(spaces)
      .where(and(eq(spaces.id, spaceId), eq(spaces.org_id, user.org_id)))
      .limit(1);

    if (!space) {
      return c.json({ error: 'Space not found', code: 'NOT_FOUND' }, 404);
    }

    if (space.is_default) {
      return c.json({ error: 'Cannot delete the default space', code: 'FORBIDDEN' }, 403);
    }

    // Only creator or admin can delete
    if (space.created_by !== user.id) {
      return c.json({ error: 'Only the space creator can delete it', code: 'FORBIDDEN' }, 403);
    }

    await db.update(spaces)
      .set({ is_archived: true })
      .where(eq(spaces.id, spaceId));

    // Notify connected clients
    try {
      const io = getIO();
      if (io) io.to(`org:${user.org_id}`).emit('space:deleted', { id: spaceId });
    } catch {}

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to delete space:', err);
    return c.json({ error: 'Failed to delete space', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /:id/mark-unread — mark a message as unread (resets read position)
spaceRoutes.post('/:id/mark-unread', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('id');
    const { message_id } = await c.req.json();

    if (!message_id) {
      return c.json({ error: 'message_id required', code: 'VALIDATION_ERROR' }, 400);
    }

    // Get the message's created_at, then set read position to 1ms before it
    const [msg] = await db.select({ created_at: messages.created_at })
      .from(messages)
      .where(eq(messages.id, message_id))
      .limit(1);

    if (!msg) {
      return c.json({ error: 'Message not found', code: 'NOT_FOUND' }, 404);
    }

    const unreadAt = new Date(msg.created_at!.getTime() - 1);
    await db.update(spaceMembers)
      .set({ last_read_at: unreadAt, last_read_message_id: null })
      .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, user.id)));

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to mark unread:', err);
    return c.json({ error: 'Failed to mark unread', code: 'INTERNAL_ERROR' }, 500);
  }
});

// PATCH /:id/notification-level — set per-channel notification level
spaceRoutes.patch('/:id/notification-level', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('id');
    const { level } = await c.req.json();

    if (!['all', 'mentions', 'nothing'].includes(level)) {
      return c.json({ error: 'level must be all, mentions, or nothing', code: 'VALIDATION_ERROR' }, 400);
    }

    await db.update(spaceMembers)
      .set({
        notification_level: level,
        is_muted: level === 'nothing',
      })
      .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, user.id)));

    return c.json({ success: true, level });
  } catch (err) {
    console.error('Failed to set notification level:', err);
    return c.json({ error: 'Failed to set notification level', code: 'INTERNAL_ERROR' }, 500);
  }
});
