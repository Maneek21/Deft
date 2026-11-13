import { Hono } from 'hono';
import { db } from '../lib/db.js';
import { agentEmployees, auditLog, orgMembers, users } from '@deft/db/schema';
import { eq, and, desc, inArray, notInArray } from 'drizzle-orm';
import type { AuthUser } from '../middleware/auth.js';
import { assertModuleAuditReadAccess, humanModuleActor } from '../lib/module-service.js';
import { isModuleError } from '../lib/module-errors.js';
import { OrgMembershipError, requireOrgAdminOrOwner } from '../lib/org-membership.js';
import { loadMessagesForMember } from '../lib/space-membership.js';

export const auditRoutes = new Hono();

const MODULE_AUDIT_ENTITY_TYPES = ['module_installation', 'module_record'] as const;

function pickFields(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]));
}

/**
 * A message entry keeps its text only when the viewer can read the message's
 * space. Otherwise the entry keeps who, when, the action, the message id and
 * space id, and drops everything else from its states and metadata.
 */
async function projectMessageEntries<T extends typeof auditLog.$inferSelect>(events: T[], user: AuthUser) {
  const messageIds = events.filter((event) => event.entity_type === 'message').map((event) => event.entity_id);
  const readable = await loadMessagesForMember(messageIds, user.id, user.org_id);
  return events.map((event) => {
    if (event.entity_type !== 'message' || readable.has(event.entity_id)) return event;
    return {
      ...event,
      before_state: pickFields(event.before_state, ['message_id', 'space_id']),
      after_state: pickFields(event.after_state, ['message_id', 'space_id']),
      metadata: pickFields(event.metadata, ['action_id']),
      content_omitted: true,
    };
  });
}

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

  // Browsing the workspace log is for active owners and admins. The targeted
  // module path above carries its own access rule.
  if (!isModuleEntity) {
    try {
      await requireOrgAdminOrOwner(user.org_id, user.id);
    } catch (error) {
      if (error instanceof OrgMembershipError) {
        return c.json({ error: error.message, code: error.code }, error.status as 403);
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
    const employeeIds = [...new Set(events
      .filter((event) => event.actor_type === 'agent_employee')
      .map((event) => event.actor_id))];
    const userIds = [...new Set(events
      .filter((event) => event.actor_type === 'human' || event.actor_type === 'defty' || event.actor_type === 'user')
      .map((event) => event.actor_id))];
    const [employeeActors, userActors] = await Promise.all([
      employeeIds.length > 0
        ? db.select({ id: agentEmployees.id, name: agentEmployees.name })
          .from(agentEmployees)
          .where(and(eq(agentEmployees.org_id, user.org_id), inArray(agentEmployees.id, employeeIds)))
        : [],
      userIds.length > 0
        ? db.select({ id: users.id, name: users.name })
          .from(users)
          .innerJoin(orgMembers, and(
            eq(orgMembers.user_id, users.id),
            eq(orgMembers.org_id, user.org_id),
            eq(orgMembers.is_active, true),
          ))
          .where(inArray(users.id, userIds))
        : [],
    ]);
    const actorNames = new Map<string, string>([
      ...employeeActors.map((actor) => [`agent_employee:${actor.id}`, actor.name] as const),
      ...userActors.flatMap((actor) => [
        [`human:${actor.id}`, actor.name] as const,
        [`defty:${actor.id}`, actor.name] as const,
        [`user:${actor.id}`, actor.name] as const,
      ]),
    ]);
    return c.json(events.map((event) => ({
      id: event.id,
      action: event.action,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      actor_type: event.actor_type,
      actor_id: event.actor_id,
      actor_name: actorNames.get(`${event.actor_type}:${event.actor_id}`) ?? null,
      metadata: safeModuleRecordMetadata(event.metadata),
      created_at: event.created_at,
    })));
  }

  return c.json(await projectMessageEntries(events, user));
});
