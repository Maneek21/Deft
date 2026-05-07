/**
 * Phase 4 Task 4.13 — /api/skills library + marketplace import.
 *
 * Scopes:
 *   - `bundled`     — first-party skills, org_id NULL, visible to every org
 *   - `marketplace` — imported from clawhub.ai / similar, org_id NULL,
 *                     also visible to every org but install requires an
 *                     explicit security prompt (handled in the UI).
 *   - `org`         — user-authored custom skills, scoped to the caller's org.
 *
 * Route shape (mounted at /api/skills by index.ts):
 *   GET    /                    — list (optional ?source filter)
 *   POST   /                    — create org skill
 *   POST   /import              — import a marketplace skill from a URL
 *   GET    /:slug               — single skill by slug (org > bundled > marketplace)
 *   GET    /:slug/stats         — install + project-attach counts
 *   PATCH  /:id                 — edit org skill (by id; org skills only)
 *   DELETE /:id                 — soft delete org skill
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, or, isNull, ne, desc, sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import {
  skills,
  agentEmployees,
  agentEmployeeSkills,
} from '@deft/db/schema';
export const skillsRoutes = new Hono();

// ─── Schemas ──────────────────────────────────────────────────────────
const createSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  agent_config: z.record(z.string(), z.unknown()).optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  agent_config: z.record(z.string(), z.unknown()).optional(),
  version: z.string().max(32).optional(),
});

function toSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// ─── GET / — list skills visible to this org ─────────────────────────
skillsRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const sourceFilter = c.req.query('source');

    // Visibility: bundled + marketplace (org_id NULL) plus rows for this org.
    const visibility = or(
      isNull(skills.org_id),
      eq(skills.org_id, user.org_id),
    );

    // Always exclude marketplace skills — self-hosted v1 only exposes bundled + org.
    const noMarketplace = ne(skills.source, 'marketplace');

    const where = sourceFilter
      ? and(
          visibility,
          noMarketplace,
          eq(skills.source, sourceFilter as 'bundled' | 'org'),
          eq(skills.is_deleted, false),
        )
      : and(visibility, noMarketplace, eq(skills.is_deleted, false));

    const rows = await db
      .select()
      .from(skills)
      .where(where)
      .orderBy(desc(skills.created_at));

    return c.json(rows);
  } catch (err) {
    console.error('Failed to list skills:', err);
    return c.json({ error: 'Failed to list skills', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ─── POST / — create org skill ────────────────────────────────────────
skillsRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        400,
      );
    }

    const data = parsed.data;
    const slug = (data.slug ?? toSlug(data.name)).trim();
    if (!slug) {
      return c.json({ error: 'Invalid slug', code: 'VALIDATION_ERROR' }, 400);
    }

    // Prevent dupes within this org.
    const [existing] = await db
      .select({ id: skills.id })
      .from(skills)
      .where(
        and(
          eq(skills.source, 'org'),
          eq(skills.org_id, user.org_id),
          eq(skills.slug, slug),
          eq(skills.is_deleted, false),
        ),
      )
      .limit(1);
    if (existing) {
      return c.json(
        { error: 'Slug already in use for your org', code: 'CONFLICT' },
        409,
      );
    }

    const [created] = await db
      .insert(skills)
      .values({
        org_id: user.org_id,
        name: data.name,
        slug,
        description: data.description ?? null,
        icon: data.icon ?? null,
        source: 'org',
        version: '1.0.0',
        agent_config: data.agent_config ?? {},
        created_by: user.id,
      })
      .returning();

    return c.json(created, 201);
  } catch (err) {
    console.error('Failed to create skill:', err);
    return c.json({ error: 'Failed to create skill', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /import retired alongside the ClawHub surface — self-hosted v1 only
// exposes bundled + org-authored skills. A fresh marketplace import path will
// land when the cooperative knowledge stack returns.

// ─── GET /:slug — single skill (org > bundled > marketplace) ──────────
// Also accepts a skill id for cases where the UI has the id already.
skillsRoutes.get('/:slug', async (c) => {
  try {
    const user = c.get('user');
    const slugOrId = c.req.param('slug');

    const visibilityAndNotMarketplace = and(
      or(isNull(skills.org_id), eq(skills.org_id, user.org_id)),
      ne(skills.source, 'marketplace'),
    );

    // Try id match first (cheap if it isn't one).
    const [byId] = await db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.id, slugOrId),
          eq(skills.is_deleted, false),
          visibilityAndNotMarketplace,
        ),
      )
      .limit(1);
    if (byId) return c.json(byId);

    // Slug fallback with source precedence: org > bundled.
    const candidates = await db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.slug, slugOrId),
          eq(skills.is_deleted, false),
          visibilityAndNotMarketplace,
        ),
      );

    const order: Array<'org' | 'bundled'> = ['org', 'bundled'];
    for (const src of order) {
      const hit = candidates.find((s) => s.source === src);
      if (hit) return c.json(hit);
    }

    return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
  } catch (err) {
    console.error('Failed to get skill:', err);
    return c.json({ error: 'Failed to get skill', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ─── GET /:slug/stats — install counts across the junctions ──────────
skillsRoutes.get('/:slug/stats', async (c) => {
  try {
    const user = c.get('user');
    const slugOrId = c.req.param('slug');

    // Resolve to a single skill (same precedence as GET /:slug). Marketplace hidden in v1.
    const candidates = await db
      .select({ id: skills.id, source: skills.source })
      .from(skills)
      .where(
        and(
          or(eq(skills.id, slugOrId), eq(skills.slug, slugOrId)),
          eq(skills.is_deleted, false),
          or(isNull(skills.org_id), eq(skills.org_id, user.org_id)),
          ne(skills.source, 'marketplace'),
        ),
      );
    const order: Array<'org' | 'bundled'> = ['org', 'bundled'];
    let target: { id: string; source: string } | undefined;
    for (const src of order) {
      const hit = candidates.find((s) => s.source === src);
      if (hit) {
        target = hit;
        break;
      }
    }
    if (!target) {
      return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
    }

    const [agentRow] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(agentEmployeeSkills)
      .where(eq(agentEmployeeSkills.skill_id, target.id));

    return c.json({
      installed_on_agents: Number(agentRow?.cnt ?? 0),
      attached_to_projects: 0, // project_skills table retired in Task 14
    });
  } catch (err) {
    console.error('Failed to get skill stats:', err);
    return c.json({ error: 'Failed to get skill stats', code: 'INTERNAL_ERROR' }, 500);
  }
});

// v1 self-hosted reframe: install / install/marketplace / secrets /
// detach routes removed — skills-as-installable-artifacts is gone.
// `agent_employee_skills` junction may return as a capability-scoping
// feature; when it does it lives behind its own focused endpoint.

// ─── PATCH /:id — edit (org skills only, must be caller's org) ────────
skillsRoutes.patch('/:id', async (c) => {
  try {
    const user = c.get('user');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        400,
      );
    }

    const [existing] = await db
      .select()
      .from(skills)
      .where(eq(skills.id, id))
      .limit(1);
    if (!existing || existing.is_deleted) {
      return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
    }
    if (existing.source !== 'org' || existing.org_id !== user.org_id) {
      return c.json(
        {
          error: 'Only org-authored skills can be edited',
          code: 'FORBIDDEN',
        },
        403,
      );
    }

    const updates: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.description !== undefined)
      updates.description = parsed.data.description;
    if (parsed.data.icon !== undefined) updates.icon = parsed.data.icon;
    if (parsed.data.agent_config !== undefined)
      updates.agent_config = parsed.data.agent_config;
    if (parsed.data.version !== undefined) updates.version = parsed.data.version;

    if (Object.keys(updates).length === 0) {
      return c.json(existing);
    }

    const [updated] = await db
      .update(skills)
      .set(updates)
      .where(eq(skills.id, id))
      .returning();

    return c.json(updated);
  } catch (err) {
    console.error('Failed to update skill:', err);
    return c.json({ error: 'Failed to update skill', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ─── DELETE /:id — soft delete (org skills only) ──────────────────────
skillsRoutes.delete('/:id', async (c) => {
  try {
    const user = c.get('user');
    const id = c.req.param('id');

    const [existing] = await db
      .select()
      .from(skills)
      .where(eq(skills.id, id))
      .limit(1);
    if (!existing || existing.is_deleted) {
      return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
    }
    if (existing.source !== 'org' || existing.org_id !== user.org_id) {
      return c.json(
        {
          error: 'Only org-authored skills can be deleted',
          code: 'FORBIDDEN',
        },
        403,
      );
    }

    await db
      .update(skills)
      .set({ is_deleted: true })
      .where(eq(skills.id, id));

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to delete skill:', err);
    return c.json({ error: 'Failed to delete skill', code: 'INTERNAL_ERROR' }, 500);
  }
});
