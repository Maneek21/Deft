// docs/superpowers/audits/agent-byoa/lib/db-helpers.ts
import { eq, and, desc, gte } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';

export async function findRecentAgentActions(opts: {
  agentEmployeeId: string;
  source?: string;
  action?: string;
  sinceMs?: number;
  status?: 'pending' | 'approved' | 'rejected' | 'executed' | 'error';
}) {
  const conds = [eq(schema.agentActions.agent_employee_id, opts.agentEmployeeId)];
  if (opts.source) conds.push(eq(schema.agentActions.source, opts.source));
  if (opts.action) conds.push(eq(schema.agentActions.action, opts.action));
  if (opts.status) conds.push(eq(schema.agentActions.approval_status, opts.status));
  if (opts.sinceMs) conds.push(gte(schema.agentActions.created_at, new Date(Date.now() - opts.sinceMs)));
  return db.select().from(schema.agentActions).where(and(...conds)).orderBy(desc(schema.agentActions.created_at)).limit(20);
}

export async function waitForAgentAction(opts: {
  agentEmployeeId: string;
  source: string;
  action?: string;
  sinceMs?: number;
  timeoutMs?: number;
}) {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    const rows = await findRecentAgentActions({ ...opts, sinceMs: opts.sinceMs ?? 30_000 });
    if (rows.length) return rows[0]!;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`waitForAgentAction timed out for source=${opts.source} action=${opts.action ?? '*'}`);
}

export async function seedSyntheticEvent(orgId: string, type: string) {
  await db.insert(schema.events).values({
    org_id: orgId,
    type,
    source: 'github',
    payload: { harness: true, ts: Date.now() },
    occurred_at: new Date(),
  } as any);
}

export async function getEmployeeRow(employeeId: string) {
  const [row] = await db.select().from(schema.agentEmployees)
    .where(eq(schema.agentEmployees.id, employeeId)).limit(1);
  return row ?? null;
}

export async function setEmployee(employeeId: string, patch: Partial<typeof schema.agentEmployees.$inferInsert>) {
  await db.update(schema.agentEmployees).set(patch).where(eq(schema.agentEmployees.id, employeeId));
}
