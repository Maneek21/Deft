/**
 * Phase 3 MCP tool registry.
 *
 * READ_ONLY_TOOLS are always available to any resolved Gateway employee.
 * WRITE_TOOLS are the Phase 3 subset that doesn't need approval gating —
 * `memory_write` writes into the caller employee's own scope which is
 * always-allowed. Everything else that writes (task_create, message_post,
 * space_memory_set, memory_update for scope promotion, delegation_self_report)
 * ships in Phase 4.
 *
 * `toolSchemas` is the JSON Schema catalog returned by `POST /tools/list`.
 * The shapes are intentionally lightweight — Phase 3 exists to unblock
 * OpenClaw handshake, not to teach the agent every nuance.
 */
import type { ToolContext, ToolResult } from './types.js';

import { platformContext } from './context.js';
import { memoryRecall, memoryWrite, memoryList } from './memory.js';
import { memoryUpdate } from './memory-update.js';
import { taskQuery } from './tasks.js';
import { memberList } from './members.js';
import { threadFetch } from './messages.js';
import { taskCreate, taskUpdate, messagePost } from './writes.js';
import { spaceMemoryGet, spaceMemorySet } from './space-memory.js';
import { delegationSelfReport } from './delegation.js';

export type ToolHandler = (args: any, ctx: ToolContext) => Promise<ToolResult>;

export const READ_ONLY_TOOLS: Record<string, ToolHandler> = {
  platform_context: platformContext as ToolHandler,
  memory_recall: memoryRecall as ToolHandler,
  memory_list: memoryList as ToolHandler,
  task_query: taskQuery as ToolHandler,
  thread_fetch: threadFetch as ToolHandler,
  member_list: memberList as ToolHandler,
  space_memory_get: spaceMemoryGet as ToolHandler,
};

export const WRITE_TOOLS: Record<string, ToolHandler> = {
  memory_write: memoryWrite as ToolHandler,
  memory_update: memoryUpdate as ToolHandler,
  task_create: taskCreate as ToolHandler,
  task_update: taskUpdate as ToolHandler,
  message_post: messagePost as ToolHandler,
  space_memory_set: spaceMemorySet as ToolHandler,
  delegation_self_report: delegationSelfReport as ToolHandler,
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
      'The slug of the employee on this Gateway that is making the call. ' +
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
      'who you are, what day it is, and what you know.',
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
      'Search your wiki memory plus org-wide pages for relevant context. ' +
      'Uses full-text ranking blended with page confidence. Returns up to ' +
      '`limit` pages (default 5).',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER_SLUG_PROP,
        query: { type: 'string', description: 'Natural language query text' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
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
      'Write a new wiki page scoped to your employee. Use this to remember ' +
      'facts, decisions, procedures, or preferences that you learn during a ' +
      'session.',
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
      'Read the task board. Filter by status, assignee, or project. Returns ' +
      'the top 20 matching tasks by most-recently-updated.',
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
        limit: { type: 'integer', minimum: 1, maximum: 50 },
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
        priority: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] },
        size: { type: 'string' },
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
      'OpenClaw employee. Deft cannot observe internal delegations — this ' +
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
];
