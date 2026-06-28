import { and, eq } from 'drizzle-orm';
import {
  messageClassifications,
  messageObservations,
  messages,
} from '@deft/db/schema';
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { classifyMessage } from '../../lib/classifier.js';
import { enqueue, QUEUE_NAMES } from '../../lib/queues.js';
import {
  CHAT_OBSERVATION_VERSION,
  explicitObservationIgnoreReason,
} from '../../lib/chat-observation.js';
import { toPlainText } from '../../lib/plain-text.js';

type ObserveChatMessageJobData = {
  messageId: string;
  spaceId: string;
  orgId: string;
  userId: string;
  observationVersion?: number;
};

function tokenOverlap(a: string, b: string): number {
  const toTokens = (value: string) => new Set(
    toPlainText(value)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3),
  );
  const left = toTokens(a);
  const right = toTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return intersection / union;
}

function factsWithoutDecisionEcho(
  facts: string[] | null | undefined,
  decision: string | null | undefined,
): string[] {
  const cleanFacts = Array.isArray(facts) ? facts.filter((fact) => fact.trim().length > 0) : [];
  if (!decision) return cleanFacts;
  return cleanFacts.filter((fact) => tokenOverlap(fact, decision) < 0.5);
}

function looksLikeResourceCapture(content: string): boolean {
  const plain = toPlainText(content).toLowerCase();
  if (!/https?:\/\//i.test(plain) && !/\b(?:resource|reference|doc|docs|checklist|link)\s*:/i.test(plain)) {
    return false;
  }
  return /\b(?:save|capture|remember|canonical|reference|resource|checklist|doc|docs|link|source)\b/i.test(plain);
}

function hasExplicitTaskSignal(content: string): boolean {
  const plain = toPlainText(content).toLowerCase();
  return /\b(?:create|add|make|open|track)\b.{0,50}\b(?:task|todo|ticket)\b/i.test(plain) ||
    /\b(?:task|todo|ticket)\s*:\s*\S+/i.test(plain);
}

function hasGeneralActionSignal(content: string): boolean {
  const plain = toPlainText(content).toLowerCase();
  return /\b(?:need to|should|please|can someone|follow up|assign|owner)\b/i.test(plain);
}

function hasExplicitKnowledgeSignal(content: string): boolean {
  const plain = toPlainText(content).toLowerCase();
  return /\b(?:decision|decided|agreed|resource|reference|doc|docs|checklist|link|fact|policy|preference|note)\s*:/i.test(plain) ||
    /\b(?:we decided|we agreed|going forward)\b/i.test(plain);
}

export function extractExplicitDecision(content: string): string | null {
  const plain = toPlainText(content)
    .replace(/^[A-Z0-9][A-Z0-9_-]{2,80}:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const explicit = plain.match(/\bdecision\s*:\s*(.+?)(?:\s+(?:save|keep|capture|remember)\b|$)/i);
  if (explicit?.[1]?.trim()) return explicit[1].trim().replace(/[.!?]+$/g, '');
  const decided = plain.match(/\b(?:we decided|we agreed|going forward)\b\s*:?\s*(.+?)(?:\s+(?:save|keep|capture|remember)\b|$)/i);
  if (decided?.[1]?.trim()) return decided[1].trim().replace(/[.!?]+$/g, '');
  return null;
}

function hasExplicitFactSignal(content: string): boolean {
  const plain = toPlainText(content).toLowerCase();
  return /\b(?:fact|policy|preference|note)\s*:/i.test(plain) ||
    /\b(?:always|never)\b/i.test(plain);
}

function hasExplicitStatusContextSignal(content: string): boolean {
  const plain = toPlainText(content).toLowerCase();
  return /\b(?:update|status)\s*:/i.test(plain) &&
    /\b(?:keep|save|capture|remember)\b.{0,60}\b(?:context|status|memory|note)\b/i.test(plain);
}

function statusContextFact(content: string): string | null {
  const plain = toPlainText(content)
    .replace(/^DENSE-[^:]+:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain || null;
}

function shouldQueueTaskExtraction(params: {
  content: string;
  intent: string;
  confidence: number;
  blocked: boolean;
  hasMemoryCapture: boolean;
}): boolean {
  if (params.blocked) return false;
  const explicitTask = hasExplicitTaskSignal(params.content);
  if (explicitTask) return params.confidence > 0.7;
  if (params.hasMemoryCapture && hasExplicitKnowledgeSignal(params.content)) return false;
  return params.intent === 'actionable' &&
    params.confidence > 0.78 &&
    hasGeneralActionSignal(params.content);
}

async function markObservation(params: {
  orgId: string;
  messageId: string;
  observationVersion: number;
  status: 'processing' | 'ignored' | 'no_capture' | 'captured' | 'failed';
  ignoredReason?: string | null;
  classifierResult?: Record<string, unknown> | null;
  downstreamJobs?: Array<Record<string, unknown>>;
  captureCount?: number;
  lastError?: string | null;
  completed?: boolean;
}) {
  await db
    .update(messageObservations)
    .set({
      status: params.status,
      ignored_reason: params.ignoredReason ?? null,
      classifier_result: params.classifierResult ?? null,
      downstream_jobs: params.downstreamJobs ?? [],
      capture_count: params.captureCount ?? 0,
      last_error: params.lastError ?? null,
      started_at: params.status === 'processing' ? new Date() : undefined,
      completed_at: params.completed ? new Date() : undefined,
      updated_at: new Date(),
    })
    .where(and(
      eq(messageObservations.org_id, params.orgId),
      eq(messageObservations.message_id, params.messageId),
      eq(messageObservations.observation_version, params.observationVersion),
    ));
}

export async function handleObserveChatMessage(job: JobData): Promise<void> {
  const {
    messageId,
    spaceId,
    orgId,
    userId,
    observationVersion = CHAT_OBSERVATION_VERSION,
  } = job.data as ObserveChatMessageJobData;

  const [observation] = await db
    .select({
      id: messageObservations.id,
      status: messageObservations.status,
      completed_at: messageObservations.completed_at,
    })
    .from(messageObservations)
    .where(and(
      eq(messageObservations.org_id, orgId),
      eq(messageObservations.message_id, messageId),
      eq(messageObservations.observation_version, observationVersion),
    ))
    .limit(1);

  if (!observation) {
    throw new Error(`Observation row missing for message ${messageId}`);
  }
  if (observation.completed_at && ['ignored', 'no_capture', 'captured'].includes(observation.status)) {
    return;
  }

  const [message] = await db
    .select({
      id: messages.id,
      content: messages.content,
      org_id: messages.org_id,
      space_id: messages.space_id,
      user_id: messages.user_id,
      is_deleted: messages.is_deleted,
    })
    .from(messages)
    .where(and(
      eq(messages.id, messageId),
      eq(messages.org_id, orgId),
    ))
    .limit(1);

  if (!message || message.is_deleted) {
    await markObservation({
      orgId,
      messageId,
      observationVersion,
      status: 'ignored',
      ignoredReason: 'source_message_missing_or_deleted',
      completed: true,
    });
    return;
  }

  await markObservation({
    orgId,
    messageId,
    observationVersion,
    status: 'processing',
  });

  const ignoredReason = explicitObservationIgnoreReason(message.content);
  if (ignoredReason) {
    await db.insert(messageClassifications).values({
      org_id: orgId,
      message_id: messageId,
      intent: 'none',
      confidence: 1,
      agent_mentioned: false,
      blocked: false,
      task_references: [],
      entities: {},
      memorable_facts: [],
      decision: null,
    });
    await markObservation({
      orgId,
      messageId,
      observationVersion,
      status: 'ignored',
      ignoredReason,
      classifierResult: {
        intent: 'none',
        confidence: 1,
        ignored_reason: ignoredReason,
        source: 'deterministic_guardrail',
      },
      completed: true,
    });
    return;
  }

  const classification = await classifyMessage(message.content, orgId);
  await db.insert(messageClassifications).values({
    org_id: orgId,
    message_id: messageId,
    intent: classification.intent,
    confidence: classification.confidence,
    agent_mentioned: classification.agent_mentioned,
    blocked: classification.blocked,
    task_references: classification.task_refs,
    entities: classification.entities,
    memorable_facts: classification.memorable_facts,
    decision: classification.decision,
  });

  const downstreamJobs: Array<Record<string, unknown>> = [];
  const resourceCapture = looksLikeResourceCapture(message.content);
  const explicitDecision = extractExplicitDecision(message.content) || classification.decision;
  const factCandidates = resourceCapture && !hasExplicitFactSignal(message.content)
    ? []
    : factsWithoutDecisionEcho(
      classification.memorable_facts,
      explicitDecision,
    );
  const deterministicStatusFact = hasExplicitStatusContextSignal(message.content)
    ? statusContextFact(message.content)
    : null;
  if (factCandidates.length === 0 && deterministicStatusFact) {
    factCandidates.push(deterministicStatusFact);
  }
  const hasMemoryCapture = Boolean(explicitDecision) || factCandidates.length > 0 || resourceCapture;

  if (shouldQueueTaskExtraction({
    content: message.content,
    intent: classification.intent,
    confidence: classification.confidence,
    blocked: classification.blocked,
    hasMemoryCapture,
  })) {
    await enqueue(QUEUE_NAMES.AGENT_JOBS, 'task-extract', {
      messageId,
      spaceId: message.space_id,
      content: message.content,
      orgId,
      userId,
      classification,
    });
    downstreamJobs.push({ name: 'task-extract', reason: classification.intent });
  }

  if (classification.blocked === true) {
    await enqueue(QUEUE_NAMES.AGENT_JOBS, 'blocked-alert', {
      messageId,
      spaceId: message.space_id,
      content: message.content,
      orgId,
      userId,
    });
    downstreamJobs.push({ name: 'blocked-alert', reason: 'blocked' });
  }

  if (hasMemoryCapture) {
    await enqueue(QUEUE_NAMES.AGENT_JOBS, 'memory-capture', {
      messageId,
      spaceId: message.space_id,
      content: message.content,
      orgId,
      userId,
      decision: explicitDecision || null,
      facts: factCandidates,
    });
    downstreamJobs.push({
      name: 'memory-capture',
      reason: explicitDecision
        ? 'decision'
        : factCandidates.length > 0
          ? 'facts'
          : 'resource',
    });
  }

  await markObservation({
    orgId,
    messageId,
    observationVersion,
    status: downstreamJobs.length > 0 ? 'captured' : 'no_capture',
    ignoredReason: downstreamJobs.length > 0 ? null : 'classifier_no_capture',
    classifierResult: classification as unknown as Record<string, unknown>,
    downstreamJobs,
    captureCount: downstreamJobs.length,
    completed: true,
  });
}
