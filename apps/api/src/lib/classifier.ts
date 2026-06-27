// Shared Haiku message classifier — classifies chat messages for the agent pipeline
import { llm } from './llm.js';
import { getOrgAIConfig, hasAnyAIProvider } from './org-ai-config.js';

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
};

function plainText(content: string): string {
  return content
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimMemoryText(value: string): string {
  return value
    .replace(/^[\s:;,-]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.]+$/, '');
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
  if (!hasNegatedBlockedSignal(content)) return result;
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
  };
}

export function classifyMessageLocally(content: string): ClassificationResult {
  return applyBlockedSuppression(
    mergeLocalHints({ ...DEFAULT_RESULT }, localClassificationHints(content)),
    content,
  );
}

const CLASSIFICATION_PROMPT = `You are a workspace message classifier. Analyze the message and return JSON only.

Fields:
- intent: "task_create" | "question" | "discussion" | "actionable" | "none"
- confidence: 0-1
- agent_mentioned: boolean (true if @agent, @deft, or similar mention)
- blocked: boolean (true if the message indicates the author is blocked, stuck, or unable to proceed. Signals: "blocked", "stuck", "can't proceed", "waiting on", "dependency", "blocker", "can't move forward", "held up")
- task_refs: array of task references like "DEFT-5", "PROJ-12"
- entities: { assignee?: string, project?: string, due_date?: string }
- memorable_facts: array of strings — extract any memorable NON-DECISION facts worth remembering (team preferences, tool choices, personal preferences, workflow conventions, org/process details). Examples: "Rahul prefers async standups", "team uses Stripe for payments". Return empty array if nothing memorable. CRITICAL: If a clear team decision is present and you are setting the "decision" field, DO NOT also duplicate that same statement in "memorable_facts". The "decision" field and "memorable_facts" must describe DIFFERENT underlying content.
- decision: string or null — if the message contains a clear team decision (e.g., "Let's go with Postgres instead of MongoDB"), extract it as a concise statement. Return null if no decision. When set, exclude this content from "memorable_facts".

Rules:
- "task_create": message explicitly asks to create/add a task or todo
- "actionable": message implies something should be done but doesn't explicitly ask for task creation
- "question": message is asking a question
- "discussion": general conversation, opinions, updates
- "none": greetings, reactions, very short messages with no substance

Also extract any memorable facts (team preferences, tool choices, personal preferences) as an array. If the message contains a clear team decision, extract it separately into "decision" and do NOT repeat it inside "memorable_facts".

Return ONLY valid JSON, no markdown fences.`;

export async function classifyMessage(
  content: string,
  orgId: string,
): Promise<ClassificationResult> {
  const localHints = localClassificationHints(content);

  // BYOK — only short-circuit when neither org nor env has any AI provider.
  if (!(await hasAnyAIProvider(orgId))) {
    return classifyMessageLocally(content);
  }

  try {
    const orgConfig = await getOrgAIConfig(orgId);
    const response = await llm({
      task: 'classify',
      system: CLASSIFICATION_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Org: ${orgId}\nMessage: ${content}`,
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
    }, localHints);
    return applyBlockedSuppression(merged, content);
  } catch (err) {
    console.error('[classifier] Classification failed:', (err as Error).message);
    return classifyMessageLocally(content);
  }
}
