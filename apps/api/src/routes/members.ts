import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { db } from '../lib/db.js';
import {
  users,
  orgMembers,
  spaces,
  spaceMembers,
  agentEmployees,
  mcpTokens,
  invites,
  apiKeys,
  oauthGrants,
  oauthAccessTokens,
  oauthRefreshTokens,
} from '@deft/db/schema';
import { env } from '../lib/env.js';
import { DEFTY_EMAIL } from '../lib/ensure-defty-membership.js';
import { OrgMembershipError, requireOrgAdminOrOwner } from '../lib/org-membership.js';

const INVITE_TTL = '7d';
const RECOVERY_TTL = '24h';

function buildInviteUrl(token: string): string {
  return `${env.NEXT_PUBLIC_APP_URL}/invite/${token}`;
}

function buildRecoveryUrl(token: string): string {
  return `${env.NEXT_PUBLIC_APP_URL}/reset-password?token=${token}`;
}

export const memberRoutes = new Hono();

function adminForbidden(c: Context, err: unknown) {
  if (err instanceof OrgMembershipError) {
    return c.json({ error: err.message, code: err.code }, err.status as 403);
  }
  return c.json({ error: 'Only admins can perform this action', code: 'FORBIDDEN' }, 403);
}

function visibleLiveMemberForOrg(orgIdRef: unknown) {
  return sql`
    (
      ${users.kind} <> 'agent'
      OR ${users.email} = ${DEFTY_EMAIL}
      OR EXISTS (
        SELECT 1
        FROM ${agentEmployees}
        WHERE ${agentEmployees.user_id} = ${users.id}
          AND ${agentEmployees.org_id} = ${orgIdRef}
          AND ${agentEmployees.is_active} = true
          AND ${agentEmployees.is_deleted} = false
      )
    )
  `;
}

// GET /api/members — list all members of current org
memberRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');

    const members = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      kind: users.kind,
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
          visibleLiveMemberForOrg(orgMembers.org_id),
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
      kind: users.kind,
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
      .where(and(
        eq(orgMembers.org_id, user.org_id),
        eq(orgMembers.is_active, true),
        eq(users.id, memberId),
        visibleLiveMemberForOrg(orgMembers.org_id),
      ))
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

    try {
      await requireOrgAdminOrOwner(currentUser.org_id, currentUser.id);
    } catch (err) {
      return adminForbidden(c, err);
    }

    const body = await c.req.json();
    const parsed = inviteSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const { email, role } = parsed.data;

    // Check if user already exists
    let [existingUser] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    let membershipExists = false;
    if (existingUser) {
      const [existingMembership] = await db.select()
        .from(orgMembers)
        .where(and(eq(orgMembers.org_id, currentUser.org_id), eq(orgMembers.user_id, existingUser.id)))
        .limit(1);

      if (existingMembership) {
        membershipExists = true;
        if (existingMembership.is_active) {
          return c.json({ error: 'User is already a member', code: 'ALREADY_MEMBER' }, 409);
        }
        await db.update(orgMembers)
          .set({ is_active: true, role })
          .where(eq(orgMembers.id, existingMembership.id));
      }
    } else {
      // Create the user with no password — they'll set one when accepting.
      const [newUser] = await db.insert(users).values({
        name: email.split('@')[0]!,
        email,
        password_hash: null,
      }).returning();
      existingUser = newUser!;
    }

    // Add to org
    if (!membershipExists) {
      await db.insert(orgMembers).values({
        org_id: currentUser.org_id,
        user_id: existingUser.id,
        role,
      });
    }

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

    // Generate an invite URL the admin shares out-of-band (chat, in person,
    // whatever). The `member.joined` trigger fires on accept, not here, so
    // agents only react when the user actually shows up.
    const inviteToken = jwt.sign(
      {
        purpose: 'invite-accept',
        user_id: existingUser.id,
        org_id: currentUser.org_id,
        email,
        inviter_id: currentUser.id,
        role,
      },
      env.JWT_SECRET,
      { expiresIn: INVITE_TTL },
    );

    const decoded = jwt.decode(inviteToken) as { exp?: number } | null;
    const expiresAtDate = decoded?.exp ? new Date(decoded.exp * 1000) : null;
    const expiresAt = expiresAtDate?.toISOString() ?? null;

    await db.insert(invites).values({
      org_id: currentUser.org_id,
      email,
      token: inviteToken,
      type: 'email',
      invited_by: currentUser.id,
      expires_at: expiresAtDate ?? undefined,
    });

    return c.json(
      {
        success: true,
        message: 'Invitation created',
        user_id: existingUser.id,
        invite_url: buildInviteUrl(inviteToken),
        expires_at: expiresAt,
      },
      201,
    );
  } catch (err) {
    console.error('Failed to invite member:', err);
    return c.json({ error: 'Failed to invite member', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/members/:id/recovery-url — admin-only password recovery URL.
// Returns a short-lived password-reset link the admin shares out of band.
// Self-hosted Deft has no email; admin recovery is the supported path.
memberRoutes.post('/:id/recovery-url', async (c) => {
  try {
    const currentUser = c.get('user');
    const memberId = c.req.param('id');

    try {
      await requireOrgAdminOrOwner(currentUser.org_id, currentUser.id);
    } catch (err) {
      return adminForbidden(c, err);
    }

    const [target] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .innerJoin(orgMembers, eq(orgMembers.user_id, users.id))
      .where(and(eq(orgMembers.org_id, currentUser.org_id), eq(users.id, memberId), eq(orgMembers.is_active, true)))
      .limit(1);

    if (!target) {
      return c.json({ error: 'Member not found', code: 'NOT_FOUND' }, 404);
    }

    const resetToken = jwt.sign(
      { id: target.id, email: target.email, purpose: 'password-reset' },
      env.JWT_SECRET,
      { expiresIn: RECOVERY_TTL },
    );

    const decoded = jwt.decode(resetToken) as { exp?: number } | null;
    const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null;

    return c.json({
      recovery_url: buildRecoveryUrl(resetToken),
      expires_at: expiresAt,
    });
  } catch (err) {
    console.error('Failed to generate recovery URL:', err);
    return c.json({ error: 'Failed to generate recovery URL', code: 'INTERNAL_ERROR' }, 500);
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

    try {
      await requireOrgAdminOrOwner(currentUser.org_id, currentUser.id);
    } catch (err) {
      return adminForbidden(c, err);
    }

    // Can't change owner role
    const [targetMembership] = await db.select({ role: orgMembers.role, id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.org_id, currentUser.org_id), eq(orgMembers.user_id, memberId), eq(orgMembers.is_active, true)))
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

    try {
      await requireOrgAdminOrOwner(currentUser.org_id, currentUser.id);
    } catch (err) {
      return adminForbidden(c, err);
    }

    // Can't remove owner
    const [targetMembership] = await db.select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.org_id, currentUser.org_id), eq(orgMembers.user_id, memberId), eq(orgMembers.is_active, true)))
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

    // Remove chat access in this org and revoke personal MCP tokens. Access
    // tokens are short-lived; the active-membership auth guard blocks them
    // immediately on the next request/refresh/socket auth.
    await db.execute(sql`
      DELETE FROM ${spaceMembers}
      WHERE ${spaceMembers.user_id} = ${memberId}
        AND ${spaceMembers.space_id} IN (
          SELECT ${spaces.id}
          FROM ${spaces}
          WHERE ${spaces.org_id} = ${currentUser.org_id}
        )
    `);

    const revokedAt = new Date();

    await db.update(mcpTokens)
      .set({ revoked_at: new Date() })
      .where(and(
        eq(mcpTokens.org_id, currentUser.org_id),
        eq(mcpTokens.user_id, memberId),
        sql`${mcpTokens.revoked_at} IS NULL`,
      ));

    await db.update(apiKeys)
      .set({ is_active: false, updated_at: revokedAt })
      .where(and(
        eq(apiKeys.org_id, currentUser.org_id),
        eq(apiKeys.created_by, memberId),
        eq(apiKeys.is_active, true),
      ));

    await db.update(oauthGrants)
      .set({ revoked_at: revokedAt, updated_at: revokedAt })
      .where(and(
        eq(oauthGrants.org_id, currentUser.org_id),
        eq(oauthGrants.user_id, memberId),
        sql`${oauthGrants.revoked_at} IS NULL`,
      ));
    await db.update(oauthAccessTokens)
      .set({ revoked_at: revokedAt, updated_at: revokedAt })
      .where(and(
        eq(oauthAccessTokens.org_id, currentUser.org_id),
        eq(oauthAccessTokens.user_id, memberId),
        sql`${oauthAccessTokens.revoked_at} IS NULL`,
      ));
    await db.execute(sql`
      UPDATE ${oauthRefreshTokens}
      SET revoked_at = ${revokedAt}, updated_at = ${revokedAt}
      WHERE revoked_at IS NULL
        AND grant_id IN (
          SELECT id
          FROM ${oauthGrants}
          WHERE org_id = ${currentUser.org_id}
            AND user_id = ${memberId}
        )
    `);

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to remove member:', err);
    return c.json({ error: 'Failed to remove member', code: 'INTERNAL_ERROR' }, 500);
  }
});
