import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import { users, orgMembers, spaces, spaceMembers } from '@deft/db/schema';
import { env } from '../lib/env.js';

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

// POST /api/members/invite — invite a new member to the org
const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'guest']).default('member'),
});

memberRoutes.post('/invite', async (c) => {
  try {
    const currentUser = c.get('user');

    // Only owner/admin can invite
    const [membership] = await db.select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.org_id, currentUser.org_id), eq(orgMembers.user_id, currentUser.id)))
      .limit(1);

    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return c.json({ error: 'Only admins can invite members', code: 'FORBIDDEN' }, 403);
    }

    const body = await c.req.json();
    const parsed = inviteSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const { email, role } = parsed.data;

    // Track the invite result so we can surface the temp password to the
    // inviting admin when email delivery is not configured. NEVER log the
    // temp password — hosted environments almost always expose stdout.
    let tempPasswordForResponse: string | null = null;
    let emailSent = false;

    // Check if user already exists
    let [existingUser] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    if (existingUser) {
      // Check if already a member of this org
      const [existingMembership] = await db.select()
        .from(orgMembers)
        .where(and(eq(orgMembers.org_id, currentUser.org_id), eq(orgMembers.user_id, existingUser.id)))
        .limit(1);

      if (existingMembership) {
        if (!existingMembership.is_active) {
          // Reactivate
          await db.update(orgMembers)
            .set({ is_active: true, role })
            .where(eq(orgMembers.id, existingMembership.id));
          return c.json({ success: true, message: 'Member reactivated', user_id: existingUser.id });
        }
        return c.json({ error: 'User is already a member', code: 'ALREADY_MEMBER' }, 409);
      }
    } else {
      // Create new user with temp password
      const tempPassword = crypto.randomBytes(16).toString('hex');
      const passwordHash = await bcrypt.hash(tempPassword, 12);
      const [newUser] = await db.insert(users).values({
        name: email.split('@')[0]!,
        email,
        password_hash: passwordHash,
      }).returning();
      existingUser = newUser!;

      // Send invite email if Resend configured
      if (env.RESEND_API_KEY) {
        try {
          const resendRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.RESEND_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: process.env.FROM_EMAIL || 'noreply@deft.dev',
              to: email,
              subject: 'You\'ve been invited to Deft',
              html: `<p>You've been invited to a Deft workspace. Sign in at <a href="${env.NEXT_PUBLIC_APP_URL}/login">${env.NEXT_PUBLIC_APP_URL}/login</a> with this email. Your temporary password is: <strong>${tempPassword}</strong></p><p>Please change your password after signing in.</p>`,
            }),
          });
          emailSent = resendRes.ok;
          if (!resendRes.ok) {
            // Email call failed; fall back to returning the password in the
            // API response so the admin can relay it manually.
            tempPasswordForResponse = tempPassword;
          }
        } catch (err) {
          // Log the ERROR metadata but never the password itself.
          console.error('[members] Failed to send invite email:', err);
          tempPasswordForResponse = tempPassword;
        }
      } else {
        // Resend not configured — return the temp password in the response
        // so the admin can relay it manually via their own channel. This
        // replaces the previous stdout log which exposed credentials to any
        // log aggregator on the host.
        tempPasswordForResponse = tempPassword;
      }
    }

    // Add to org
    await db.insert(orgMembers).values({
      org_id: currentUser.org_id,
      user_id: existingUser.id,
      role,
    });

    // Add to all default (public) spaces
    const defaultSpaces = await db.select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.org_id, currentUser.org_id), eq(spaces.is_default, true)));

    for (const space of defaultSpaces) {
      await db.insert(spaceMembers).values({
        space_id: space.id,
        user_id: existingUser.id,
      }).onConflictDoNothing();
    }

    // Block 2.7 — fan out a `member.joined` trigger to any agent subscribed
    // to it (opt-in via HR-style skill install). Fire-and-forget so a
    // misconfigured subscriber doesn't block the invite response.
    (async () => {
      try {
        const { emitMemberJoinedTrigger } = await import('../lib/member-joined-trigger.js');
        const count = await emitMemberJoinedTrigger({
          org_id: currentUser.org_id,
          new_user_id: existingUser.id,
          inviter_user_id: currentUser.id,
          role,
        });
        if (count > 0) {
          console.log(`[members] Fired member.joined trigger to ${count} employee(s)`);
        }
      } catch (err) {
        console.warn('[members] member.joined trigger failed:', (err as Error).message);
      }
    })();

    return c.json(
      {
        success: true,
        message: emailSent ? 'Invitation sent' : 'Invitation created',
        user_id: existingUser.id,
        email_sent: emailSent,
        // temp_password is only present when email delivery is not
        // configured or failed. The admin UI should display it once and
        // prompt the admin to send it to the user out-of-band.
        temp_password: tempPasswordForResponse,
      },
      201,
    );
  } catch (err) {
    console.error('Failed to invite member:', err);
    return c.json({ error: 'Failed to invite member', code: 'INTERNAL_ERROR' }, 500);
  }
});

// PATCH /api/members/:id — update member role
const roleUpdateSchema = z.object({
  role: z.enum(['admin', 'member', 'guest']),
});

memberRoutes.patch('/:id', async (c) => {
  try {
    const currentUser = c.get('user');
    const memberId = c.req.param('id');

    // Only owner/admin can change roles
    const [currentMembership] = await db.select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.org_id, currentUser.org_id), eq(orgMembers.user_id, currentUser.id)))
      .limit(1);

    if (!currentMembership || !['owner', 'admin'].includes(currentMembership.role)) {
      return c.json({ error: 'Only admins can change roles', code: 'FORBIDDEN' }, 403);
    }

    // Can't change owner role
    const [targetMembership] = await db.select({ role: orgMembers.role, id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.org_id, currentUser.org_id), eq(orgMembers.user_id, memberId)))
      .limit(1);

    if (!targetMembership) {
      return c.json({ error: 'Member not found', code: 'NOT_FOUND' }, 404);
    }

    if (targetMembership.role === 'owner') {
      return c.json({ error: 'Cannot change owner role', code: 'FORBIDDEN' }, 403);
    }

    const body = await c.req.json();
    const parsed = roleUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    await db.update(orgMembers)
      .set({ role: parsed.data.role })
      .where(eq(orgMembers.id, targetMembership.id));

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to update member role:', err);
    return c.json({ error: 'Failed to update role', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/members/:id — remove member from org (soft deactivate)
memberRoutes.delete('/:id', async (c) => {
  try {
    const currentUser = c.get('user');
    const memberId = c.req.param('id');

    // Can't remove yourself
    if (memberId === currentUser.id) {
      return c.json({ error: 'Cannot remove yourself', code: 'FORBIDDEN' }, 403);
    }

    // Only owner/admin can remove
    const [currentMembership] = await db.select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.org_id, currentUser.org_id), eq(orgMembers.user_id, currentUser.id)))
      .limit(1);

    if (!currentMembership || !['owner', 'admin'].includes(currentMembership.role)) {
      return c.json({ error: 'Only admins can remove members', code: 'FORBIDDEN' }, 403);
    }

    // Can't remove owner
    const [targetMembership] = await db.select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.org_id, currentUser.org_id), eq(orgMembers.user_id, memberId)))
      .limit(1);

    if (!targetMembership) {
      return c.json({ error: 'Member not found', code: 'NOT_FOUND' }, 404);
    }

    if (targetMembership.role === 'owner') {
      return c.json({ error: 'Cannot remove the org owner', code: 'FORBIDDEN' }, 403);
    }

    // Soft deactivate
    await db.update(orgMembers)
      .set({ is_active: false })
      .where(and(eq(orgMembers.org_id, currentUser.org_id), eq(orgMembers.user_id, memberId)));

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to remove member:', err);
    return c.json({ error: 'Failed to remove member', code: 'INTERNAL_ERROR' }, 500);
  }
});
