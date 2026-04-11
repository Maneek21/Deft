import { db } from './db.js';
import { auditLog } from '@deft/db/schema';

export async function logAuditEvent(params: {
  orgId: string;
  actorType: 'user' | 'agent';
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeState?: any;
  afterState?: any;
  metadata?: any;
}): Promise<void> {
  try {
    await db.insert(auditLog).values({
      org_id: params.orgId,
      actor_type: params.actorType,
      actor_id: params.actorId,
      action: params.action,
      entity_type: params.entityType,
      entity_id: params.entityId,
      before_state: params.beforeState ?? null,
      after_state: params.afterState ?? null,
      metadata: params.metadata ?? null,
    });
  } catch (err) {
    console.error('[audit] Failed to log audit event:', err);
  }
}
