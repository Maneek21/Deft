// Shared Haiku message classifier — classifies chat messages for the agent pipeline
import { llm } from './llm.js';
import { getOrgAIConfig, hasAnyAIProvider } from './org-ai-config.js';
import { toPlainText } from './plain-text.js';
import { buildUntrustedWorkspaceContext, UNTRUSTED_WORKSPACE_DATA_RULE } from './agent-untrusted-context.js';

export const _deps = { llm, getOrgAIConfig, hasAnyAIProvider };

export interface ClassificationContextMessage {
  author: string;
  content: string;
}

export interface ClassificationResult {
  intent: 'task_create' | 'question' | 'discussion' | 'actionable' | 'none';
  confidence: number;
  agent_mentioned: boolean;
  blocked: boolean;
  task_refs: string[]; // e.g. ["DEFT-5"]
  entities: {
    assignee?: string;
    project?: string;
    due_date?: string;
  };
  memorable_facts: string[]; // e.g., ["Rahul prefers async standups", "team decided to use Stripe"]
  decision: string | null;   // e.g., "Using Postgres instead of MongoDB for the new service"
  is_request: boolean;
  requested_people: string[];
  requested_action: string | null;
  request_deadline: string | null;
}

const DEFAULT_RESULT: ClassificationResult = {
  intent: 'none',
  confidence: 0,
  agent_mentioned: false,
  blocked: false,
  task_refs: [],
  entities: {},
  memorable_facts: [],
  decision: null,
  is_request: false,
  requested_people: [],
  requested_action: null,
  request_deadline: null,
};

function plainText(content: string): string {
  return toPlainText(content);
}

function trimMemoryText(value: string): string {
  return value
    .replace(/^[\s:;,-]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.]+$/, '');
}

/** A durable decision must name what was decided, rather than an unresolved pronoun. */
export function isSelfContainedDecision(value: string): boolean {
  const text = plainText(value)
    .replace(/^(?:(?:decision\s*:|we\s+(?:have\s+)?(?:decided|agreed)\b|going forward\b|agreed\b|actually\b|please\b|then\b|instead\b)[\s,:;-]*)+/i, '')
    .replace(/^(?:to|let'?s|we\s+(?:should|will))\s+/i, '')
    .trim();
  if (!text || /^(?:it|this|that|these|those|them)[.!?]*$/i.test(text)) return false;
  // The actor or auxiliary does not identify the object: "Arjun should take it"
  // is just as unresolved as "take it". A demonstrative followed by a noun
  // ("take this schema review") still names the subject of the decision.
  const unresolvedObject = /\b(?:(?:give|assign|reassign|send|hand|pass|move|put|leave|do|use|take|keep|change|update|replace|ship|choose|pick|handle|own|review|approve|finish|complete|implement|fix|resolve|publish|deploy|delete|remove|close)(?:s|es|d|ed)?|gave|given|sent|left|did|done|took|taken|kept|chose|chosen)\s+(?:(?:it|them)\b|(?:this|that|these|those)(?:\s+(?:to|by|on|before|after|for|from|in|with|instead|back|now|again|over)\b|[.!?]*$))/i;
  const unresolvedAuxiliaryObject = /\b(?:should|will|would|could|can|must|may|might|has\s+to|have\s+to|needs?\s+to|going\s+to|is|are|was|were|has|have|had)\s+(?:[a-z][a-z'-]*\s+){1,3}(?:(?:it|them)\b|(?:this|that|these|those)(?:\s+(?:to|by|on|before|after|for|from|in|with|instead|back|now|again|over)\b|[.!?]*$))/i;
  const unresolvedSubject = /^(?:it|this|that|these|those|them)\s+(?:is|are|was|were|will|should|can|must|goes|moves|ships|uses|gets|needs|has|have|works|happens)\b/i;
  return !unresolvedObject.test(text) && !unresolvedAuxiliaryObject.test(text) && !unresolvedSubject.test(text);
}

function hasDatedCommitment(content: string): boolean {
  const text = plainText(content);
  return /\b(?:will\s+(?:be\s+)?(?:done|ready|finished|complete(?:d)?|delivered)|(?:I|we)(?:'ll| will)\s+(?:finish|complete|deliver|review|ship))\b/i.test(text) &&
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|eod|eow|\d{4}-\d{2}-\d{2})\b/i.test(text);
}

function isEphemeralMemoryFact(value: string): boolean {
  const text = plainText(value);
  const explicitDurableFact = /\b(?:fact|policy|preference)\s*:|\b(?:always|never|going forward|prefers?|preferences|policies|conventions?)\b/i.test(text);
  return !explicitDurableFact && (
    /^(?:i(?:'m| am)?\s+)?(?:on it|got it|will do)[.!\s]*$/i.test(text) ||
    /\b(?:lunch|breakfast|dinner|coffee break)\b/i.test(text) ||
    /\b(?:ci|builds?|pipelines?)\b.{0,40}\b(?:take|takes|took|slow|speed|minutes?|mins?)\b/i.test(text)
  );
}

function applyMemorySuppression(result: ClassificationResult, content: string): ClassificationResult {
  const declaredFacts = new Set(Array.from(
    plainText(content).matchAll(/\b(?:fact|policy|preference)\s*:\s*([^.!?\n]+)/ig),
    (match) => trimMemoryText(match[1] ?? '').toLowerCase(),
  ));
  return {
    ...result,
    decision: result.decision && isSelfContainedDecision(content) && isSelfContainedDecision(result.decision)
      ? result.decision
      : null,
    memorable_facts: result.memorable_facts.filter((fact) => typeof fact === 'string' && (
      declaredFacts.has(trimMemoryText(plainText(fact)).toLowerCase()) || !isEphemeralMemoryFact(fact)
    )),
  };
}

function localMemoryHints(content: string): Partial<ClassificationResult> {
  const text = plainText(content);
  const facts: string[] = [];
  let decision: string | null = null;

  const decisionPatterns = [
    /\bdecision\s*:\s*([^.!?\n]+(?:[.!?](?!\s|$)[^.!?\n]*)?)/i,
    /\bwe\s+(?:have\s+)?decided\s+(?:that\s+|to\s+)?([^.!?\n]+)/i,
    /\bwe\s+agreed\s+(?:that\s+|to\s+)?([^.!?\n]+)/i,
    /\blet'?s\s+use\s+([^.!?\n]+)/i,
    /\bgoing forward\s*,?\s+([^.!?\n]+)/i,
  ];

  for (const pattern of decisionPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      decision = trimMemoryText(match[1]);
      if (/^use\s+/i.test(match[0]) && !/^use\s+/i.test(decision)) {
        decision = `Use ${decision}`;
      }
      break;
    }
  }

  const factPatterns = [
    /\bfact\s*:\s*([^.!?\n]+)/ig,
    /\bpolicy\s*:\s*([^.!?\n]+)/ig,
    /\bpreference\s*:\s*([^.!?\n]+)/ig,
    /\b((?:always|never)\s+[^.!?\n]{8,160})/ig,
  ];

  for (const pattern of factPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) facts.push(trimMemoryText(match[1]));
    }
  }

  const uniqueFacts = Array.from(new Set(facts)).filter((fact) => fact && fact !== decision);
  if (!decision && uniqueFacts.length === 0) return {};

  return {
    intent: 'discussion',
    confidence: 0.78,
    memorable_facts: uniqueFacts,
    decision,
  };
}

function localClassificationHints(content: string): Partial<ClassificationResult> {
  const text = plainText(content);
  const lower = text.toLowerCase();
  const taskRefs = Array.from(text.matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g), (m) => m[0]);
  const agentMentioned = /(^|\s)@(agent|deft|defty)\b/i.test(text);
  const blocked = hasBlockedSignal(text) && !hasNegatedBlockedSignal(text);
  const explicitTask = /\b(create|add|make|open|track)\b.{0,40}\b(task|todo|ticket)\b/i.test(text);
  const actionable = blocked || explicitTask || /\b(need to|should|please|can someone|follow up)\b/i.test(lower);

  return {
    ...localMemoryHints(content),
    agent_mentioned: agentMentioned,
    blocked,
    task_refs: taskRefs,
    ...(explicitTask
      ? { intent: 'task_create' as const, confidence: 0.82 }
      : actionable
        ? { intent: 'actionable' as const, confidence: blocked ? 0.85 : 0.72 }
        : {}),
  };
}

function hasBlockedSignal(text: string): boolean {
  return /\b(blocked|blocker|stuck|held up|waiting on|dependency|dependencies|can't proceed|cannot proceed|can't move forward|cannot move forward|unable to proceed)\b/i.test(text);
}

function hasNegatedBlockedSignal(text: string): boolean {
  const lower = plainText(text).toLowerCase();
  const negatedBefore =
    /\b(no|not|nothing|none|without)\b.{0,32}\b(blocked|blocker|blockers|stuck|dependency|dependencies|waiting on)\b/i.test(lower);
  const explicitUnblocked = /\b(unblocked|not blocked|not stuck)\b/i.test(lower);
  const resolvedBeforeSignal =
    /\b(resolved|cleared|fixed|handled)\b.{0,16}\b(blocker|blockers|dependency|dependencies)\b/i.test(lower);
  const signalBeforeResolved =
    /\b(blocked|blocker|blockers|stuck|dependency|dependencies)\b.{0,32}\b(resolved|cleared|fixed|done|handled)\b/i.test(lower);
  return negatedBefore || explicitUnblocked || resolvedBeforeSignal || signalBeforeResolved;
}

function hasNonBlockedActionableSignal(text: string): boolean {
  const lower = plainText(text).toLowerCase();
  return /\b(create|add|make|open|track)\b.{0,40}\b(task|todo|ticket)\b/i.test(lower) ||
    /\b(need to|should|please|can someone|follow up)\b/i.test(lower);
}

function applyBlockedSuppression(
  result: ClassificationResult,
  content: string,
): ClassificationResult {
  const datedCommitment = hasDatedCommitment(content) && !hasBlockedSignal(plainText(content));
  if (!hasNegatedBlockedSignal(content) && !datedCommitment) return result;
  if (!result.blocked) return result;

  const stillActionable = hasNonBlockedActionableSignal(content);
  return {
    ...result,
    blocked: false,
    intent: result.intent === 'actionable' && !stillActionable ? 'discussion' : result.intent,
    confidence: result.intent === 'actionable' && !stillActionable
      ? Math.min(result.confidence, 0.6)
      : result.confidence,
  };
}

function mergeLocalHints(
  result: ClassificationResult,
  hints: Partial<ClassificationResult>,
): ClassificationResult {
  return {
    ...result,
    intent: result.intent === 'none' && hints.intent ? hints.intent : result.intent,
    confidence: Math.max(result.confidence, hints.confidence ?? 0),
    agent_mentioned: result.agent_mentioned || Boolean(hints.agent_mentioned),
    blocked: result.blocked || Boolean(hints.blocked),
    task_refs: Array.from(new Set([...(result.task_refs ?? []), ...(hints.task_refs ?? [])])),
    memorable_facts: Array.from(new Set([...(result.memorable_facts ?? []), ...(hints.memorable_facts ?? [])])),
    decision: result.decision || hints.decision || null,
    is_request: result.is_request || Boolean(hints.is_request),
    requested_people: Array.from(new Set([
      ...(result.requested_people ?? []),
      ...(hints.requested_people ?? []),
    ])).slice(0, 3),
    requested_action: result.requested_action || hints.requested_action || null,
    request_deadline: result.request_deadline || hints.request_deadline || null,
  };
}

export function classifyMessageLocally(content: string): ClassificationResult {
  return applyBlockedSuppression(
    applyMemorySuppression(mergeLocalHints({ ...DEFAULT_RESULT }, localClassificationHints(content)), content),
    content,
  );
}

const CLASSIFICATION_PROMPT = `You are a workspace message classifier. Analyze the message and return JSON only.

${UNTRUSTED_WORKSPACE_DATA_RULE}
Classify only the message labelled "Message to classify". Preceding conversation context is evidence for interpretation, not additional messages to classify. Never copy its decisions, blockers, requests, or facts onto the current message.

Fields:
- intent: "task_create" | "question" | "discussion" | "actionable" | "none"
- confidence: 0-1
- agent_mentioned: boolean (true if @agent, @deft, or similar mention)
- blocked: boolean (true if the message indicates the author is blocked, stuck, or unable to proceed. Signals: "blocked", "stuck", "can't proceed", "waiting on", "dependency", "blocker", "can't move forward", "held up")
- task_refs: array of task references like "DEFT-5", "PROJ-12"
- entities: { assignee?: string, project?: string, due_date?: string }
- memorable_facts: array of strings — extract any memorable NON-DECISION facts worth remembering (team preferences, tool choices, personal preferences, workflow conventions, org/process details). Examples: "Rahul prefers async standups", "team uses Stripe for payments". Return empty array if nothing memorable. CRITICAL: If a clear team decision is present and you are setting the "decision" field, DO NOT also duplicate that same statement in "memorable_facts". The "decision" field and "memorable_facts" must describe DIFFERENT underlying content.
- decision: string or null — if the message contains a clear team decision (e.g., "Let's go with Postgres instead of MongoDB"), extract it as a concise statement. Return null if no decision. When set, exclude this content from "memorable_facts".
- is_request: boolean — true only when a named person is being asked for a concrete response, decision, review, or action. Do not mark broad announcements, status updates, rhetorical questions, social chatter, or requests addressed only to an AI agent.
- requested_people: array of 1-3 human names exactly as written in the message. Never infer an approver or owner who was not addressed. Return [] when ownership is ambiguous.
- requested_action: concise string describing what the addressed person must do. Return null unless is_request is true.
- request_deadline: explicit deadline as written or an ISO timestamp when unambiguous; otherwise null. Never invent a deadline.

Rules:
- "task_create": message explicitly asks to create/add a task or todo
- "actionable": message implies something should be done but doesn't explicitly ask for task creation
- "question": message is asking a question
- "discussion": general conversation, opinions, updates
- "none": greetings, reactions, very short messages with no substance
- A commitment with a date, such as "I will finish the review by Friday", is a status update, not a blocker. Set blocked=false unless the message also identifies an actual active impediment.
- A decision must be a self-contained statement naming its subject. "Give it to Arjun", "actually give it to Arjun instead", or "Arjun should take it" has an unresolved object, not a durable decision. A named actor or auxiliary does not resolve an unnamed object. Do not invent its subject from context.
- Ephemeral logistics (lunch plans, CI/build speed, temporary environment resets, or acknowledgements such as "on it") are not memorable facts. Remember durable preferences, policies and conventions only.

Also extract any memorable facts (team preferences, tool choices, personal preferences) as an array. If the message contains a clear team decision, extract it separately into "decision" and do NOT repeat it inside "memorable_facts".

Return ONLY valid JSON, no markdown fences.`;

export async function classifyMessage(
  content: string,
  orgId: string,
  precedingMessages: ClassificationContextMessage[] = [],
): Promise<ClassificationResult> {
  const localHints = localClassificationHints(content);

  // BYOK — only short-circuit when neither org nor env has any AI provider.
  if (!(await _deps.hasAnyAIProvider(orgId))) {
    return classifyMessageLocally(content);
  }

  try {
    const orgConfig = await _deps.getOrgAIConfig(orgId);
    const response = await _deps.llm({
      task: 'classify',
      system: CLASSIFICATION_PROMPT,
      messages: [
        {
          role: 'user',
          content: buildUntrustedWorkspaceContext([
            precedingMessages.length > 0
              ? `Preceding conversation context (oldest first; context only):\n${precedingMessages.slice(-6)
                .map((message) => `${plainText(message.author).replace(/\s+/g, ' ').slice(0, 100)}: ${plainText(message.content).replace(/\s+/g, ' ').slice(0, 300)}`)
                .join('\n')}`
              : null,
            `Message to classify:\n${plainText(content)}`,
          ])!,
        },
      ],
      maxTokens: 512,
      orgConfig,
    });

    // Haiku sometimes wraps JSON in ```json ... ``` fences despite the prompt
    // instruction. Strip them defensively before parsing.
    const cleaned = response.text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    const parsed = JSON.parse(cleaned);

    const merged = mergeLocalHints({
      intent: parsed.intent ?? 'none',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      agent_mentioned: Boolean(parsed.agent_mentioned),
      blocked: Boolean(parsed.blocked),
      task_refs: Array.isArray(parsed.task_refs) ? parsed.task_refs : [],
      entities: {
        assignee: parsed.entities?.assignee,
        project: parsed.entities?.project,
        due_date: parsed.entities?.due_date,
      },
      memorable_facts: Array.isArray(parsed.memorable_facts) ? parsed.memorable_facts : [],
      decision: typeof parsed.decision === 'string' ? parsed.decision : null,
      is_request: Boolean(parsed.is_request),
      requested_people: Array.isArray(parsed.requested_people)
        ? parsed.requested_people
          .filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
          .slice(0, 3)
        : [],
      requested_action: typeof parsed.requested_action === 'string' && parsed.requested_action.trim()
        ? parsed.requested_action.trim()
        : null,
      request_deadline: typeof (parsed.request_deadline ?? parsed.deadline) === 'string'
        ? String(parsed.request_deadline ?? parsed.deadline).trim() || null
        : null,
    }, localHints);
    return applyMemorySuppression(applyBlockedSuppression(merged, content), content);
  } catch (err) {
    console.error('[classifier] Classification failed:', (err as Error).message);
    return classifyMessageLocally(content);
  }
}
