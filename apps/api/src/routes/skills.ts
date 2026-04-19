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
import { eq, and, or, isNull, desc, sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import {
  skills,
  agentEmployees,
  agentEmployeeSkills,
} from '@deft/db/schema';
import {
  importOpenclawSkill,
  OpenclawImportError,
} from '../lib/openclaw-skill-import.js';
import { ensureSkillInstalled, removeSkillFromEmployee, installMarketplaceSkillWithSecrets } from '../lib/skill-install.js';
import { setSecretForSkill } from '../lib/skill-secrets.js';

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

const importSchema = z.object({
  source_url: z.string().url(),
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

    const where = sourceFilter
      ? and(
          visibility,
          eq(skills.source, sourceFilter as 'bundled' | 'marketplace' | 'org'),
          eq(skills.is_deleted, false),
        )
      : and(visibility, eq(skills.is_deleted, false));

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

// ─── POST /import — pull a marketplace skill from a URL ───────────────
skillsRoutes.post('/import', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = importSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        400,
      );
    }

    let parsedSkill;
    try {
      parsedSkill = await importOpenclawSkill(parsed.data.source_url);
    } catch (err) {
      if (err instanceof OpenclawImportError) {
        return c.json({ error: err.message, code: 'IMPORT_FAILED' }, 400);
      }
      throw err;
    }

    // Upsert by (source='marketplace', slug). The unique index is
    // (source, org_id, slug) with org_id NULL for marketplace rows, so we
    // key on slug here. If we already have the row, return it rather than
    // duplicating — this lets anyone on any org re-trigger the import.
    const [existing] = await db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.source, 'marketplace'),
          eq(skills.slug, parsedSkill.slug),
          eq(skills.is_deleted, false),
        ),
      )
      .limit(1);
    if (existing) {
      return c.json(existing, 200);
    }

    const [created] = await db
      .insert(skills)
      .values({
        org_id: null,
        name: parsedSkill.name,
        slug: parsedSkill.slug,
        description: parsedSkill.description,
        icon: parsedSkill.icon,
        source: 'marketplace',
        version: parsedSkill.version,
        system_prompt: parsedSkill.system_prompt || null,
        agent_config: parsedSkill.agent_config,
        source_url: parsedSkill.source_url,
      })
      .returning();

    return c.json(created, 201);
  } catch (err) {
    console.error('Failed to import skill:', err);
    return c.json({ error: 'Failed to import skill', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ─── GET /:slug — single skill (org > bundled > marketplace) ──────────
// Also accepts a skill id for cases where the UI has the id already.
skillsRoutes.get('/:slug', async (c) => {
  try {
    const user = c.get('user');
    const slugOrId = c.req.param('slug');

    // Try id match first (cheap if it isn't one).
    const [byId] = await db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.id, slugOrId),
          eq(skills.is_deleted, false),
          or(isNull(skills.org_id), eq(skills.org_id, user.org_id)),
        ),
      )
      .limit(1);
    if (byId) return c.json(byId);

    // Slug fallback with source precedence: org > bundled > marketplace.
    const candidates = await db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.slug, slugOrId),
          eq(skills.is_deleted, false),
          or(isNull(skills.org_id), eq(skills.org_id, user.org_id)),
        ),
      );

    const order: Array<'org' | 'bundled' | 'marketplace'> = [
      'org',
      'bundled',
      'marketplace',
    ];
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

    // Resolve to a single skill (same precedence as GET /:slug).
    const candidates = await db
      .select({ id: skills.id, source: skills.source })
      .from(skills)
      .where(
        and(
          or(eq(skills.id, slugOrId), eq(skills.slug, slugOrId)),
          eq(skills.is_deleted, false),
          or(isNull(skills.org_id), eq(skills.org_id, user.org_id)),
        ),
      );
    const order: Array<'org' | 'bundled' | 'marketplace'> = [
      'org',
      'bundled',
      'marketplace',
    ];
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

// ─── POST /:id/install — install on an agent employee ────────────────
// Thin wrapper around `ensureSkillInstalled`. The library UI posts here
// from the Install modal. For bundled/org skills this is the same path the
// JIT installer takes on first invocation; for marketplace skills the
// helper returns `requires_approval` and we respond 202 so the UI can
// surface the security prompt on the next load.
const installSchema = z.object({
  agent_employee_id: z.string().min(1),
});

skillsRoutes.post('/:id/install', async (c) => {
  try {
    const user = c.get('user');
    const skillId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = installSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        400,
      );
    }

    // Confirm the skill is visible to this org.
    const [skill] = await db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.id, skillId),
          eq(skills.is_deleted, false),
          or(isNull(skills.org_id), eq(skills.org_id, user.org_id)),
        ),
      )
      .limit(1);
    if (!skill) {
      return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
    }

    // Confirm the employee belongs to this org.
    const [employee] = await db
      .select({ id: agentEmployees.id })
      .from(agentEmployees)
      .where(
        and(
          eq(agentEmployees.id, parsed.data.agent_employee_id),
          eq(agentEmployees.org_id, user.org_id),
        ),
      )
      .limit(1);
    if (!employee) {
      return c.json(
        { error: 'Agent employee not found', code: 'NOT_FOUND' },
        404,
      );
    }

    const result = await ensureSkillInstalled(employee.id, skillId);
    // Marketplace skills come back as `requires_approval` — caller should
    // present the security prompt and re-POST once the user confirms.
    // Task 4.15 added a `requires_user_decision` status for trigger
    // conflicts; surface both shapes as 202 so the UI can branch.
    if (
      typeof result === 'object' &&
      'status' in result &&
      (result.status === 'requires_approval' ||
        (result as { status?: string }).status === 'requires_user_decision')
    ) {
      return c.json(result, 202);
    }
    return c.json(result);
  } catch (err) {
    console.error('Failed to install skill:', err);
    return c.json({ error: 'Failed to install skill', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ─── POST /:id/install/marketplace — Block 1.6 pre-deploy flow ─────────
// Runs secret resolution (OAuth → skill_secrets) before install. Returns
// `missing_secrets` with the key list so the UI can prompt; re-submit
// after POSTing to /api/skills/:id/secrets.
skillsRoutes.post('/:id/install/marketplace', async (c) => {
  try {
    const user = c.get('user');
    const skillId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = installSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        400,
      );
    }
    const [employee] = await db
      .select({ id: agentEmployees.id })
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, parsed.data.agent_employee_id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (!employee) {
      return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);
    }
    const result = await installMarketplaceSkillWithSecrets(employee.id, skillId);
    if (result.status === 'missing_secrets') {
      return c.json(result, 202);
    }
    if (result.status === 'installed' || result.status === 'already_installed') {
      return c.json(result);
    }
    return c.json(result, 409);
  } catch (err) {
    console.error('Failed marketplace skill install:', err);
    return c.json({ error: 'Failed to install', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ─── POST /:id/secrets — save a raw skill secret (Block 1.6) ───────────
const secretSaveSchema = z.object({
  key_name: z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/),
  value: z.string().min(1).max(8192),
});

skillsRoutes.post('/:id/secrets', async (c) => {
  try {
    const user = c.get('user');
    const skillId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = secretSaveSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
    }
    // Confirm the skill is org-visible.
    const [skill] = await db
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.id, skillId), or(isNull(skills.org_id), eq(skills.org_id, user.org_id))))
      .limit(1);
    if (!skill) return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);

    await setSecretForSkill({
      org_id: user.org_id,
      skill_id: skillId,
      key_name: parsed.data.key_name,
      value: parsed.data.value,
      created_by: user.id,
    });
    return c.json({ saved: true, key_name: parsed.data.key_name }, 201);
  } catch (err) {
    console.error('Failed to save skill secret:', err);
    return c.json({ error: 'Failed to save secret', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ─── DELETE /:id/install?agent_employee_id=… — detach (Block 1.3) ─────
// Removes the agent_employee_skills junction row and fires a live
// `gateway.skills.remove(slug)` for connected openclaw employees.
skillsRoutes.delete('/:id/install', async (c) => {
  try {
    const user = c.get('user');
    const skillId = c.req.param('id');
    const employeeId = c.req.query('agent_employee_id');
    if (!employeeId) {
      return c.json(
        { error: 'agent_employee_id query param required', code: 'VALIDATION_ERROR' },
        400,
      );
    }

    // Ownership check: employee must belong to caller's org.
    const [employee] = await db
      .select({ id: agentEmployees.id })
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, employeeId), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (!employee) {
      return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);
    }

    const result = await removeSkillFromEmployee(employeeId, skillId);
    if (!result.removed && result.reason === 'not_installed') {
      return c.json({ removed: false, reason: 'not_installed' }, 200);
    }
    if (!result.removed) {
      return c.json({ error: 'Skill or employee not found', code: 'NOT_FOUND' }, 404);
    }
    return c.json({ removed: true });
  } catch (err) {
    console.error('Failed to remove skill:', err);
    return c.json({ error: 'Failed to remove skill', code: 'INTERNAL_ERROR' }, 500);
  }
});

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
