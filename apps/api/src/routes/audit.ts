import { Hono } from 'hono';
import { db } from '../lib/db.js';
import { auditLog } from '@deft/db/schema';
import { eq, and, desc, notInArray } from 'drizzle-orm';

export const auditRoutes = new Hono();

auditRoutes.get('/', async (c) => {
  const user = c.get('user');
  const entityType = c.req.query('entity_type');
  const entityId = c.req.query('entity_id');
  const actorType = c.req.query('actor_type');
  const actorId = c.req.query('actor_id');
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);

  const conditions: any[] = [eq(auditLog.org_id, user.org_id)];
  if (user.role === 'guest') {
    conditions.push(notInArray(auditLog.entity_type, ['module_installation', 'module_record']));
  }

  if (entityType) conditions.push(eq(auditLog.entity_type, entityType));
  if (entityId) conditions.push(eq(auditLog.entity_id, entityId));
  if (actorType) conditions.push(eq(auditLog.actor_type, actorType));
  if (actorId) conditions.push(eq(auditLog.actor_id, actorId));

  const events = await db
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.created_at))
    .limit(limit);

  return c.json(events);
});
