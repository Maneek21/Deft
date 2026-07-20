import { and, eq } from 'drizzle-orm';
import {
  orgMembers,
  messageClassifications,
  messageObservations,
  messages,
  spaceMembers,
  users,
} from '@deft/db/schema';
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { classifyMessage } from '../../lib/classifier.js';
import type { ClassificationResult } from '../../lib/classifier.js';
import { enqueue, QUEUE_NAMES } from '../../lib/queues.js';
import {
  CHAT_OBSERVATION_VERSION,
  explicitObservationIgnoreReason,
  hasNoKnowledgeDirective,
  hasNoTaskDirective,
} from '../../lib/chat-observation.js';
import { toPlainText } from '../../lib/plain-text.js';
import { parseMentions } from '../../lib/mentions.js';
import { explainNotificationPolicy } from '../../lib/notification-policy.js';
import { upsertAttentionItem, type AttentionPriority } from '../../lib/attention.js';

type ObserveChatMessageJobData = {
  messageId: string;
  spaceId: string;
  orgId: string;
  userId: string;
  observationVersion?: number;
};

const EXPLICIT_KNOWLEDGE_UPDATE_CAPTURE_DELAY_MS = 30_000;

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
  return /\b(?:create|add|make|open|track)\b.{0,50}\b(?:tasks?|todos?|tickets?)\b/i.test(plain) ||
    /\b(?:tasks?|todos?|tickets?)\s*:\s*\S+/i.test(plain);
}

function hasConcreteBlockedSignal(content: string): boolean {
  const plain = toPlainText(content).toLowerCase();
  if (hasNoTaskDirective(content)) return false;
  return /\b(?:i am|i'm|im|we are|we're|were|team is|team's)\s+(?:blocked|stuck|waiting|held up)\b/i.test(plain) ||
    /\b(?:blocked|stuck|held up)\s+(?:on|by|because|until)\b/i.test(plain) ||
    /\b(?:can't|cannot|unable to)\s+(?:ship|finish|complete|start|move|continue|proceed)\b/i.test(plain);
}

function hasExplicitKnowledgeSignal(content: string): boolean {
  const plain = toPlainText(content).toLowerCase();
  return /\b(?:decision|decided|agreed|resource|reference|doc|docs|checklist|link|fact|policy|preference|note)\s*:/i.test(plain) ||
    /\b(?:we decided|we agreed|going forward)\b/i.test(plain);
}

function hasExplicitKnowledgeUpdateSignal(content: string): boolean {
  const plain = toPlainText(content).trim();
  return /^(?:(?:decision|fact|resource|note|knowledge|wiki|memory)\s*:\s*)?(?:update|correct|correction|amend|revise|change|replace)\b(?:\s+(?:the\s+)?(?:decision|fact|resource|note|knowledge|wiki|memory))?\b/i.test(plain)
    || /\b(?:update|correct|correction|amend|revise|change|replace)\b\s+(?:the\s+)?(?:decision|fact|resource|note|knowledge|wiki|memory)\b/i.test(plain);
}

export function extractExplicitDecision(content: string): string | null {
  const plain = toPlainText(content)
    .replace(/^[A-Z0-9][A-Z0-9_-]{2,80}:\s*/, '')
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

function looksLikeSocialChatter(content: string): boolean {
  const plain = toPlainText(content)
    .toLowerCase()
    .replace(/\b(?:human|chat|dense|edge)[a-z0-9_-]*-[a-z0-9_-]{6,}\b/g, '');
  const socialTopic =
    /\b(?:pizza|deep dish|thin crust|pineapple|jalapeno|mushroom|cheese|lunch|breakfast|dinner|snack|coffee|tea|cake|eat|eating|birthday|party|weekend|movie|music|sports)\b/i.test(plain);
  if (!socialTopic) return false;

  const explicitCapture =
    hasExplicitKnowledgeSignal(content) ||
    hasExplicitKnowledgeUpdateSignal(content) ||
    hasExplicitTaskSignal(content) ||
    looksLikeResourceCapture(content);
  if (explicitCapture) return false;

  const jokingOrPreferenceLanguage =
    /\b(?:discourse|drama|counterpoint|civilized|absolutely not|fine|deal|move on|unbothered|option|prefer|preference|want|wants|only|never|chaos|democracy)\b/i.test(plain);
  return jokingOrPreferenceLanguage || plain.length < 220;
}

function looksLikeSocialTaskJoke(content: string): boolean {
  const plain = toPlainText(content)
    .toLowerCase()
    .replace(/\b(?:human|chat|dense|edge)[a-z0-9_-]*-[a-z0-9_-]{6,}\b/g, '');
  return hasExplicitTaskSignal(content) &&
    /\b(?:pizza|pineapple|lunch|coffee|snack|cake|weekend|movie|music|sports)\b/i.test(plain) &&
    /\b(?:joke|joking|kidding|mostly|ban|constitution|debate|debates|drama)\b/i.test(plain);
}

function normalizedPersonName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function boundedRequestPriority(
  content: string,
  deadline: string | null,
  now = new Date(),
): AttentionPriority {
  if (hasConcreteBlockedSignal(content)) return 'high';
  if (!deadline) return 'normal';
  const deadlineAt = new Date(deadline);
  const remainingMs = deadlineAt.getTime() - now.getTime();
  return Number.isFinite(remainingMs) && remainingMs > 0 && remainingMs <= 4 * 60 * 60 * 1000
    ? 'high'
    : 'normal';
}

export function isBoundedRequestCandidate(
  content: string,
  classification: Pick<ClassificationResult,
    'is_request' | 'agent_mentioned' | 'confidence' | 'requested_action' | 'requested_people'>,
): boolean {
  const structured = parseMentions(content);
  return !(
    structured.userIds.length > 0 || structured.here || structured.all ||
    !classification.is_request || classification.agent_mentioned ||
    classification.confidence < 0.85 ||
    !classification.requested_action ||
    classification.requested_people.length < 1 || classification.requested_people.length > 3 ||
    looksLikeSocialChatter(content) || looksLikeSocialTaskJoke(content)
  );
}

async function createBoundedRequestAttention(params: {
  orgId: string;
  spaceId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  classification: Awaited<ReturnType<typeof classifyMessage>>;
}): Promise<number> {
  const { classification } = params;
  if (!isBoundedRequestCandidate(params.content, classification)) return 0;

  const members = await db
    .select({ id: users.id, name: users.name })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.user_id))
    .innerJoin(spaceMembers, and(
      eq(spaceMembers.user_id, users.id),
      eq(spaceMembers.space_id, params.spaceId),
    ))
    .where(and(
      eq(orgMembers.org_id, params.orgId),
      eq(orgMembers.is_active, true),
      eq(users.kind, 'human'),
      eq(users.is_agent, false),
    ));
  const resolved = new Map<string, { id: string; name: string }>();
  for (const requestedName of classification.requested_people) {
    const normalized = normalizedPersonName(requestedName);
    if (!normalized) return 0;
    const exact = members.filter((member) => normalizedPersonName(member.name) === normalized);
    const firstName = members.filter((member) => normalizedPersonName(member.name).split(' ')[0] === normalized);
    const matches = exact.length === 1 ? exact : firstName.length === 1 ? firstName : [];
    const match = matches[0];
    if (!match || match.id === params.authorId) return 0;
    resolved.set(match.id, match);
  }
  if (resolved.size !== classification.requested_people.length || resolved.size > 3) return 0;

  const priority = boundedRequestPriority(params.content, classification.request_deadline);
  let created = 0;
  for (const recipient of resolved.values()) {
    const policy = await explainNotificationPolicy({ user_id: recipient.id, type: 'message' }, {
      channel: 'chat',
      spaceId: params.spaceId,
      isMention: true,
    });
    if (!policy.allowed) continue;
    const item = await upsertAttentionItem({
      orgId: params.orgId,
      userId: recipient.id,
      kind: 'human_request',
      lane: 'needs_you',
      priority,
      dedupeKey: `ai-request:${params.messageId}:${recipient.id}`,
      sourceType: 'message',
      sourceId: params.messageId,
      sourceEventId: `ai-request:${params.messageId}:${recipient.id}`,
      title: `${params.authorName} needs your input`,
      body: classification.requested_action,
      link: `/chat?space=${encodeURIComponent(params.spaceId)}&message=${encodeURIComponent(params.messageId)}`,
      metadata: {
        classification_source: 'bounded_ai',
        classification_confidence: classification.confidence,
        requested_person: recipient.name,
        requested_action: classification.requested_action,
        request_deadline: classification.request_deadline,
        source_message_id: params.messageId,
        source_space_id: params.spaceId,
        urgency_rule: priority === 'high' ? 'blocked_or_deadline_under_4h' : 'ordinary_request',
      },
    });
    if (item) created += 1;
  }
  return created;
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
  agentMentioned: boolean;
}): boolean {
  // Chat-to-task is now intentionally Defty-led. Normal chat can still be
  // observed and later used as context, but it should not create/update tasks
  // mechanically in the background.
  void params;
  return false;
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

  const [author] = await db
    .select({ is_agent: users.is_agent, name: users.name })
    .from(users)
    .where(eq(users.id, message.user_id))
    .limit(1);
  if (author?.is_agent) {
    await markObservation({
      orgId,
      messageId,
      observationVersion,
      status: 'ignored',
      ignoredReason: 'agent_authored_message',
      classifierResult: {
        intent: 'none',
        confidence: 1,
        ignored_reason: 'agent_authored_message',
        source: 'deterministic_guardrail',
      },
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
  const requestAttentionCount = await createBoundedRequestAttention({
    orgId,
    spaceId: message.space_id,
    messageId,
    authorId: message.user_id,
    authorName: author?.name ?? 'A teammate',
    content: message.content,
    classification,
  });
  if (requestAttentionCount > 0) {
    downstreamJobs.push({
      name: 'attention-request',
      reason: 'bounded_ai',
      recipients: requestAttentionCount,
      confidence: classification.confidence,
    });
  }
  const resourceCapture = looksLikeResourceCapture(message.content);
  const explicitKnowledgeUpdate = hasExplicitKnowledgeUpdateSignal(message.content);
  const explicitDecision = extractExplicitDecision(message.content) || classification.decision;
  const classifierFactCandidates = explicitKnowledgeUpdate
    ? []
    : resourceCapture && !hasExplicitFactSignal(message.content)
    ? []
    : factsWithoutDecisionEcho(
      classification.memorable_facts,
      explicitDecision,
    );
  const factCandidates = (looksLikeSocialChatter(message.content) || looksLikeSocialTaskJoke(message.content)) && !hasExplicitFactSignal(message.content)
    ? []
    : classifierFactCandidates;
  const deterministicStatusFact = hasExplicitStatusContextSignal(message.content)
    ? statusContextFact(message.content)
    : null;
  if (factCandidates.length === 0 && deterministicStatusFact) {
    factCandidates.push(deterministicStatusFact);
  }
  const knowledgeSuppressed =
    classification.agent_mentioned ||
    hasNoKnowledgeDirective(message.content) ||
    looksLikeSocialChatter(message.content) ||
    looksLikeSocialTaskJoke(message.content);
  const hasImmediateMemoryCapture = false;
  const hasMemoryCapture = !knowledgeSuppressed && (
    Boolean(explicitDecision) || factCandidates.length > 0 || resourceCapture
  );

  if (shouldQueueTaskExtraction({
    content: message.content,
    intent: classification.intent,
    confidence: classification.confidence,
    blocked: classification.blocked,
    hasMemoryCapture,
    agentMentioned: classification.agent_mentioned,
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

  if (
    classification.blocked === true &&
    !classification.agent_mentioned &&
    !looksLikeSocialChatter(message.content) &&
    !looksLikeSocialTaskJoke(message.content) &&
    hasConcreteBlockedSignal(message.content)
  ) {
    await enqueue(QUEUE_NAMES.AGENT_JOBS, 'blocked-alert', {
      messageId,
      spaceId: message.space_id,
      content: message.content,
      orgId,
      userId,
    });
    downstreamJobs.push({ name: 'blocked-alert', reason: 'blocked' });
  }

  if (hasImmediateMemoryCapture && hasMemoryCapture) {
    const memoryCaptureOptions = explicitKnowledgeUpdate
      ? { delay: EXPLICIT_KNOWLEDGE_UPDATE_CAPTURE_DELAY_MS, maxAttempts: 5 }
      : undefined;
    await enqueue(QUEUE_NAMES.AGENT_JOBS, 'memory-capture', {
      messageId,
      spaceId: message.space_id,
      content: message.content,
      orgId,
      userId,
      decision: explicitDecision || null,
      facts: factCandidates,
    }, memoryCaptureOptions);
    downstreamJobs.push({
      name: 'memory-capture',
      reason: explicitDecision
        ? 'decision'
        : factCandidates.length > 0
          ? 'facts'
          : 'resource',
      ...(explicitKnowledgeUpdate
        ? { delay_ms: EXPLICIT_KNOWLEDGE_UPDATE_CAPTURE_DELAY_MS }
        : {}),
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
