import { Hono } from 'hono';
import { db } from '../lib/db.js';
import { auditLog } from '@deft/db/schema';
import { eq, and, desc, notInArray } from 'drizzle-orm';
import type { AuthUser } from '../middleware/auth.js';
import { assertModuleAuditReadAccess, humanModuleActor } from '../lib/module-service.js';
import { isModuleError } from '../lib/module-errors.js';

export const auditRoutes = new Hono();

const MODULE_AUDIT_ENTITY_TYPES = ['module_installation', 'module_record'] as const;

function safeModuleRecordMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const metadata = value as Record<string, unknown>;
  return Object.fromEntries(
    ['changed_fields', 'unset_fields', 'relation_fields', 'destructive']
      .filter((key) => Object.hasOwn(metadata, key))
      .map((key) => [key, metadata[key]]),
  );
}

auditRoutes.get('/', async (c) => {
  const user = c.get('user') as AuthUser;
  const entityType = c.req.query('entity_type');
  const entityId = c.req.query('entity_id');
  const actorType = c.req.query('actor_type');
  const actorId = c.req.query('actor_id');
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);

  const isModuleEntity = entityType === 'module_installation' || entityType === 'module_record';
  if (isModuleEntity) {
    if (!entityId) {
      return c.json({
        error: 'Module audit requests must identify one entity',
        code: 'MODULE_VALIDATION_ERROR',
      }, 400);
    }
    try {
      await assertModuleAuditReadAccess(
        humanModuleActor({
          orgId: user.org_id,
          userId: user.id,
          role: user.role ?? 'member',
          source: 'rest',
        }),
        entityType,
        entityId,
      );
    } catch (error) {
      if (isModuleError(error)) {
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      throw error;
    }
  }

  const conditions: any[] = [eq(auditLog.org_id, user.org_id)];
  // General audit browsing is not a back door around module lifecycle checks.
  // Module rows are only included by the targeted, gated path above.
  if (!isModuleEntity) {
    conditions.push(notInArray(auditLog.entity_type, [...MODULE_AUDIT_ENTITY_TYPES]));
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

  if (entityType === 'module_record') {
    // before_state/after_state can contain values from adjacent integrations
    // (for example a linked task id). The record activity surface needs only a
    // narrow, non-secret projection and must not inherit those permissions.
    return c.json(events.map((event) => ({
      id: event.id,
      action: event.action,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      actor_type: event.actor_type,
      actor_id: event.actor_id,
      metadata: safeModuleRecordMetadata(event.metadata),
      created_at: event.created_at,
    })));
  }

  return c.json(events);
});
