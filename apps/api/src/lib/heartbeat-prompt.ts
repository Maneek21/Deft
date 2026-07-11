/**
 * Task 8.2 — heartbeat prompt composer.
 *
 * `buildHeartbeatPrompt(employee_id)` is the single entry point the
 * heartbeat handler calls before dispatching to either runtime. It:
 *
 *   1. Loads the employee + all installed skills (via `agent_employee_skills`).
 *   2. Unions every skill's `agent_config.heartbeat_checklist[]` with the
 *      employee's `heartbeat_overrides.checklist[]`, deduping on exact
 *      string match.
 *   3. Loads the recent context the prompt references:
 *        - last 3 messages in every space the employee is assigned to
 *          (capped across spaces to keep the payload small)
 *        - open tasks assigned to the employee's shadow user
 *        - tasks the employee itself created in the last 24h
 *   4. Composes the final prompt text + a machine-readable context blob
 *      the trigger envelope can forward verbatim.
 *
 * Task 8.6 later adds a `prompt_sha` over the normalized output for
 * idempotency + loop detection — the normalization excludes the real
 * timestamp so two identical ticks hash identically.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { db } from './db.js';
import {
  agentEmployees,
  agentEmployeeSkills,
  messages,
  skills,
  spaceMembers,
  tasks,
  users,
} from '@deft/db/schema';
import type { SkillAgentConfig } from './skill-config.js';

export type HeartbeatContext = {
  employee_id: string;
  slug: string;
  org_id: string;
  recent_messages: Array<{
    space_id: string;
    user_name: string | null;
    content: string;
    created_at: string;
  }>;
  open_tasks: Array<{
    id: string;
    title: string;
    status: string;
    priority: string | null;
    due_date: string | null;
  }>;
  tasks_created_24h: Array<{
    id: string;
    title: string;
    status: string;
    created_at: string;
  }>;
};

export type HeartbeatPromptResult = {
  prompt: string;
  context: HeartbeatContext;
  /** sha256 of the normalized prompt (no timestamps) — used by Task 8.6. */
  prompt_sha: string;
  /** The final checklist items, in order, after merge + dedup. */
  checklist: string[];
};

/**
 * Stable fallback used when the employee has no installed skill with a
 * heartbeat_checklist AND no `heartbeat_overrides.checklist`. Keeps the
 * heartbeat loop productive for a fresh install.
 */
const DEFAULT_CHECKLIST = [
  'Review your assigned open tasks and flag anything blocked.',
  'Check recent messages in your spaces for questions or decisions that need your input.',
  'If nothing needs attention right now, respond with exactly HEARTBEAT_OK.',
];

function normalizeChecklistItem(item: string): string {
  return item.replace(/\s+/g, ' ').trim();
}

function uniqueChecklist(items: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    if (!raw) continue;
    const norm = normalizeChecklistItem(raw);
    if (!norm) continue;
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

function safeOverridesChecklist(
  overrides: unknown,
): string[] {
  if (!overrides || typeof overrides !== 'object') return [];
  const maybe = (overrides as { checklist?: unknown }).checklist;
  if (!Array.isArray(maybe)) return [];
  return maybe.filter((x): x is string => typeof x === 'string' && !!x.trim());
}

export async function buildHeartbeatPrompt(
  employeeId: string,
): Promise<HeartbeatPromptResult> {
  const [employee] = await db
    .select()
    .from(agentEmployees)
    .where(eq(agentEmployees.id, employeeId))
    .limit(1);

  if (!employee) {
    const prompt = 'HEARTBEAT — employee row not found. Respond HEARTBEAT_OK.';
    return {
      prompt,
      context: {
        employee_id: employeeId,
        slug: '',
        org_id: '',
        recent_messages: [],
        open_tasks: [],
        tasks_created_24h: [],
      },
      prompt_sha: crypto.createHash('sha256').update(prompt).digest('hex'),
      checklist: [],
    };
  }

  // 1. Pull every installed skill's agent_config and collect checklist items.
  const installed = await db
    .select({
      agent_config: skills.agent_config,
      slug: skills.slug,
    })
    .from(agentEmployeeSkills)
    .innerJoin(skills, eq(skills.id, agentEmployeeSkills.skill_id))
    .where(eq(agentEmployeeSkills.agent_employee_id, employee.id))
    .orderBy(asc(skills.created_at), asc(skills.slug));

  const skillChecklist: string[] = [];
  for (const row of installed) {
    const cfg = (row.agent_config ?? {}) as SkillAgentConfig;
    if (Array.isArray(cfg.heartbeat_checklist)) {
      for (const item of cfg.heartbeat_checklist) {
        if (typeof item === 'string') skillChecklist.push(item);
      }
    }
  }

  // 2. Merge with the employee override list (dedup).
  const overrideItems = safeOverridesChecklist(employee.heartbeat_overrides);
  let checklist = uniqueChecklist([...skillChecklist, ...overrideItems]);

  // Fall back to the default list when neither skills nor overrides provide
  // anything — otherwise the agent wakes up with an empty prompt body.
  if (checklist.length === 0) {
    // Respect legacy free-text `heartbeat_config.checklist` if present.
    const legacy = typeof employee.heartbeat_config === 'string'
      ? employee.heartbeat_config
      : (employee.heartbeat_config as { checklist?: string } | null)
          ?.checklist ?? '';
    if (legacy) {
      checklist = uniqueChecklist(
        legacy.split(/\r?\n/).map((l) => l.replace(/^[-*]\s*/, '').trim()),
      );
    }
    if (checklist.length === 0) checklist = [...DEFAULT_CHECKLIST];
  }

  // 3. Load recent context. Everything org-scoped — callers only hit this
  //    with trusted employee ids, and the joins below all pin org_id.
  const spaceIds = (employee.space_ids ?? []).filter(
    (s): s is string => typeof s === 'string' && !!s,
  );

  const recentMessages = spaceIds.length
    ? await db
        .select({
          space_id: messages.space_id,
          user_name: users.name,
          content: messages.content,
          created_at: messages.created_at,
        })
        .from(messages)
        .innerJoin(users, eq(users.id, messages.user_id))
        .where(
          and(
            eq(messages.org_id, employee.org_id),
            eq(messages.is_deleted, false),
            inArray(messages.space_id, spaceIds),
          ),
        )
        .orderBy(desc(messages.created_at))
        .limit(12) // keep the payload small; 3 msgs x up to 4 spaces
    : [];

  const openTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      due_date: tasks.due_date,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.org_id, employee.org_id),
        eq(tasks.is_deleted, false),
        eq(tasks.assignee_id, employee.user_id),
        or(
          eq(tasks.status, 'backlog'),
          eq(tasks.status, 'todo'),
          eq(tasks.status, 'in_progress'),
          eq(tasks.status, 'in_review'),
        ),
      ),
    )
    .orderBy(desc(tasks.updated_at))
    .limit(10);

  const tasksCreated = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      created_at: tasks.created_at,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.org_id, employee.org_id),
        eq(tasks.is_deleted, false),
        eq(tasks.created_by, employee.user_id),
        sql`${tasks.created_at} > NOW() - INTERVAL '24 hours'`,
      ),
    )
    .orderBy(desc(tasks.created_at))
    .limit(10);

  // 4. Compose the final prompt. The checklist is primary; the context
  //    sections are read-only data points the agent can reference.
  const ctx: HeartbeatContext = {
    employee_id: employee.id,
    slug: employee.slug,
    org_id: employee.org_id,
    recent_messages: recentMessages.map((m) => ({
      space_id: m.space_id,
      user_name: m.user_name ?? null,
      content: m.content.slice(0, 400),
      created_at:
        m.created_at instanceof Date
          ? m.created_at.toISOString()
          : String(m.created_at ?? ''),
    })),
    open_tasks: openTasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority ?? null,
      due_date:
        t.due_date instanceof Date
          ? t.due_date.toISOString()
          : t.due_date
            ? String(t.due_date)
            : null,
    })),
    tasks_created_24h: tasksCreated.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      created_at:
        t.created_at instanceof Date
          ? t.created_at.toISOString()
          : String(t.created_at ?? ''),
    })),
  };

  const promptLines: string[] = [];
  promptLines.push('HEARTBEAT CHECK — scheduled wake-up.');
  promptLines.push('');
  promptLines.push(`You are ${employee.name} (${employee.slug}).`);
  promptLines.push('');
  promptLines.push('## Checklist');
  for (const item of checklist) {
    promptLines.push(`- ${item}`);
  }
  promptLines.push('');
  promptLines.push('## Open tasks assigned to you');
  if (ctx.open_tasks.length === 0) {
    promptLines.push('(none)');
  } else {
    for (const t of ctx.open_tasks) {
      const due = t.due_date ? ` · due ${t.due_date}` : '';
      const pri = t.priority ? ` · ${t.priority}` : '';
      promptLines.push(`- [${t.status}${pri}${due}] ${t.title}`);
    }
  }
  promptLines.push('');
  promptLines.push('## Tasks you created in the last 24h');
  if (ctx.tasks_created_24h.length === 0) {
    promptLines.push('(none)');
  } else {
    for (const t of ctx.tasks_created_24h) {
      promptLines.push(`- [${t.status}] ${t.title}`);
    }
  }
  promptLines.push('');
  promptLines.push('## Recent messages in your spaces');
  if (ctx.recent_messages.length === 0) {
    promptLines.push('(none)');
  } else {
    for (const m of ctx.recent_messages.slice(0, 6)) {
      promptLines.push(
        `- [${m.user_name ?? 'user'} in ${m.space_id}] ${m.content}`,
      );
    }
  }
  promptLines.push('');
  promptLines.push('## Instructions');
  promptLines.push('1. Work through the checklist using your tools.');
  promptLines.push('2. Act only on items that genuinely need attention right now.');
  promptLines.push('3. If nothing needs attention, respond with HEARTBEAT_OK.');

  const prompt = promptLines.join('\n');

  // Task 8.6 uses this sha for idempotency. Exclude timestamps from the
  // normalized digest so two consecutive identical ticks hash the same.
  const normalized = prompt
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<ts>')
    .replace(/\s+/g, ' ')
    .trim();
  const prompt_sha = crypto
    .createHash('sha256')
    .update(`${employee.id}::${normalized}`)
    .digest('hex');

  return { prompt, context: ctx, prompt_sha, checklist };
}

// Unused import quieteners (kept wired for later tasks that lean on them).
void isNull;
void spaceMembers;
