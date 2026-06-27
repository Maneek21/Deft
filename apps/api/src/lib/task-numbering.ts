import { sql } from 'drizzle-orm';
import { db } from './db.js';

type DbExecutor = {
  execute: typeof db.execute;
};

function resultRows(result: unknown): Array<Record<string, unknown>> {
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ??
    (Array.isArray(result) ? result : [])) as Array<Record<string, unknown>>;
}

/**
 * Reserve one or more task numbers for a project while repairing stale
 * counters. Some seeds and legacy code can leave projects.task_counter behind
 * the actual max(tasks.number), so every write path should reserve through
 * this helper instead of doing task_counter + 1 directly.
 */
export async function reserveTaskNumberRange(params: {
  projectId: string;
  orgId: string;
  count?: number;
  executor?: DbExecutor;
}): Promise<{ firstNumber: number; lastNumber: number }> {
  const count = params.count ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('reserveTaskNumberRange count must be a positive integer');
  }

  const executor = params.executor ?? db;
  const result = await executor.execute(sql`
    UPDATE projects
    SET task_counter = GREATEST(
      task_counter,
      (
        SELECT COALESCE(MAX(number), 0)
        FROM tasks
        WHERE project_id = ${params.projectId}
      )
    ) + ${count}
    WHERE id = ${params.projectId}
      AND org_id = ${params.orgId}
    RETURNING task_counter
  `);
  const first = resultRows(result)[0];
  if (!first) {
    throw new Error('Project not found while reserving task number');
  }

  const lastNumber = Number(first.task_counter);
  return {
    firstNumber: lastNumber - count + 1,
    lastNumber,
  };
}

export async function reserveNextTaskNumber(params: {
  projectId: string;
  orgId: string;
  executor?: DbExecutor;
}): Promise<number> {
  const range = await reserveTaskNumberRange({
    projectId: params.projectId,
    orgId: params.orgId,
    executor: params.executor,
  });
  return range.lastNumber;
}

export async function reconcileProjectTaskCountersForOrg(
  orgId: string,
  executor: DbExecutor = db,
): Promise<Array<{ id: string; task_counter: number }>> {
  const result = await executor.execute(sql`
    UPDATE projects AS p
    SET task_counter = GREATEST(p.task_counter, existing.max_number)
    FROM (
      SELECT project_id, COALESCE(MAX(number), 0) AS max_number
      FROM tasks
      WHERE org_id = ${orgId}
      GROUP BY project_id
    ) AS existing
    WHERE p.id = existing.project_id
      AND p.org_id = ${orgId}
      AND p.task_counter < existing.max_number
    RETURNING p.id, p.task_counter
  `);
  return resultRows(result).map((row) => ({
    id: String(row.id),
    task_counter: Number(row.task_counter),
  }));
}
