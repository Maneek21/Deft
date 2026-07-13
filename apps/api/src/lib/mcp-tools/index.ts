/**
 * Phase 3 MCP tool registry.
 *
 * READ_ONLY_TOOLS are always available to any resolved BYOA agent employee.
 * WRITE_TOOLS are the Phase 3 subset that doesn't need approval gating —
 * `memory_write` writes into the caller employee's own scope which is
 * always-allowed. Everything else that writes (task_create, message_post,
 * space_memory_set, memory_update for scope promotion, delegation_self_report)
 * ships in Phase 4.
 *
 * `toolSchemas` is the JSON Schema catalog returned by `POST /tools/list`.
 * The shapes are intentionally lightweight — Phase 3 exists to unblock
 * the BYOA agent handshake, not to teach the agent every nuance.
 */
import type { ToolContext, ToolResult } from './types.js';

import { platformContext } from './context.js';
import { memoryRecall, memoryWrite, memoryList } from './memory.js';
import { memoryUpdate } from './memory-update.js';
import { taskQuery } from './tasks.js';
import { memberList } from './members.js';
import { threadFetch, fetchUnread } from './messages.js';
import { taskCreate, taskUpdate, messagePost, sendMessage } from './writes.js';
import { wikiCreate, wikiUpdate } from './wiki-create.js';
import { spaceMemoryGet, spaceMemorySet } from './space-memory.js';
import { delegationSelfReport } from './delegation.js';
import { eventsQuery } from './events.js';
import { taskDetail, messagesSearch, projectProgress, teamWorkload } from './reports.js';
import { teamList, teamGet, teamContext } from './team-context.js';
import {
  recordConversationTurn,
  recordDecision,
  recordOutcome,
  recordReasoningStep,
  recordActionAttempt,
  requestHumanApproval,
  pollPendingWork,
  pingAlive,
} from './cooperative.js';

export type ToolHandler = (args: any, ctx: ToolContext) => Promise<ToolResult>;

export const READ_ONLY_TOOLS: Record<string, ToolHandler> = {
  platform_context: platformContext as ToolHandler,
  memory_recall: memoryRecall as ToolHandler,
  memory_list: memoryList as ToolHandler,
  task_query: taskQuery as ToolHandler,
  thread_fetch: threadFetch as ToolHandler,
  member_list: memberList as ToolHandler,
  space_memory_get: spaceMemoryGet as ToolHandler,
  events_query: eventsQuery as ToolHandler,
  // Path C Phase 1 — ported from the deprecated /mcp REST surface
  task_detail: taskDetail as ToolHandler,
  messages_search: messagesSearch as ToolHandler,
  project_progress: projectProgress as ToolHandler,
  team_workload: teamWorkload as ToolHandler,
  team_list: teamList as ToolHandler,
  team_get: teamGet as ToolHandler,
  team_context: teamContext as ToolHandler,
  // Self-hosted v1 — control surface. Read-only from Deft's perspective
  // (they query pending work or bump a timestamp) so they live with the
  // always-available reads.
  poll_pending_work: pollPendingWork as ToolHandler,
  ping_alive: pingAlive as ToolHandler,
  fetch_unread: fetchUnread as ToolHandler,
};

export const TOOL_ALIASES: Record<string, string> = {
  wiki_search: 'memory_recall',
};

export const WRITE_TOOLS: Record<string, ToolHandler> = {
  memory_write: memoryWrite as ToolHandler,
  memory_update: memoryUpdate as ToolHandler,
  wiki_create: wikiCreate as ToolHandler,
  wiki_update: wikiUpdate as ToolHandler,
  task_create: taskCreate as ToolHandler,
  task_update: taskUpdate as ToolHandler,
  message_post: messagePost as ToolHandler,
  send_message: sendMessage as ToolHandler,
  space_memory_set: spaceMemorySet as ToolHandler,
  delegation_self_report: delegationSelfReport as ToolHandler,
  // Self-hosted v1 — cooperative knowledge. Aspirational, no approval
  // gating; they append agent-volunteered records to agent_cooperative_log.
  record_conversation_turn: recordConversationTurn as ToolHandler,
  record_decision: recordDecision as ToolHandler,
  record_outcome: recordOutcome as ToolHandler,
  record_reasoning_step: recordReasoningStep as ToolHandler,
  record_action_attempt: recordActionAttempt as ToolHandler,
  // Request for human approval — queues an agent_actions row.
  request_human_approval: requestHumanApproval as ToolHandler,
};

export const ALL_TOOLS: Record<string, ToolHandler> = {
  ...READ_ONLY_TOOLS,
  ...WRITE_TOOLS,
};

// ─── JSON Schemas for `tools/list` ────────────────────────────────────────

type ToolSchema = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const CALLER_SLUG_PROP = {
  caller_employee_slug: {
    type: 'string',
    description:
      'The slug of the employee that is making the call. ' +
      'Required on every MCP tool call so Deft can scope trust level + memory.',
  },
};

export const toolSchemas: ToolSchema[] = [
  {
    name: 'platform_context',
    description:
      'Returns the dynamic platform context for the calling employee: today\'s ' +
      'date, org + role info, teammates, active projects, and relevant wiki ' +
      'snippets. Call this first on every turn — it is the source of truth for ' +
      'who you are, what day it is, and what you know. ' +
      'The response also includes context_packets that separate company, channel, and employee memory.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        trigger: {
          type: 'object',
          description:
            'Optional trigger descriptor that told Deft to wake you up. Shapes ' +
            'include {kind, space_id, triggering_message_id}.',
          additionalProperties: true,
        },
      },
      required: ['caller_employee_slug'],
    },
  },
  {
    name: 'memory_recall',
    description:
      'Search the org wiki for knowledge pages. Returns title, summary, and content (truncated to 2000 chars, with a `truncated` flag for longer pages). Use for answering questions about previously saved knowledge.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        query: { type: 'string', description: 'Natural language query text' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
        space_id: {
          type: 'string',
          description:
            'Optional channel/space id. When provided, recall is scoped to memory relevant to that space.',
        },
        include_org: {
          type: 'boolean',
          description:
            'When space_id is provided, include org/company memory alongside channel-specific memory. Default true. Set false for channel-only recall.',
        },
        scope: {
          type: 'string',
          enum: ['own', 'org', 'all'],
          description: 'Scope filter. Default is `all` (own + org).',
        },
      },
      required: ['caller_employee_slug', 'query'],
    },
  },
  {
    name: 'wiki_search',
    description:
      'Compatibility alias for memory_recall. BYOA agents should prefer memory_recall; wiki_search is accepted for older prompts and native-agent wording.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        query: { type: 'string', description: 'Natural language query text' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
        space_id: {
          type: 'string',
          description:
            'Optional channel/space id. When provided, recall is scoped to memory relevant to that space.',
        },
        include_org: {
          type: 'boolean',
          description:
            'When space_id is provided, include org/company memory alongside channel-specific memory. Default true. Set false for channel-only recall.',
        },
        scope: {
          type: 'string',
          enum: ['own', 'org', 'all'],
          description: 'Scope filter. Default is `all` (own + org).',
        },
      },
      required: ['caller_employee_slug', 'query'],
    },
  },
  {
    name: 'memory_list',
    description: 'Enumerate wiki pages you own plus org-wide pages.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        type: {
          type: 'string',
          enum: [
            'concept',
            'entity',
            'decision',
            'resource',
            'procedure',
            'preference',
            'fact',
          ],
        },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['caller_employee_slug'],
    },
  },
  {
    name: 'memory_write',
    description:
      "Persist knowledge to the org wiki. This is the ONLY tool for durable memory — use it whenever asked to 'remember', 'save', 'note', or 'track' information. Creates a searchable wiki page visible to the whole org.",
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        title: { type: 'string' },
        body: { type: 'string' },
        type: {
          type: 'string',
          enum: [
            'concept',
            'entity',
            'decision',
            'resource',
            'procedure',
            'preference',
            'fact',
          ],
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['caller_employee_slug', 'title', 'body', 'type'],
    },
  },
  {
    name: 'task_query',
    description:
      'Query visible tasks using the same canonical fields as the task table. Returns compact task rows; use task_get/get_task_detail for full descriptions and activity.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        filter: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            assignee_id: { type: 'string' },
            project_id: { type: 'string' },
          },
          additionalProperties: false,
        },
        project_id: { type: 'string' },
        mine: { type: 'boolean' },
        assignee_ids: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        statuses: { type: 'array', items: { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'] }, maxItems: 6 },
        priorities: { type: 'array', items: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] }, maxItems: 4 },
        label_ids: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        due: { type: 'string', enum: ['overdue', 'today', 'this_week'] },
        date_from: { type: 'string', description: 'Due-date lower bound as ISO date.' },
        date_to: { type: 'string', description: 'Due-date upper bound as ISO date.' },
        sort: {
          type: 'object',
          properties: {
            field: { type: 'string', enum: ['number', 'title', 'status', 'priority', 'assignee', 'start_date', 'due_date', 'estimation', 'updated_at', 'project'] },
            direction: { type: 'string', enum: ['asc', 'desc'] },
          },
          additionalProperties: false,
        },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['caller_employee_slug'],
    },
  },
  {
    name: 'thread_fetch',
    description:
      'Fetch the parent message plus its replies for a given thread. Use this ' +
      'to ground your reply in the conversation history.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        parent_message_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['caller_employee_slug', 'parent_message_id'],
    },
  },
  {
    name: 'fetch_unread',
    description:
      'Fetch unread messages (in spaces the caller is a member of) plus pending ' +
      'agent_actions. One roundtrip surfaces both kinds of pending work. ' +
      'Replaces poll_pending_work.',
    inputSchema: {
      type: 'object',
      properties: {
        caller_employee_slug: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
        space_id: { type: 'string', description: 'Optional — restrict to one space.' },
      },
      required: ['caller_employee_slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'member_list',
    description:
      'List org members with role + email. Used to resolve @mentions and ' +
      'identify who is on the team.',
    inputSchema: {
      type: 'object',
      properties: { ...CALLER_SLUG_PROP },
      required: ['caller_employee_slug'],
    },
  },
  {
    name: 'events_query',
    description:
      'Query the unified events stream for native activity, calendar events, ' +
      'imported ICS feeds, and connected-tool events. ' +
      'Filter by type, source, and a since/until time window. ' +
      'Returns the most recent events ordered by event timestamp descending. ' +
      'Default limit is 50, max 200. Scoped to your org automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        type: {
          type: 'string',
          description:
            'Single event_type to filter by (e.g. "calendar_event"). Mutually exclusive with `types`.',
        },
        types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of event_type values to filter by (OR).',
        },
        source: {
          type: 'string',
          enum: ['native', 'google_calendar', 'ics', 'github', 'linear'],
          description: 'Optional provider source filter.',
        },
        since: {
          type: 'string',
          description: 'ISO8601 timestamp — only return events at/after this time.',
        },
        until: {
          type: 'string',
          description: 'ISO8601 timestamp — only return events at/before this time.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['caller_employee_slug'],
    },
  },
  // ─── Phase 4 — write tools with approval gating ──────────────────────
  {
    name: 'task_create',
    description:
      'Create a task on the board. May auto-execute or return ' +
      '`queued_for_approval` depending on the employee\'s trust level. If ' +
      'queued, tell the user the task will be created once approved.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        title: { type: 'string' },
        description: { type: 'string' },
        project_id: { type: 'string' },
        space_id: { type: 'string' },
        assignee_id: { type: 'string' },
        assignee_name: {
          type: 'string',
          description:
            'Optional assignee display name. Use when you know the person name but not the user id; Deft resolves it inside the caller org.',
        },
        source_message_id: {
          type: 'string',
          description: 'Optional source chat message id to link the created task back to the conversation.',
        },
        priority: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] },
        due_date: {
          type: 'string',
          description: 'Optional ISO date/timestamp for the parent task due date.',
        },
        start_date: {
          type: 'string',
          description: 'Optional ISO date/timestamp for the parent task start date.',
        },
        estimation: {
          type: 'string',
          description: 'Optional parent task estimate such as 30m, 2h, or 1d.',
        },
        size: { type: 'string' },
        subtasks: {
          type: 'array',
          description:
            'Optional real subtasks to create under the parent task. Use this for child tasks/checklists; do not bury requested subtasks only in description text.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              assignee_id: { type: 'string' },
              assignee_name: { type: 'string' },
              priority: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] },
              due_date: { type: 'string' },
              start_date: { type: 'string' },
              estimation: { type: 'string' },
              depends_on: {
                type: 'array',
                items: { type: 'number' },
                description: 'Optional 1-based numbers of earlier subtasks that block this subtask.',
              },
            },
            required: ['title'],
          },
        },
      },
      required: ['caller_employee_slug', 'title'],
    },
  },
  {
    name: 'task_update',
    description:
      'Update fields on an existing task. May auto-execute or return ' +
      '`queued_for_approval` depending on trust level.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        task_id: { type: 'string' },
        patch: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            status: {
              type: 'string',
              enum: ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'],
            },
            priority: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] },
            assignee_id: { type: ['string', 'null'] },
            due_date: {
              type: ['string', 'null'],
              description: 'ISO-8601 due date, or null to clear it.',
            },
            comment: {
              type: 'string',
              description: 'Add this text as a task comment without replacing the task description.',
            },
          },
          additionalProperties: false,
        },
      },
      required: ['caller_employee_slug', 'task_id', 'patch'],
    },
  },
  {
    name: 'message_post',
    description:
      'Post a message to a space as your shadow user. This is a full-review ' +
      'action — it will typically return `queued_for_approval` and post once ' +
      'a human approves.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        space_id: { type: 'string' },
        content: { type: 'string' },
        parent_id: { type: 'string', description: 'Optional thread parent id' },
      },
      required: ['caller_employee_slug', 'space_id', 'content'],
    },
  },
  {
    name: 'send_message',
    description:
      'Send a chat message. Target is one of: a space, a thread (reply to a ' +
      'parent message), or a user (DM — auto-creates a 1:1 space if needed). ' +
      'Replaces message_post + post_thread_reply.',
    inputSchema: {
      type: 'object',
      properties: {
        caller_employee_slug: { type: 'string', description: 'Slug of the calling employee.' },
        target: {
          oneOf: [
            {
              type: 'object',
              required: ['space_id'],
              properties: { space_id: { type: 'string' } },
              additionalProperties: false,
            },
            {
              type: 'object',
              required: ['thread_id'],
              properties: {
                thread_id: {
                  type: 'string',
                  description: 'Parent message id — reply lands as a thread reply under it.',
                },
              },
              additionalProperties: false,
            },
            {
              type: 'object',
              required: ['user_id'],
              properties: {
                user_id: {
                  type: 'string',
                  description: 'DM target user. Auto-creates a 1:1 DM space if one does not exist.',
                },
              },
              additionalProperties: false,
            },
          ],
        },
        content: { type: 'string', minLength: 1 },
      },
      required: ['caller_employee_slug', 'target', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_update',
    description:
      'Update one of your existing wiki pages. Scope promotion to org-wide ' +
      'requires human approval unless your trust level is autonomous.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        slug: { type: 'string' },
        patch: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            scope: { type: 'string', enum: ['user', 'org'] },
          },
          additionalProperties: false,
        },
      },
      required: ['caller_employee_slug', 'slug', 'patch'],
    },
  },
  {
    name: 'wiki_create',
    description:
      'Create a governed wiki page with source attribution and approval gating. Prefer this over memory_write when capturing shared team knowledge from a chat/source message.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        title: { type: 'string' },
        content: { type: 'string' },
        summary: { type: 'string' },
        type: {
          type: 'string',
          enum: ['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact'],
        },
        scope: { type: 'string', enum: ['org', 'space', 'user'] },
        space_id: { type: ['string', 'null'] },
        source_message_id: { type: ['string', 'null'] },
        source_space_id: { type: ['string', 'null'] },
        source_user_id: { type: ['string', 'null'] },
        tags: { type: 'array', items: { type: 'string' } },
        metadata: { type: ['object', 'null'], additionalProperties: true },
      },
      required: ['caller_employee_slug', 'title', 'content'],
    },
  },
  {
    name: 'wiki_update',
    description:
      'Update an existing wiki page through the governed approval path. Writes a page-version snapshot, operation log, optional source citation, and refreshes search.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        page_id: { type: 'string' },
        slug: { type: 'string' },
        patch: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
            summary: { type: ['string', 'null'] },
            type: {
              type: 'string',
              enum: ['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact'],
            },
            scope: { type: 'string', enum: ['org', 'space', 'user'] },
            space_id: { type: ['string', 'null'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            tags: { type: 'array', items: { type: 'string' } },
            metadata: { type: ['object', 'null'], additionalProperties: true },
          },
          additionalProperties: false,
        },
        source_message_id: { type: ['string', 'null'] },
        source_space_id: { type: ['string', 'null'] },
        source_user_id: { type: ['string', 'null'] },
        capture_reason: { type: ['string', 'null'] },
      },
      required: ['caller_employee_slug', 'patch'],
    },
  },
  {
    name: 'space_memory_get',
    description:
      'Read a value from the per-space key/value bag. Use this to recall ' +
      'space-scoped state you stored on a previous turn.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        space_id: { type: 'string' },
        key: { type: 'string' },
      },
      required: ['caller_employee_slug', 'space_id', 'key'],
    },
  },
  {
    name: 'space_memory_set',
    description:
      'Store a value in the per-space key/value bag. Auto-executes (no ' +
      'approval) because writes are bounded to a single space.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        space_id: { type: 'string' },
        key: { type: 'string' },
        value: {},
      },
      required: ['caller_employee_slug', 'space_id', 'key', 'value'],
    },
  },
  {
    name: 'delegation_self_report',
    description:
      'Audit log: tell Deft that you delegated a sub-task to another ' +
      'agent employee. Deft cannot observe internal delegations — this ' +
      'is how you volunteer visibility into your own reasoning chain.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        target_employee_slug: { type: 'string' },
        reason: { type: 'string' },
        session_id: { type: 'string' },
      },
      required: ['caller_employee_slug', 'target_employee_slug', 'reason'],
    },
  },
  // ─── Path C Phase 1 — ported from /mcp REST surface ──────────────────
  {
    name: 'task_detail',
    description:
      'Get the full detail of a single task including comments and recent activity. Use this after task_query when you need the full conversation around a specific item.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        task_identifier: {
          type: 'string',
          description: 'The task id like "DEFT-42" — the project prefix + number form users see in the UI.',
        },
      },
      required: ['caller_employee_slug', 'task_identifier'],
    },
  },
  {
    name: 'messages_search',
    description:
      'Search chat messages across every space in the caller\'s org. Use for "what did X say about Y" questions. Filter by space name or author name.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        query: { type: 'string', description: 'Search keywords.' },
        space_name: { type: 'string', description: 'Optional: filter to a specific space.' },
        author_name: { type: 'string', description: 'Optional: filter by author.' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['caller_employee_slug', 'query'],
    },
  },
  {
    name: 'project_progress',
    description:
      'Summarize progress across one project: counts by status, completion rate, recent velocity. Pass either project_identifier (prefix, e.g. "DEFT") or project_name.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        project_id: { type: 'string', description: 'Exact Deft project id. Prefer this when known.' },
        project_identifier: { type: 'string' },
        project_name: { type: 'string' },
      },
      required: ['caller_employee_slug'],
    },
  },
  {
    name: 'team_workload',
    description:
      'Get the team-wide workload snapshot over the last N days — tasks open, in-progress, overdue, and closed by assignee. Default window is 7 days.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        days: { type: 'integer', minimum: 1, maximum: 90, description: 'Window in days (default 7).' },
      },
      required: ['caller_employee_slug'],
    },
  },
  // ─── Self-hosted v1 — cooperative knowledge + control tools ──────────
  {
    name: 'team_list',
    description:
      'List first-class Deft teams the caller can see, including leads, member counts, agent member counts, and linked resource counts. Use this before team_get/team_context when the user names a team loosely.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        query: { type: 'string', description: 'Optional search across team name, handle, and description.' },
        include_archived: { type: 'boolean', description: 'Include archived teams. Defaults to false.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['caller_employee_slug'],
    },
  },
  {
    name: 'team_get',
    description:
      'Fetch one visible Deft team by id, handle, or query. Returns team profile, normalized human/agent members, linked spaces/projects/wiki/notes/calendar feeds/templates/agents, and next tool hints.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        team_id: { type: 'string', description: 'Exact team id when known.' },
        handle: { type: 'string', description: 'Team handle such as marketing or field-ops.' },
        query: { type: 'string', description: 'Natural-language team name when id/handle is unknown.' },
        include_archived: { type: 'boolean', description: 'Allow archived team resolution. Defaults to false.' },
      },
      required: ['caller_employee_slug'],
    },
  },
  {
    name: 'team_context',
    description:
      'Retrieve a team-specific context packet for work execution: team profile, members, linked resources, open tasks from linked projects, workload by owner/status, and recent messages from accessible linked spaces. Use this to ground Codex/Claude/agent workflows in a team rather than broad org context.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        team_id: { type: 'string', description: 'Exact team id when known.' },
        handle: { type: 'string', description: 'Team handle such as marketing or field-ops.' },
        query: { type: 'string', description: 'Natural-language team name when id/handle is unknown.' },
        include_archived: { type: 'boolean', description: 'Allow archived team resolution. Defaults to false.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max open tasks/recent messages to return.' },
      },
      required: ['caller_employee_slug'],
    },
  },
  {
    name: 'record_conversation_turn',
    description:
      'Volunteer a record of an inbound message or conversation turn you ' +
      'just handled. Deft can\'t observe everything that reaches you — use ' +
      'this to share the context you acted on.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        summary: { type: 'string', description: 'Free-form summary of the turn.' },
        metadata: { type: 'object', additionalProperties: true },
        session_turn_id: { type: 'string' },
      },
      required: ['caller_employee_slug', 'summary'],
    },
  },
  {
    name: 'record_decision',
    description:
      'Record a choice you made, the alternatives you weighed, and the ' +
      'rationale. Use this whenever you commit to a non-obvious direction.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        summary: { type: 'string', description: 'What you decided.' },
        metadata: {
          type: 'object',
          additionalProperties: true,
          description:
            'Shape suggestion: { alternatives?: string[], rationale?: string, confidence?: number }.',
        },
        session_turn_id: { type: 'string' },
      },
      required: ['caller_employee_slug', 'summary'],
    },
  },
  {
    name: 'record_outcome',
    description:
      'Record the outcome of an action you took — whether it succeeded, ' +
      'what the effect was, and any follow-up you think is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        summary: { type: 'string' },
        metadata: {
          type: 'object',
          additionalProperties: true,
          description:
            'Shape suggestion: { status: "success"|"failure"|"partial", action?: string, effect?: string }.',
        },
        session_turn_id: { type: 'string' },
      },
      required: ['caller_employee_slug', 'summary'],
    },
  },
  {
    name: 'record_reasoning_step',
    description:
      'Record an internal reasoning beat you want visible outside the turn ' +
      '— the kind of thought you would normally keep to yourself. Useful ' +
      'when a later review needs to reconstruct why you went somewhere.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        summary: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true },
        session_turn_id: { type: 'string' },
      },
      required: ['caller_employee_slug', 'summary'],
    },
  },
  {
    name: 'record_action_attempt',
    description:
      'Record an action you attempted, regardless of whether it was ' +
      'approved or executed. Use this to self-report attempts that happen ' +
      'outside a tool call Deft would otherwise see.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        summary: { type: 'string' },
        metadata: {
          type: 'object',
          additionalProperties: true,
          description:
            'Shape suggestion: { action: string, params?: object, blocked_by?: string }.',
        },
        session_turn_id: { type: 'string' },
      },
      required: ['caller_employee_slug', 'summary'],
    },
  },
  {
    name: 'request_human_approval',
    description:
      'Queue an item for a human to review in the native approval UI. Use ' +
      'this when you hit a decision the human must own — external ' +
      'outreach, destructive edits, anything outside your trust level. ' +
      'Returns an action_id; poll `poll_pending_work` for the resolution.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        action: {
          type: 'string',
          enum: [
            'task_create',
            'task_update',
            'message_post',
            'send_message',
            'memory_update',
            'wiki_create',
            'wiki_update',
            'add_task_comment',
          ],
          description:
            'Native Deft action to review. Use add_task_comment as a ' +
            'convenience alias with params.task_id and params.comment; it ' +
            'is normalized to task_update before it enters the queue.',
        },
        summary: {
          type: 'string',
          description: 'Human-facing description of what you\'re asking to do.',
        },
        params: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional structured payload for the reviewer.',
        },
      },
      required: ['caller_employee_slug', 'action', 'summary'],
    },
  },
  {
    name: 'poll_pending_work',
    description:
      'Return pending approval rows for this employee (including ones ' +
      'you submitted via `request_human_approval`). Used as the idle-loop ' +
      'wake-up check when running headless.',
    inputSchema: {
      type: 'object',
      properties: { ...CALLER_SLUG_PROP },
      required: ['caller_employee_slug'],
    },
  },
  {
    name: 'ping_alive',
    description:
      'Bump your heartbeat timestamp. Call periodically from an autonomous ' +
      'loop so Deft\'s connectivity indicators stay green.',
    inputSchema: {
      type: 'object',
      properties: { ...CALLER_SLUG_PROP },
      required: ['caller_employee_slug'],
    },
  },
];
