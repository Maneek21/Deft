import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { users, orgMembers } from '@deft/db/schema';

export const memberRoutes = new Hono();

// GET /api/members — list all members of current org
memberRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');

    const members = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      avatar_url: users.avatar_url,
      status_emoji: users.status_emoji,
      status_text: users.status_text,
      status_expires_at: users.status_expires_at,
      role: orgMembers.role,
    })
      .from(orgMembers)
      .innerJoin(users, eq(orgMembers.user_id, users.id))
      .where(
        and(
          eq(orgMembers.org_id, user.org_id),
          eq(orgMembers.is_active, true),
        )
      );

    // Clear expired statuses
    const now = new Date();
    const result = members.map(m => {
      if (m.status_expires_at && new Date(m.status_expires_at) < now) {
        // Auto-clear expired status (fire-and-forget DB update)
        db.update(users).set({ status_emoji: null, status_text: null, status_expires_at: null })
          .where(eq(users.id, m.id)).catch(() => {});
        return { ...m, status_emoji: null, status_text: null, status_expires_at: null };
      }
      return m;
    });

    return c.json(result);
  } catch (err) {
    console.error('Failed to fetch members:', err);
    return c.json({ error: 'Failed to fetch members', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/members/:id — get single member profile
memberRoutes.get('/:id', async (c) => {
  try {
    const user = c.get('user');
    const memberId = c.req.param('id');

    const [member] = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      avatar_url: users.avatar_url,
      title: users.title,
      timezone: users.timezone,
      status_emoji: users.status_emoji,
      status_text: users.status_text,
      last_seen_at: users.last_seen_at,
      role: orgMembers.role,
    })
      .from(orgMembers)
      .innerJoin(users, eq(orgMembers.user_id, users.id))
      .where(and(eq(orgMembers.org_id, user.org_id), eq(users.id, memberId)))
      .limit(1);

    if (!member) {
      return c.json({ error: 'Member not found', code: 'NOT_FOUND' }, 404);
    }

    return c.json(member);
  } catch (err) {
    console.error('Failed to fetch member:', err);
    return c.json({ error: 'Failed to fetch member', code: 'INTERNAL_ERROR' }, 500);
  }
});
