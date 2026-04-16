// Handler: skill-update-check — daily cron that surfaces skill version
// upgrades to the employee owner.
//
// For every row in `agent_employee_skills` where the installed_version
// differs from the current `skills.version`, we emit exactly one
// `skill_update_available` notification per (employee, skill,
// target_version) tuple. Dedup is a SQL-side lookup on
// notifications.metadata — an already-created, still-unread row short-
// circuits the insert. A user-acknowledged row (is_read=true) re-
// surfaces only when the target_version changes (ie the skill bumps
// again), satisfying the "re-surfaces on next minor version" rule.
//
// Version compare intentionally uses plain string inequality. Lexi-
// cographic semver is fine for now — see Task 4.14 plan — and any
// bump produces a distinct string, which is all we need to drive dedup.
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { notifications } from '@deft/db/schema';
import { sql } from 'drizzle-orm';

interface PendingUpdate {
  agent_employee_id: string;
  skill_id: string;
  installed_version: string;
  target_version: string;
  skill_name: string;
  skill_slug: string;
  owner_user_id: string;
  org_id: string;
  employee_name: string;
}

export async function handleSkillUpdateCheck(_job: JobData): Promise<void> {
  const queryResult = await db.execute(sql`
    SELECT
      aes.agent_employee_id,
      aes.skill_id,
      aes.installed_version,
      s.version        AS target_version,
      s.name           AS skill_name,
      s.slug           AS skill_slug,
      ae.user_id       AS owner_user_id,
      ae.org_id        AS org_id,
      ae.name          AS employee_name
    FROM agent_employee_skills aes
    JOIN skills s ON s.id = aes.skill_id AND s.is_deleted = false
    JOIN agent_employees ae ON ae.id = aes.agent_employee_id
    WHERE aes.installed_version <> s.version
      AND ae.is_active = true
  `);

  // drizzle's db.execute can return either a QueryResult-shaped object or
  // an array of rows depending on the driver; coerce via `unknown` since
  // neither branch trivially matches our domain row type.
  const resultAny = queryResult as unknown as
    | { rows?: PendingUpdate[] }
    | PendingUpdate[];
  const pending: PendingUpdate[] = Array.isArray(resultAny)
    ? resultAny
    : (resultAny.rows ?? []);

  if (pending.length === 0) {
    console.log('[skill-update-check] No pending skill updates');
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const row of pending) {
    try {
      // Dedup: skip if an unread notification already exists for this
      // exact (employee, skill, target_version) tuple. A read/dismissed
      // row is treated as acknowledged and will not block the next
      // version bump (which yields a different target_version and
      // therefore a different dedup key).
      const existing = await db.execute(sql`
        SELECT id
        FROM notifications
        WHERE user_id = ${row.owner_user_id}
          AND type = 'skill_update_available'
          AND metadata->>'agent_employee_id' = ${row.agent_employee_id}
          AND metadata->>'skill_id' = ${row.skill_id}
          AND metadata->>'target_version' = ${row.target_version}
          AND is_read = false
        LIMIT 1
      `);

      const existingAny = existing as unknown as
        | { rows?: unknown[] }
        | unknown[];
      const existingRows: unknown[] = Array.isArray(existingAny)
        ? existingAny
        : (existingAny.rows ?? []);
      if (existingRows.length > 0) {
        skipped++;
        continue;
      }

      await db.insert(notifications).values({
        org_id: row.org_id,
        user_id: row.owner_user_id,
        type: 'skill_update_available',
        title: `Skill update available: ${row.skill_name}`,
        body: `${row.employee_name} has v${row.installed_version} installed; v${row.target_version} is available.`,
        link: `/skills/${row.skill_slug}?agent=${row.agent_employee_id}`,
        metadata: {
          agent_employee_id: row.agent_employee_id,
          skill_id: row.skill_id,
          current_version: row.installed_version,
          target_version: row.target_version,
        },
      });
      created++;
    } catch (err) {
      console.error(
        `[skill-update-check] Failed to create notification for employee=${row.agent_employee_id} skill=${row.skill_id}:`,
        (err as Error).message,
      );
    }
  }

  console.log(
    `[skill-update-check] Complete — pending=${pending.length} created=${created} skipped=${skipped}`,
  );
}
