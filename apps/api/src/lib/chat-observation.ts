import { and, eq, sql } from 'drizzle-orm';
import { jobQueue, messageObservations } from '@deft/db/schema';
import { db } from './db.js';
import { toPlainText } from './plain-text.js';

export const CHAT_OBSERVATION_VERSION = 1;
export const OBSERVE_CHAT_MESSAGE_JOB = 'observe-chat-message';

export function hasNoTaskDirective(content: string): boolean {
  const plain = toPlainText(content).toLowerCase().replace(/\s+/g, ' ').trim();
  return /\b(no task|no tasks|not a task|no actual task|not tasks?|do not create (?:a |any |individual )?(?:tasks?|todos?|tickets?)|don't create (?:a |any |individual )?(?:tasks?|todos?|tickets?)|dont create (?:a |any |individual )?(?:tasks?|todos?|tickets?))\b/.test(plain) ||
    /\b(?:hold off|wait|not yet|later|after this is settled|once this is settled)\b.{0,80}\b(?:tasks?|todos?|tickets?)\b/.test(plain) ||
    /\b(?:tasks?|todos?|tickets?)\b.{0,80}\b(?:not yet|later|after this is settled|once this is settled|hold off)\b/.test(plain);
}

export function hasNoKnowledgeDirective(content: string): boolean {
  const plain = toPlainText(content).toLowerCase().replace(/\s+/g, ' ').trim();
  return /\b(don't save|dont save|do not save|no one should save|no memory|no company memory|don't remember|dont remember|do not remember|nothing to capture|nothing to save|do not capture|don't capture|dont capture)\b/.test(plain) ||
    /\b(?:keep|leave)\s+(?:this|that|it)?\s*(?:only\s+)?in\s+chat\b/.test(plain) ||
    /\bignore\s+(?:this|that|the)\s+(?:for\s+)?(?:knowledge|memory|wiki|context)\b/.test(plain);
}

export function explicitObservationIgnoreReason(content: string): string | null {
  const plain = toPlainText(content).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!plain) return 'empty_content';

  if (
    /\b(no action needed|no action required|no follow up needed|nothing to do)\b/.test(plain) ||
    /\b(joke only|not the task)\b/.test(plain) ||
    hasNoTaskDirective(content) ||
    hasNoKnowledgeDirective(content) ||
    /\b(ignore this|just thinking aloud|thinking out loud|fyi only|for visibility only)\b/.test(plain)
  ) {
    return 'explicit_no_action';
  }

  const ack = plain.replace(/[.!?]+$/g, '');
  if (/^(ok|okay|k|thanks|thank you|cool|nice|great|sounds good|got it|noted|roger|yes|no|hi|hey|hello)$/.test(ack)) {
    return 'low_signal_ack';
  }

  if (plain.length < 8) return 'low_signal_short';
  return null;
}

export async function enqueueChatObservation(params: {
  orgId: string;
  messageId: string;
  spaceId: string;
  userId: string;
  observationVersion?: number;
}): Promise<{ enqueued: boolean; observationId?: string }> {
  const observationVersion = params.observationVersion ?? CHAT_OBSERVATION_VERSION;

  return db.transaction(async (tx) => {
    const [observation] = await tx
      .insert(messageObservations)
      .values({
        org_id: params.orgId,
        message_id: params.messageId,
        space_id: params.spaceId,
        user_id: params.userId,
        observation_version: observationVersion,
        status: 'queued',
      })
      .onConflictDoNothing({
        target: [messageObservations.message_id, messageObservations.observation_version],
      })
      .returning({ id: messageObservations.id });

    if (!observation) {
      return { enqueued: false };
    }

    await tx.insert(jobQueue).values({
      queue: 'agent-jobs',
      name: OBSERVE_CHAT_MESSAGE_JOB,
      data: {
        orgId: params.orgId,
        messageId: params.messageId,
        spaceId: params.spaceId,
        userId: params.userId,
        observationVersion,
      },
      status: 'pending',
      max_attempts: 5,
      run_at: new Date(),
    });

    return { enqueued: true, observationId: observation.id };
  });
}

export async function enqueueMissingChatObservations(params: {
  orgId: string;
  limit?: number;
}): Promise<number> {
  const limit = Math.min(Math.max(params.limit ?? 500, 1), 2000);
  const rows = await db.execute(sql<{
    id: string;
    org_id: string;
    space_id: string;
    user_id: string;
  }>`
    SELECT m.id, m.org_id, m.space_id, m.user_id
    FROM messages m
    LEFT JOIN message_observations mo
      ON mo.message_id = m.id
     AND mo.observation_version = ${CHAT_OBSERVATION_VERSION}
    WHERE m.org_id = ${params.orgId}
      AND m.is_deleted = false
      AND mo.id IS NULL
    ORDER BY m.created_at ASC
    LIMIT ${limit}
  `);

  const resultRows = (rows as any).rows ?? rows;
  let count = 0;
  for (const row of resultRows) {
    const result = await enqueueChatObservation({
      orgId: row.org_id,
      messageId: row.id,
      spaceId: row.space_id,
      userId: row.user_id,
    });
    if (result.enqueued) count += 1;
  }
  return count;
}

export async function markObservationFailedFromJobData(params: {
  data: unknown;
  retrying: boolean;
  error: string;
}): Promise<void> {
  if (!params.data || typeof params.data !== 'object') return;
  const data = params.data as Record<string, unknown>;
  if (typeof data.messageId !== 'string' || typeof data.orgId !== 'string') return;
  const observationVersion = typeof data.observationVersion === 'number'
    ? data.observationVersion
    : CHAT_OBSERVATION_VERSION;

  await db
    .update(messageObservations)
    .set({
      status: params.retrying ? 'retrying' : 'failed',
      last_error: params.error.slice(0, 2000),
      completed_at: params.retrying ? null : new Date(),
      updated_at: new Date(),
    })
    .where(and(
      eq(messageObservations.org_id, data.orgId),
      eq(messageObservations.message_id, data.messageId),
      eq(messageObservations.observation_version, observationVersion),
    ));
}
