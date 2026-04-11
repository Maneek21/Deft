// Shared Haiku message classifier — classifies chat messages for the agent pipeline
import { llm } from './llm.js';
import { env } from './env.js';

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
- memorable_facts: array of strings — extract any memorable facts worth remembering (team preferences, tool choices, process decisions, personal preferences, workflow conventions). Examples: "Rahul prefers async standups", "team uses Stripe for payments". Return empty array if nothing memorable.
- decision: string or null — if the message contains a clear team decision (e.g., "Let's go with Postgres instead of MongoDB"), extract it as a concise statement. Return null if no decision.

Rules:
- "task_create": message explicitly asks to create/add a task or todo
- "actionable": message implies something should be done but doesn't explicitly ask for task creation
- "question": message is asking a question
- "discussion": general conversation, opinions, updates
- "none": greetings, reactions, very short messages with no substance

Also extract any memorable facts (team preferences, tool choices, process decisions, personal preferences) as an array. If the message contains a clear team decision, extract it separately.

Return ONLY valid JSON, no markdown fences.`;

export async function classifyMessage(
  content: string,
  orgId: string,
): Promise<ClassificationResult> {
  if (!env.ANTHROPIC_API_KEY) {
    return { ...DEFAULT_RESULT };
  }

  try {
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
    });

    const parsed = JSON.parse(response.text);

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
