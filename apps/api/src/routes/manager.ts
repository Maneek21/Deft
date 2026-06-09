// Routes: Manager tools — 1:1 prep, team health, manager settings
import { Hono } from 'hono';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import {
  oneonePreps,
  managerSettings,
  teamHealthSnapshots,
  users,
  orgMembers,
  agentEmployees,
} from '@deft/db/schema';
import { generateOneOnePrep } from '../services/oneone-prep.js';
import { DEFTY_EMAIL } from '../lib/ensure-defty-membership.js';

export const managerRoutes = new Hono();

function visibleManagerMemberForOrg(orgId: string) {
  return sql`
    (
      ${users.kind} <> 'agent'
      OR ${users.email} = ${DEFTY_EMAIL}
      OR EXISTS (
        SELECT 1
        FROM ${agentEmployees}
        WHERE ${agentEmployees.user_id} = ${users.id}
          AND ${agentEmployees.org_id} = ${orgId}
          AND ${agentEmployees.is_active} = true
          AND ${agentEmployees.is_deleted} = false
      )
    )
  `;
}

async function sanitizeTeamHealthSnapshot(snapshot: typeof teamHealthSnapshots.$inferSelect, orgId: string) {
  const teamData = (snapshot.team_data ?? {}) as any;
  const cards = Array.isArray(teamData.healthCards) ? teamData.healthCards : [];
  if (cards.length === 0) return snapshot;

  const visibleRows = await db
    .select({ id: users.id, name: users.name })
    .from(orgMembers)
    .innerJoin(users, eq(orgMembers.user_id, users.id))
    .where(and(
      eq(orgMembers.org_id, orgId),
      eq(orgMembers.is_active, true),
      visibleManagerMemberForOrg(orgId),
    ));
  const visibleIds = new Set(visibleRows.map((row) => row.id));
  const visibleNames = new Set(visibleRows.map((row) => row.name).filter(Boolean));

  const filteredCards = cards.filter((card: any) => visibleIds.has(card.userId));
  const hiddenNames = new Set(
    cards
      .filter((card: any) => !visibleIds.has(card.userId) && typeof card.name === 'string')
      .map((card: any) => card.name),
  );

  const wins = Array.isArray(teamData.wins)
    ? teamData.wins.filter((win: unknown) => {
        if (typeof win !== 'string') return false;
        for (const name of hiddenNames) {
          if (win.startsWith(`${name} `)) return false;
        }
        return [...visibleNames].some((name) => win.startsWith(`${name} `));
      })
    : [];
  const actionItems = Array.isArray(teamData.actionItems)
    ? teamData.actionItems.filter((item: any) => visibleIds.has(item.userId))
    : [];
  const green = filteredCards.filter((card: any) => card.status === 'green').length;
  const yellow = filteredCards.filter((card: any) => card.status === 'yellow').length;
  const red = filteredCards.filter((card: any) => card.status === 'red').length;

  return {
    ...snapshot,
    team_data: {
      ...teamData,
      healthCards: filteredCards,
      wins,
      actionItems,
      summary: `Filtered to ${filteredCards.length} active team member(s): ${green} green, ${yellow} yellow, ${red} red. Hidden deleted or inactive agent test employees are excluded from this live view.`,
    },
  };
}

// POST /api/manager/oneone-prep — generate a 1:1 prep for a report
managerRoutes.post('/oneone-prep', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json<{ report_id: string }>();

    if (!body.report_id) {
      return c.json({ error: 'report_id is required', code: 'VALIDATION_ERROR' }, 400);
    }

    const result = await generateOneOnePrep(user.id, body.report_id, user.org_id);
    return c.json(result);
  } catch (err) {
    console.error('Failed to generate 1:1 prep:', err);
    return c.json({ error: 'Failed to generate 1:1 prep', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/manager/oneone-preps — list preps for current user as manager
managerRoutes.get('/oneone-preps', async (c) => {
  try {
    const user = c.get('user');

    const preps = await db
      .select()
      .from(oneonePreps)
      .where(
        and(
          eq(oneonePreps.org_id, user.org_id),
          eq(oneonePreps.manager_id, user.id),
        ),
      )
      .orderBy(desc(oneonePreps.created_at))
      .limit(50);

    return c.json({ preps });
  } catch (err) {
    console.error('Failed to list 1:1 preps:', err);
    return c.json({ error: 'Failed to list 1:1 preps', code: 'INTERNAL_ERROR' }, 500);
  }
});

// PATCH /api/manager/oneone-preps/:id — update status or add notes
managerRoutes.patch('/oneone-preps/:id', async (c) => {
  try {
    const user = c.get('user');
    const prepId = c.req.param('id');
    const body = await c.req.json<{ status?: string; notes?: string }>();

    // Verify ownership
    const [existing] = await db
      .select()
      .from(oneonePreps)
      .where(
        and(
          eq(oneonePreps.id, prepId),
          eq(oneonePreps.manager_id, user.id),
          eq(oneonePreps.org_id, user.org_id),
        ),
      )
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Prep not found', code: 'NOT_FOUND' }, 404);
    }

    const updateData: Record<string, any> = {};
    if (body.status) {
      updateData.status = body.status;
    }
    if (body.notes !== undefined) {
      // Merge notes into existing prep_content
      const currentContent = (existing.prep_content as any) ?? {};
      updateData.prep_content = { ...currentContent, manager_notes: body.notes };
    }

    if (Object.keys(updateData).length === 0) {
      return c.json({ error: 'No update fields provided', code: 'VALIDATION_ERROR' }, 400);
    }

    const [updated] = await db
      .update(oneonePreps)
      .set(updateData)
      .where(eq(oneonePreps.id, prepId))
      .returning();

    return c.json({ prep: updated });
  } catch (err) {
    console.error('Failed to update 1:1 prep:', err);
    return c.json({ error: 'Failed to update 1:1 prep', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/manager/settings — get manager settings for current user
managerRoutes.get('/settings', async (c) => {
  try {
    const user = c.get('user');

    const [settings] = await db
      .select()
      .from(managerSettings)
      .where(
        and(
          eq(managerSettings.user_id, user.id),
          eq(managerSettings.org_id, user.org_id),
        ),
      )
      .limit(1);

    if (!settings) {
      // Return defaults
      return c.json({
        settings: {
          team_pulse_frequency: 'daily',
          oneone_prep_enabled: true,
          burnout_alerts_enabled: true,
          overload_threshold: 6,
          blocked_threshold_hours: 24,
          weekly_digest_enabled: true,
        },
      });
    }

    return c.json({ settings });
  } catch (err) {
    console.error('Failed to get manager settings:', err);
    return c.json({ error: 'Failed to get manager settings', code: 'INTERNAL_ERROR' }, 500);
  }
});

// PATCH /api/manager/settings — update manager settings
managerRoutes.patch('/settings', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json<{
      team_pulse_frequency?: string;
      oneone_prep_enabled?: boolean;
      burnout_alerts_enabled?: boolean;
      overload_threshold?: number;
      blocked_threshold_hours?: number;
      weekly_digest_enabled?: boolean;
    }>();

    // Upsert settings
    const [existing] = await db
      .select({ id: managerSettings.id })
      .from(managerSettings)
      .where(
        and(
          eq(managerSettings.user_id, user.id),
          eq(managerSettings.org_id, user.org_id),
        ),
      )
      .limit(1);

    let settings;
    if (existing) {
      const updateFields: Record<string, any> = {};
      if (body.team_pulse_frequency !== undefined) updateFields.team_pulse_frequency = body.team_pulse_frequency;
      if (body.oneone_prep_enabled !== undefined) updateFields.oneone_prep_enabled = body.oneone_prep_enabled;
      if (body.burnout_alerts_enabled !== undefined) updateFields.burnout_alerts_enabled = body.burnout_alerts_enabled;
      if (body.overload_threshold !== undefined) updateFields.overload_threshold = body.overload_threshold;
      if (body.blocked_threshold_hours !== undefined) updateFields.blocked_threshold_hours = body.blocked_threshold_hours;
      if (body.weekly_digest_enabled !== undefined) updateFields.weekly_digest_enabled = body.weekly_digest_enabled;

      [settings] = await db
        .update(managerSettings)
        .set(updateFields)
        .where(eq(managerSettings.id, existing.id))
        .returning();
    } else {
      [settings] = await db
        .insert(managerSettings)
        .values({
          user_id: user.id,
          org_id: user.org_id,
          team_pulse_frequency: body.team_pulse_frequency ?? 'daily',
          oneone_prep_enabled: body.oneone_prep_enabled ?? true,
          burnout_alerts_enabled: body.burnout_alerts_enabled ?? true,
          overload_threshold: body.overload_threshold ?? 6,
          blocked_threshold_hours: body.blocked_threshold_hours ?? 24,
          weekly_digest_enabled: body.weekly_digest_enabled ?? true,
        })
        .returning();
    }

    return c.json({ settings });
  } catch (err) {
    console.error('Failed to update manager settings:', err);
    return c.json({ error: 'Failed to update manager settings', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/manager/team-health — get latest team health snapshot
managerRoutes.get('/team-health', async (c) => {
  try {
    const user = c.get('user');

    const [snapshot] = await db
      .select()
      .from(teamHealthSnapshots)
      .where(
        and(
          eq(teamHealthSnapshots.org_id, user.org_id),
          eq(teamHealthSnapshots.generated_by, user.id),
        ),
      )
      .orderBy(desc(teamHealthSnapshots.created_at))
      .limit(1);

    if (!snapshot) {
      return c.json({ snapshot: null });
    }

    return c.json({ snapshot: await sanitizeTeamHealthSnapshot(snapshot, user.org_id) });
  } catch (err) {
    console.error('Failed to get team health:', err);
    return c.json({ error: 'Failed to get team health', code: 'INTERNAL_ERROR' }, 500);
  }
});
