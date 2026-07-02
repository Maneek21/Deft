import { and, eq, gte, lt, desc } from 'drizzle-orm';
import {
  messageClassifications,
  messages,
  spaces,
  users,
} from '@deft/db/schema';
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { queueDeftyKnowledgeCapture } from '../../lib/defty-capture.js';
import { llm } from '../../lib/llm.js';
import { getOrgAIConfig, hasAnyAIProvider } from '../../lib/org-ai-config.js';
import { toPlainText, truncatePlainText } from '../../lib/plain-text.js';

const DEFAULT_LOOKBACK_MS = 35 * 60 * 1000;
const DEFAULT_QUIET_MS = 8 * 60 * 1000;
const MAX_MESSAGES_PER_RUN = 800;
const MAX_CANDIDATES_PER_SPACE = 5;
const EPISODE_GAP_MS = 7 * 60 * 1000;
const MAX_EPISODE_MESSAGES = 28;

type ClassifiedMessageRow = {
  messageId: string;
  spaceId: string;
  spaceName: string;
  orgId: string;
  userId: string;
  userName: string;
  content: string;
  createdAt: Date;
  confidence: number;
  agentMentioned: boolean;
  memorableFacts: unknown;
  decision: string | null;
};

type RawMessageRow = Omit<ClassifiedMessageRow, 'confidence' | 'agentMentioned' | 'decision'> & {
  confidence: number | null;
  agentMentioned: boolean | null;
  decision: string | null;
};

type EpisodeKind = 'durable_knowledge' | 'task_only' | 'social_ephemeral' | 'noise';

type KnowledgeEpisode = {
  index: number;
  bucket: string;
  rows: ClassifiedMessageRow[];
};

type EpisodeClassification = {
  kind: EpisodeKind;
  confidence: number;
  wikiType: 'decision' | 'fact' | 'procedure' | 'preference' | 'entity' | 'resource';
  title: string;
  summary: string;
  content: string;
  reason: string;
};

type KnowledgeCandidate = {
  kind: 'decision_candidate' | 'note_candidate';
  wikiType: 'decision' | 'fact';
  title: string;
  summary: string;
  content: string;
  source: ClassifiedMessageRow;
  evidence: ClassifiedMessageRow[];
  episode: KnowledgeEpisode;
  classification: EpisodeClassification;
};

function normalize(value: string): string {
  return toPlainText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenOverlap(a: string, b: string): number {
  const toTokens = (value: string) => new Set(
    normalize(value)
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

function hasSocialTopic(value: string): boolean {
  const plain = normalize(value);
  return /\b(?:pizza|deep dish|thin crust|pineapple|jalapeno|mushroom|cheese|lunch|breakfast|dinner|snack|coffee|tea|cake|eat|eating|birthday|party|weekend|movie|music|sports|commute|weather)\b/.test(plain);
}

function hasDomainWorkSignal(value: string): boolean {
  const plain = normalize(value);
  return /\b(?:task|todo|ticket|project|launch|buyer|route|truck|capacity|crate|harvest|handoff|sheet|qc|sampling|sample|label|pack|packing|cold|greenhouse|irrigation|pest|blocked|blocker|stuck|dependency|deadline|due|owner|owns|assign|confirm|status|ship|delivery|market|client|customer|farm|field|greenhouse|order|invoice|trial|campaign|qa|quality|supplier|vendor|sku|inventory)\b/.test(plain);
}

function hasTaskOnlySignal(value: string): boolean {
  const plain = normalize(value);
  return /\b(?:task|todo|ticket|blocked|blocker|stuck|dependency|deadline|due|owner|owns|assign|follow up|need to|should|status|in review|done|complete|completed)\b/.test(plain);
}

function hasDurableSignal(value: string): boolean {
  const plain = normalize(value);
  return /\b(?:decided|decision|agreed|approved|final|going forward|policy|process|client|customer|buyer|launch|project|route|delivery|pickup|pallet|crate|label|labeling|handoff|checklist|signoff|ready|resolved|resolution|owner|owns|deadline|due|constraint|risk|blocked by|depends on|commit|committed|confirmed|canonical|source of truth)\b/.test(plain);
}

function hasDurableCommitmentSignal(value: string): boolean {
  const plain = normalize(value);
  return /\b(?:decided|decision|agreed|approved|final|going forward|policy|process|signoff|ready|resolved|resolution|deadline|due|constraint|risk|blocked by|depends on|commit|committed|confirmed|canonical|source of truth)\b/.test(plain);
}

function hasSettledKnowledgeSignal(value: string): boolean {
  const plain = normalize(value);
  return /\b(?:decided|decision|agreed|approved|final|going forward|policy|process|signoff|resolved|resolution|commit|committed|confirmed|canonical|source of truth)\b/.test(plain);
}

function isSocialOnly(value: string): boolean {
  if (!hasSocialTopic(value)) return false;
  return !hasDomainWorkSignal(value);
}

function isDurableKnowledge(value: string): boolean {
  const plain = normalize(value);
  if (!plain || plain.length < 16) return false;
  if (isSocialOnly(value)) return false;
  if (hasSocialTopic(value) && !hasDomainWorkSignal(value)) return false;
  if (/\b(?:maybe|might|could|should we|thinking aloud|joking|kidding|lol|haha)\b/.test(plain)) return false;
  return hasDurableSignal(value);
}

function factsFrom(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean)
    : [];
}

function isAgentMention(content: string): boolean {
  return /(^|\s)@(agent|deft|defty)\b/i.test(toPlainText(content));
}

function isAgentCommand(content: string): boolean {
  const plain = toPlainText(content);
  return isAgentMention(plain) ||
    /\b(?:create|draft|make|open|update|assign|summarize|turn)\b.{0,90}\b(?:from this discussion|from the discussion|from recent chat|this discussion into|this chat into)\b/i.test(plain) ||
    /\b(?:defty|agent)\b.{0,80}\b(?:create|draft|make|open|update|assign|summarize)\b/i.test(plain);
}

function extractInlineDecision(content: string): string | null {
  const plain = toPlainText(content).replace(/\s+/g, ' ').trim();
  const explicit = plain.match(/\bdecision\s*:\s*(.+)$/i);
  if (explicit?.[1]?.trim()) return explicit[1].trim().replace(/[.!?]+$/g, '');
  const agreed = plain.match(/\b(?:we decided|we agreed|going forward)\b\s*:?\s*(.+)$/i);
  if (agreed?.[1]?.trim()) return agreed[1].trim().replace(/[.!?]+$/g, '');
  return null;
}

function dedupeCandidates(candidates: KnowledgeCandidate[]): KnowledgeCandidate[] {
  const kept: KnowledgeCandidate[] = [];
  for (const candidate of candidates) {
    const duplicate = kept.some((existing) =>
      existing.kind === candidate.kind &&
      tokenOverlap(existing.summary, candidate.summary) >= 0.72,
    );
    if (!duplicate) kept.push(candidate);
  }
  return kept;
}

function episodeText(episode: KnowledgeEpisode): string {
  return episode.rows
    .map((row) => `${row.userName}: ${toPlainText(row.content)}`)
    .join('\n');
}

function evidenceContext(rows: ClassifiedMessageRow[]): string {
  return rows
    .map((row) => `- ${row.userName}: ${truncatePlainText(toPlainText(row.content), 220)}`)
    .join('\n');
}

function topicBucket(row: ClassifiedMessageRow): string {
  const plain = normalize(row.content);
  if (row.agentMentioned || isAgentCommand(row.content)) return 'agent';
  if (isSocialOnly(row.content)) return 'social';
  if (/\b(?:buyer|client|customer|order|invoice|trial)\b/.test(plain)) return 'client';
  if (/\b(?:route|truck|delivery|pickup|cold|capacity|pallet|crate)\b/.test(plain)) return 'ops';
  if (/\b(?:label|labeling|qc|quality|sampling|sample|pack|packing)\b/.test(plain)) return 'quality';
  if (/\b(?:launch|campaign|market|marketing)\b/.test(plain)) return 'launch';
  if (hasTaskOnlySignal(row.content)) return 'task';
  if (hasDurableSignal(row.content)) return 'knowledge';
  return 'general';
}

function shouldStartNewEpisode(current: KnowledgeEpisode, row: ClassifiedMessageRow): boolean {
  const previous = current.rows[current.rows.length - 1];
  if (!previous) return false;
  if (current.rows.length >= MAX_EPISODE_MESSAGES) return true;

  const gapMs = row.createdAt.getTime() - previous.createdAt.getTime();
  if (gapMs >= EPISODE_GAP_MS) return true;

  const nextBucket = topicBucket(row);
  const currentBucket = current.bucket;
  if (nextBucket === 'agent' || currentBucket === 'agent') return true;
  if (nextBucket === 'social' && currentBucket !== 'social') return true;
  if (currentBucket === 'social' && nextBucket !== 'social') return true;

  if (
    current.rows.length >= 4 &&
    nextBucket !== currentBucket &&
    nextBucket !== 'general' &&
    currentBucket !== 'general' &&
    tokenOverlap(current.rows.map((item) => item.content).join('\n'), row.content) < 0.08
  ) {
    return true;
  }

  return false;
}

function segmentRowsIntoEpisodes(rows: ClassifiedMessageRow[]): KnowledgeEpisode[] {
  const episodes: KnowledgeEpisode[] = [];
  let current: KnowledgeEpisode | null = null;
  for (const row of rows) {
    if (!current) {
      current = { index: 0, bucket: topicBucket(row), rows: [row] };
      episodes.push(current);
      continue;
    }
    if (shouldStartNewEpisode(current, row)) {
      current = { index: episodes.length, bucket: topicBucket(row), rows: [row] };
      episodes.push(current);
      continue;
    }
    current.rows.push(row);
    if (current.bucket === 'general') current.bucket = topicBucket(row);
  }
  return episodes;
}

function chooseSourceRow(episode: KnowledgeEpisode): ClassifiedMessageRow {
  return episode.rows.find((row) => row.decision && isDurableKnowledge(row.decision)) ??
    episode.rows.find((row) => factsFrom(row.memorableFacts).some(isDurableKnowledge)) ??
    episode.rows[Math.max(0, episode.rows.length - 1)]!;
}

function isKnowledgeEvidenceRow(row: ClassifiedMessageRow): boolean {
  if (row.agentMentioned || isAgentCommand(row.content)) return false;
  if (isSocialOnly(row.content)) return false;
  if (hasSocialTopic(row.content) && !hasDurableCommitmentSignal(row.content)) return false;
  return true;
}

function deterministicEpisodeClassification(episode: KnowledgeEpisode): EpisodeClassification {
  const transcript = episodeText(episode);
  const durableDecision = episode.rows
    .map((row) => row.decision?.trim() ?? '')
    .find((decision) => decision && isDurableKnowledge(decision));
  const durableFact = episode.rows
    .flatMap((row) => factsFrom(row.memorableFacts))
    .find(isDurableKnowledge);
  const socialRows = episode.rows.filter((row) => isSocialOnly(row.content)).length;
  const hasAgentMention = episode.rows.some((row) => row.agentMentioned);
  const hasDomain = hasDomainWorkSignal(transcript);
  const hasTask = hasTaskOnlySignal(transcript);
  const hasDurable = hasDurableSignal(transcript) || Boolean(durableDecision || durableFact);
  const hasSettledKnowledge = hasSettledKnowledgeSignal(transcript) || Boolean(durableDecision || durableFact);

  if (hasAgentMention) {
    return {
      kind: 'task_only',
      confidence: 0.9,
      wikiType: 'fact',
      title: '',
      summary: '',
      content: '',
      reason: 'Episode contains a Defty/agent mention, so task handling stays agent-led.',
    };
  }
  if (socialRows >= Math.ceil(episode.rows.length * 0.55) && !hasDomain) {
    return {
      kind: 'social_ephemeral',
      confidence: 0.9,
      wikiType: 'fact',
      title: '',
      summary: '',
      content: '',
      reason: 'Episode is mostly social or ephemeral conversation.',
    };
  }
  if (hasTask && !hasSettledKnowledge) {
    return {
      kind: 'task_only',
      confidence: 0.86,
      wikiType: 'fact',
      title: '',
      summary: '',
      content: '',
      reason: 'Episode is blocker/task-shaped but lacks a settled decision or durable process fact.',
    };
  }
  if (!hasDurable || !hasDomain) {
    return {
      kind: hasTask ? 'task_only' : 'noise',
      confidence: hasTask ? 0.82 : 0.72,
      wikiType: 'fact',
      title: '',
      summary: '',
      content: '',
      reason: hasTask
        ? 'Episode is actionable/task-shaped but not durable knowledge.'
        : 'Episode lacks durable work-memory signals.',
    };
  }

  const source = durableDecision || durableFact || truncatePlainText(transcript, 220);
  const wikiType = durableDecision ? 'decision' : 'fact';
  const title = truncatePlainText(source.replace(/^[.!?\s]+|[.!?\s]+$/g, ''), 100) ||
    (wikiType === 'decision' ? 'Decision from discussion' : 'Fact from discussion');
  const content = [
    truncatePlainText(source, 600),
    '',
    'Discussion evidence:',
    evidenceContext(episode.rows.filter(isKnowledgeEvidenceRow)).slice(0, 1800),
  ].join('\n').trim();

  return {
    kind: 'durable_knowledge',
    confidence: 0.78,
    wikiType,
    title,
    summary: truncatePlainText(source, 240),
    content,
    reason: 'Episode has durable work-memory signals and domain context.',
  };
}

function coerceEpisodeClassification(
  raw: Partial<EpisodeClassification>,
  fallback: EpisodeClassification,
  episode: KnowledgeEpisode,
): EpisodeClassification {
  const transcript = episodeText(episode);
  const rawKind = raw.kind;
  const kind: EpisodeKind = rawKind === 'durable_knowledge' ||
    rawKind === 'task_only' ||
    rawKind === 'social_ephemeral' ||
    rawKind === 'noise'
    ? rawKind
    : fallback.kind;
  const wikiType = raw.wikiType === 'decision' ||
    raw.wikiType === 'resource' ||
    raw.wikiType === 'procedure' ||
    raw.wikiType === 'preference' ||
    raw.wikiType === 'entity' ||
    raw.wikiType === 'fact'
    ? raw.wikiType
    : fallback.wikiType;
  const confidence = typeof raw.confidence === 'number'
    ? Math.max(0, Math.min(1, raw.confidence))
    : fallback.confidence;

  const candidate: EpisodeClassification = {
    kind,
    confidence,
    wikiType,
    title: truncatePlainText(raw.title || fallback.title, 100),
    summary: truncatePlainText(raw.summary || fallback.summary, 280),
    content: truncatePlainText(raw.content || fallback.content, 2200),
    reason: truncatePlainText(raw.reason || fallback.reason, 320),
  };

  // Hard guardrails after the model: social-only episodes and agent-command
  // episodes must never become passive wiki writes.
  if (episode.rows.some((row) => row.agentMentioned)) {
    return { ...fallback, kind: 'task_only', confidence: Math.max(fallback.confidence, 0.9) };
  }
  if (hasSocialTopic(transcript) && !hasDomainWorkSignal(transcript)) {
    return { ...fallback, kind: 'social_ephemeral', confidence: Math.max(fallback.confidence, 0.9) };
  }
  if (candidate.kind === 'durable_knowledge' && (!hasDomainWorkSignal(transcript) || !hasDurableSignal(`${candidate.summary}\n${candidate.content}\n${transcript}`))) {
    return {
      ...candidate,
      kind: hasTaskOnlySignal(transcript) ? 'task_only' : 'noise',
      reason: 'Rejected by deterministic guardrail: not enough domain + durable signals.',
    };
  }

  return candidate;
}

async function classifyEpisode(episode: KnowledgeEpisode, orgId: string): Promise<EpisodeClassification> {
  const fallback = deterministicEpisodeClassification(episode);
  if (fallback.kind === 'social_ephemeral' || fallback.kind === 'task_only') {
    return fallback;
  }

  if (!(await hasAnyAIProvider(orgId))) {
    return fallback;
  }

  try {
    const orgConfig = await getOrgAIConfig(orgId);
    const response = await llm({
      task: 'classify',
      system: `You classify settled workspace chat episodes for a knowledge wiki.

Return JSON only with:
{
  "kind": "durable_knowledge" | "task_only" | "social_ephemeral" | "noise",
  "confidence": 0-1,
  "wikiType": "decision" | "fact" | "procedure" | "preference" | "entity" | "resource",
  "title": "short title if durable, else empty",
  "summary": "concise summary if durable, else empty",
  "content": "self-contained wiki text if durable, else empty",
  "reason": "short reason"
}

Rules:
- Durable knowledge means stable company memory: decisions, process changes, client constraints, operating rules, canonical facts, launch commitments.
- Task-only means actionable work that should wait for Defty/a human to create or update a task, not become wiki by itself.
- Social/ephemeral includes lunch, pizza, jokes, greetings, personal banter, temporary preferences unrelated to work. Reject these even if someone says "policy" sarcastically.
- If the episode contains a Defty/agent instruction, classify as task_only unless it also clearly records a separate durable decision.
- Prefer updating an existing canonical wiki later; here only decide whether the episode deserves memory.
- Do not include markdown fences.`,
      messages: [
        {
          role: 'user',
          content: `Episode bucket: ${episode.bucket}\nMessages:\n${episodeText(episode)}`,
        },
      ],
      maxTokens: 700,
      orgConfig,
    });
    const cleaned = response.text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    const parsed = JSON.parse(cleaned) as Partial<EpisodeClassification>;
    return coerceEpisodeClassification(parsed, fallback, episode);
  } catch (err) {
    console.warn('[chat-knowledge-batch] Episode classifier failed, using deterministic fallback:', (err as Error).message);
    return fallback;
  }
}

async function buildCandidatesForSpace(rows: ClassifiedMessageRow[]): Promise<KnowledgeCandidate[]> {
  const candidates: KnowledgeCandidate[] = [];
  const episodes = segmentRowsIntoEpisodes(rows);
  for (let index = 0; index < episodes.length; index += 1) {
    const episode = episodes[index]!;
    const nextEpisode = episodes[index + 1];
    const transcript = episodeText(episode);
    if (episode.rows.every((row) => row.confidence < 0.45) && !hasDomainWorkSignal(transcript) && !hasDurableSignal(transcript)) {
      continue;
    }
    const followedByAgentTaskCommand = Boolean(
      nextEpisode?.rows.some((row) => row.agentMentioned) &&
      nextEpisode.rows[0]!.createdAt.getTime() - episode.rows[episode.rows.length - 1]!.createdAt.getTime() < EPISODE_GAP_MS * 2 &&
      hasTaskOnlySignal(`${episodeText(episode)}\n${episodeText(nextEpisode)}`),
    );
    if (followedByAgentTaskCommand) {
      continue;
    }
    const classification = await classifyEpisode(episode, episode.rows[0]!.orgId);
    if (classification.kind !== 'durable_knowledge' || classification.confidence < 0.62) continue;
    const evidence = episode.rows.filter(isKnowledgeEvidenceRow);
    if (evidence.length === 0) continue;
    const source = chooseSourceRow({ ...episode, rows: evidence });
    const wikiType = classification.wikiType === 'decision' ? 'decision' : 'fact';
    candidates.push({
      kind: wikiType === 'decision' ? 'decision_candidate' : 'note_candidate',
      wikiType,
      title: classification.title || (wikiType === 'decision' ? 'Decision from discussion' : 'Fact from discussion'),
      summary: classification.summary,
      content: classification.content || classification.summary,
      source,
      evidence,
      episode,
      classification,
    });
  }
  return dedupeCandidates(candidates).slice(-MAX_CANDIDATES_PER_SPACE);
}

export async function handleChatKnowledgeBatch(job: JobData): Promise<void> {
  const data = (job.data ?? {}) as {
    lookbackMs?: number;
    quietMs?: number;
    orgId?: string;
    spaceId?: string;
  };
  const lookbackMs = Math.max(5 * 60 * 1000, data.lookbackMs ?? DEFAULT_LOOKBACK_MS);
  const quietMs = Math.max(0, data.quietMs ?? DEFAULT_QUIET_MS);
  const now = new Date();
  const since = new Date(now.getTime() - lookbackMs);
  const before = new Date(now.getTime() - quietMs);

  const rawRows = await db
    .select({
      messageId: messages.id,
      spaceId: messages.space_id,
      spaceName: spaces.name,
      orgId: messages.org_id,
      userId: messages.user_id,
      userName: users.name,
      content: messages.content,
      createdAt: messages.created_at,
      confidence: messageClassifications.confidence,
      agentMentioned: messageClassifications.agent_mentioned,
      memorableFacts: messageClassifications.memorable_facts,
      decision: messageClassifications.decision,
    })
    .from(messages)
    .leftJoin(messageClassifications, and(
      eq(messages.id, messageClassifications.message_id),
      eq(messages.org_id, messageClassifications.org_id),
    ))
    .innerJoin(spaces, and(
      eq(spaces.id, messages.space_id),
      eq(spaces.org_id, messages.org_id),
    ))
    .innerJoin(users, eq(users.id, messages.user_id))
    .where(and(
      data.orgId ? eq(messages.org_id, data.orgId) : undefined,
      data.spaceId ? eq(messages.space_id, data.spaceId) : undefined,
      eq(messages.is_deleted, false),
      eq(users.is_agent, false),
      eq(spaces.is_archived, false),
      gte(messages.created_at, since),
      lt(messages.created_at, before),
    ))
    .orderBy(desc(messages.created_at))
    .limit(MAX_MESSAGES_PER_RUN);

  const grouped = new Map<string, ClassifiedMessageRow[]>();
  const rows = (rawRows.reverse() as RawMessageRow[]).map((row) => ({
    ...row,
    confidence: typeof row.confidence === 'number'
      ? row.confidence
      : hasDurableSignal(row.content) || hasDomainWorkSignal(row.content) ? 0.58 : 0.25,
    agentMentioned: row.agentMentioned ?? isAgentCommand(row.content),
    memorableFacts: row.memorableFacts ?? [],
    decision: row.decision ?? extractInlineDecision(row.content),
  } satisfies ClassifiedMessageRow));

  for (const row of rows) {
    const list = grouped.get(row.spaceId) ?? [];
    list.push(row);
    grouped.set(row.spaceId, list);
  }

  let queuedCount = 0;
  let skippedCount = 0;
  for (const spaceRows of grouped.values()) {
    const candidates = await buildCandidatesForSpace(spaceRows);
    for (const candidate of candidates) {
      const result = await queueDeftyKnowledgeCapture({
        orgId: candidate.source.orgId,
        sourceUserId: candidate.source.userId,
        spaceId: candidate.source.spaceId,
        messageId: candidate.source.messageId,
        content: candidate.content,
        rawContent: evidenceContext(candidate.evidence),
        title: candidate.title,
        summary: candidate.summary,
        wikiType: candidate.wikiType,
        captureKind: candidate.kind,
        captureReason: 'Quiet discussion batch found durable knowledge after the chat settled.',
        extraction: 'llm',
        tags: ['chat-batch', 'episode', candidate.wikiType],
        metadata: {
          source: 'chat_knowledge_batch',
          batch_capture: true,
          episode_capture: true,
          episode_index: candidate.episode.index,
          episode_bucket: candidate.episode.bucket,
          episode_kind: candidate.classification.kind,
          episode_confidence: candidate.classification.confidence,
          episode_reason: candidate.classification.reason,
          episode_message_count: candidate.episode.rows.length,
          batch_window_start: since.toISOString(),
          batch_window_end: before.toISOString(),
          batch_space_id: candidate.source.spaceId,
          batch_space_name: candidate.source.spaceName,
          batch_message_ids: candidate.evidence.map((row) => row.messageId),
          batch_message_previews: candidate.evidence.map((row) => ({
            message_id: row.messageId,
            user_name: row.userName,
            preview: truncatePlainText(toPlainText(row.content), 180),
          })),
        },
        autoApprove: true,
        preferUpdate: true,
      });
      if (result.queued) queuedCount += 1;
      else skippedCount += 1;
    }
  }

  console.log(`[chat-knowledge-batch] processed ${rows.length} messages, queued ${queuedCount}, skipped ${skippedCount}`);
}
