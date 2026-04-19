/**
 * Block 1.5 — ClawHub browse endpoint.
 *
 * Reads from the `clawhub_allowlist` table populated by Block 0.11 cron
 * (VoltAgent awesome-openclaw-skills parser + bundled fallback). Default
 * view is the curated allowlist; the `?advanced=1` query param switches
 * to full ClawHub browse (pass-through to clawhub.ai API) for org admins.
 *
 * We deliberately do NOT expose the install action here — install goes
 * through `POST /api/skills/import` + `POST /api/skills/:id/install` so
 * the SKILL.md sanitizer from Block 0.10 runs between download and
 * attach.
 */
import { Hono } from 'hono';
import { eq, desc, and } from 'drizzle-orm';
import { z } from 'zod';
import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import { clawhubAllowlist, orgMembers, skills } from '@deft/db/schema';

export const clawhubRoutes = new Hono();

clawhubRoutes.get('/browse', async (c) => {
  try {
    const user = c.get('user');
    const advanced = c.req.query('advanced') === '1' || c.req.query('advanced') === 'true';

    // Advanced browse requires admin/owner role.
    if (advanced) {
      const [member] = await db
        .select({ role: orgMembers.role })
        .from(orgMembers)
        .where(eq(orgMembers.user_id, user.id))
        .limit(1);
      if (!member || !['admin', 'owner'].includes(member.role)) {
        return c.json({ error: 'Advanced browse requires admin role', code: 'FORBIDDEN' }, 403);
      }
      // TODO(Block 2): pass-through to clawhub.ai API. For now, return
      // the same allowlist with a flag so the UI can show a disabled
      // advanced tab.
      const rows = await db
        .select()
        .from(clawhubAllowlist)
        .orderBy(desc(clawhubAllowlist.last_seen_at))
        .limit(200);
      return c.json({
        mode: 'advanced',
        note: 'Full ClawHub pass-through lands in Block 2. Showing allowlist for now.',
        entries: rows,
      });
    }

    const rows = await db
      .select()
      .from(clawhubAllowlist)
      .orderBy(desc(clawhubAllowlist.last_seen_at))
      .limit(500);

    return c.json({
      mode: 'allowlist',
      count: rows.length,
      entries: rows,
    });
  } catch (err) {
    console.error('Failed to browse ClawHub:', err);
    return c.json({ error: 'Failed to browse', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ─── POST /import { slug } — materialize an allowlist entry as a skill ─
// Creates a `marketplace`-source skill row so the existing attach flow
// can take over. The row is org-scoped so each org gets its own handle.
const importSchema = z.object({ slug: z.string().min(1).max(128) });

clawhubRoutes.post('/import', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const parsed = importSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid body (expected { slug })', code: 'VALIDATION_ERROR' }, 400);
    }
    const { slug } = parsed.data;

    const [row] = await db
      .select()
      .from(clawhubAllowlist)
      .where(eq(clawhubAllowlist.slug, slug))
      .limit(1);
    if (!row) {
      return c.json({ error: `Slug "${slug}" is not on the ClawHub allowlist`, code: 'NOT_IN_ALLOWLIST' }, 400);
    }

    // Reuse an existing org skill with the same slug if present.
    const [existing] = await db
      .select()
      .from(skills)
      .where(and(eq(skills.org_id, user.org_id), eq(skills.slug, slug)))
      .limit(1);
    if (existing) {
      return c.json({ skill: existing, reused: true });
    }

    const id = crypto.randomUUID();
    const [inserted] = await db
      .insert(skills)
      .values({
        id,
        org_id: user.org_id,
        name: row.description ? `${slug} — ${row.description.slice(0, 40)}` : slug,
        slug,
        description: row.description ?? null,
        source: 'marketplace',
        version: '1.0.0',
        source_url: row.homepage ?? null,
        created_by: user.id,
        agent_config: {} as any,
      })
      .returning();

    return c.json({ skill: inserted, reused: false }, 201);
  } catch (err) {
    console.error('Failed to import ClawHub skill:', err);
    return c.json({ error: 'Failed to import', code: 'INTERNAL_ERROR' }, 500);
  }
});
