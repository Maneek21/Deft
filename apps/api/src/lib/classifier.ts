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
  // BYOK — only short-circuit when neither org nor env has any AI provider.
  if (!(await hasAnyAIProvider(orgId))) {
    return { ...DEFAULT_RESULT };
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

    return {
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
    };
  } catch (err) {
    console.error('[classifier] Classification failed:', (err as Error).message);
    return { ...DEFAULT_RESULT };
  }
}
