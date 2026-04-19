import type Anthropic from '@anthropic-ai/sdk';

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_messages',
    description:
      'Search chat messages across spaces in the organization. Use for questions about conversations, decisions, or what people said.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search keywords' },
        space_name: { type: 'string', description: 'Optional: filter to a specific space name' },
        author_name: { type: 'string', description: 'Optional: filter by message author name' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_my_tasks',
    description:
      "Return tasks assigned to the current caller (primary assignee or in task_assignees). Defaults to active tasks only (excludes done and cancelled); pass a status to override.",
    input_schema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          description: 'Optional status filter (backlog, todo, in_progress, in_review, done, cancelled)',
        },
      },
      required: [],
    },
  },
  {
    name: 'search_tasks',
    description:
      'Search tasks across all projects. Use for questions about work items, their status, assignments, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search by title or description keywords' },
        status: {
          type: 'string',
          description: 'Filter by status: backlog, todo, in_progress, in_review, done',
        },
        assignee_name: { type: 'string', description: 'Filter by assignee name' },
        project_name: { type: 'string', description: 'Filter by project name' },
        priority: { type: 'string', description: 'Filter by priority: p0, p1, p2, p3' },
        overdue: { type: 'boolean', description: 'If true, only return overdue tasks' },
      },
      required: [],
    },
  },
  {
    name: 'get_task_detail',
    description: 'Get detailed info about a specific task including comments and activity.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_identifier: {
          type: 'string',
          description: 'Task ID like DEFT-5 or the task UUID',
        },
      },
      required: ['task_identifier'],
    },
  },
  {
    name: 'create_task',
    description: 'Create a new task in a project. REQUIRES USER APPROVAL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Task title' },
        project_name: { type: 'string', description: 'Project name (e.g., "Deft v1")' },
        priority: {
          type: 'string',
          enum: ['p0', 'p1', 'p2', 'p3'],
          description: 'Priority',
        },
        assignee_name: { type: 'string', description: 'Assignee name' },
        due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format' },
        description: { type: 'string', description: 'Task description' },
        source_message_id: {
          type: 'string',
          description:
            'Optional — id of the chat message that prompted this task. Usually set automatically; leave empty unless you are linking to a specific different message.',
        },
      },
      required: ['title', 'project_name'],
    },
  },
  {
    name: 'update_task_status',
    description: 'Change the status of a task. REQUIRES USER APPROVAL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_identifier: { type: 'string', description: 'Task ID like DEFT-5' },
        new_status: {
          type: 'string',
          enum: ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'],
        },
      },
      required: ['task_identifier', 'new_status'],
    },
  },
  {
    name: 'assign_task',
    description: 'Assign a task to a team member. REQUIRES USER APPROVAL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_identifier: { type: 'string', description: 'Task ID like DEFT-5' },
        assignee_name: {
          type: 'string',
          description: 'Name of the person to assign to',
        },
      },
      required: ['task_identifier', 'assignee_name'],
    },
  },
  {
    name: 'comment_on_task',
    description:
      'Add a comment to a task. Use this to share an update, note a blocker, or answer a question visible on the task card.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_identifier: { type: 'string', description: 'Task ID like DEFT-5 or the task UUID' },
        content: { type: 'string', description: 'Comment body (markdown)' },
      },
      required: ['task_identifier', 'content'],
    },
  },
  {
    name: 'set_due_date',
    description:
      'Set or clear a task due date. Pass an ISO date string (YYYY-MM-DD) or omit due_date to clear.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_identifier: { type: 'string', description: 'Task ID like DEFT-5' },
        due_date: {
          type: 'string',
          description: 'Due date in YYYY-MM-DD or ISO-8601 format. Omit or empty to clear.',
        },
      },
      required: ['task_identifier'],
    },
  },
  {
    name: 'set_priority',
    description: 'Change the priority of a task (p0 = urgent through p3 = low).',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_identifier: { type: 'string', description: 'Task ID like DEFT-5' },
        priority: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] },
      },
      required: ['task_identifier', 'priority'],
    },
  },
  {
    name: 'add_label',
    description:
      'Attach a label to a task. If the label does not exist yet it is created with a default color.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_identifier: { type: 'string', description: 'Task ID like DEFT-5' },
        label_name: { type: 'string', description: 'Label text' },
        color: { type: 'string', description: 'Optional hex color for new labels' },
      },
      required: ['task_identifier', 'label_name'],
    },
  },
  {
    name: 'close_task',
    description: 'Mark a task as done. Thin wrapper over update_task_status.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_identifier: { type: 'string', description: 'Task ID like DEFT-5' },
      },
      required: ['task_identifier'],
    },
  },
  {
    name: 'reopen_task',
    description: 'Move a done/cancelled task back to todo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_identifier: { type: 'string', description: 'Task ID like DEFT-5' },
      },
      required: ['task_identifier'],
    },
  },
  {
    name: 'create_reminder',
    description:
      'Set a durable reminder for the user. Fires a notification at remind_at. Reminder survives server restarts. Use for "remind me to ..." style requests.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: {
          type: 'string',
          description:
            'Reminder text that will appear in the notification title + body.',
        },
        remind_at: {
          type: 'string',
          description:
            'Fire time as ISO-8601 datetime (e.g. 2026-04-20T09:00:00Z). Must be in the future.',
        },
      },
      required: ['content', 'remind_at'],
    },
  },
  {
    name: 'add_dependency',
    description:
      'Link two tasks with a relationship. "blocks" / "blocked_by" are orderings (A must finish before B); "relates_to" and "duplicates" are semantic pointers. Refuses edges that would close a cycle.',
    input_schema: {
      type: 'object' as const,
      properties: {
        source_task_identifier: { type: 'string', description: 'From task ID like DEFT-5' },
        target_task_identifier: { type: 'string', description: 'To task ID like DEFT-9' },
        type: {
          type: 'string',
          enum: ['blocks', 'blocked_by', 'relates_to', 'duplicates'],
        },
      },
      required: ['source_task_identifier', 'target_task_identifier', 'type'],
    },
  },
  {
    name: 'remove_dependency',
    description: 'Remove a previously-added task relationship.',
    input_schema: {
      type: 'object' as const,
      properties: {
        source_task_identifier: { type: 'string' },
        target_task_identifier: { type: 'string' },
        type: {
          type: 'string',
          enum: ['blocks', 'blocked_by', 'relates_to', 'duplicates'],
        },
      },
      required: ['source_task_identifier', 'target_task_identifier', 'type'],
    },
  },
  {
    name: 'post_message',
    description: 'Post a message in a chat space. REQUIRES USER APPROVAL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        space_name: {
          type: 'string',
          description: 'Name of the space (e.g., "general", "engineering")',
        },
        content: { type: 'string', description: 'Message content' },
      },
      required: ['space_name', 'content'],
    },
  },
  {
    name: 'get_workspace_stats',
    description:
      'Get workspace statistics like tasks completed, tasks created, messages sent, active contributors over a time period',
    input_schema: {
      type: 'object' as const,
      properties: {
        time_range: {
          type: 'string',
          enum: ['7d', '14d', '30d'],
          description: 'Time range for statistics',
        },
        metric: {
          type: 'string',
          description:
            'Optional: specific metric to retrieve (tasks_completed, tasks_created, messages_sent, active_users). Omit for all metrics.',
        },
      },
      required: ['time_range'],
    },
  },
  {
    name: 'get_team_workload',
    description:
      'Get current task distribution across team members by status. Shows who has the most work',
    input_schema: {
      type: 'object' as const,
      properties: {
        project_name: {
          type: 'string',
          description: 'Optional: filter by project name',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_project_progress',
    description:
      'Get project completion stats including % done, tasks by status, recent activity, and blockers',
    input_schema: {
      type: 'object' as const,
      properties: {
        project_name: {
          type: 'string',
          description: 'Project name to get progress for',
        },
      },
      required: ['project_name'],
    },
  },
  {
    name: 'remember',
    description:
      "Store a fact or preference for future reference. Use 'conversation' scope for this chat, 'user' scope for all future conversations with this user, 'org' scope for team-wide knowledge visible to everyone in the org.",
    input_schema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', description: 'Short label for the memory (e.g., "preferred_language", "project_focus")' },
        value: { type: 'string', description: 'The fact or preference to remember' },
        scope: {
          type: 'string',
          enum: ['conversation', 'user', 'org'],
          description: "'conversation' = this chat only, 'user' = all future conversations with this user, 'org' = team-wide knowledge for the whole organization",
        },
      },
      required: ['key', 'value', 'scope'],
    },
  },
  {
    name: 'recall',
    description:
      'Retrieve stored facts and preferences. Omit key to get all memories for the scope.',
    input_schema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', description: 'Optional: specific memory key to retrieve' },
        scope: {
          type: 'string',
          enum: ['conversation', 'user', 'org'],
          description: "Optional: filter by scope. Omit to get all (user + conversation + org).",
        },
      },
      required: [],
    },
  },
  {
    name: 'search_decisions',
    description:
      'Search past team decisions. Use when someone asks "what did we decide about X" or "why did we choose Y".',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search keywords' },
        space_name: { type: 'string', description: 'Optional: filter by channel' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_user_activity',
    description:
      "Get a person's recent activity: tasks they changed, messages they sent, tasks assigned to them. Use for questions about what someone has been working on.",
    input_schema: {
      type: 'object' as const,
      properties: {
        user_name: { type: 'string', description: 'Name of the person to look up' },
        days: { type: 'number', description: 'Number of days to look back (default 7)' },
      },
      required: ['user_name'],
    },
  },
  {
    name: 'get_task_dependencies',
    description:
      'Get tasks that block or are blocked by a given task. Use for understanding why something is stalled or what needs to happen first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_identifier: {
          type: 'string',
          description: 'Task ID like DEFT-5 or the task UUID',
        },
      },
      required: ['task_identifier'],
    },
  },
  {
    name: 'search_blockers',
    description:
      'Search messages for mentions of blockers, stuck points, waiting-on items. Use for investigating why work is delayed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search keywords related to what might be blocking work' },
        days: { type: 'number', description: 'Number of days to search back (default 7)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_knowledge',
    description:
      'Search knowledge entries (decisions, resources, action items, notes) across spaces. Use for questions about team decisions, shared resources, or documented knowledge.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search keywords to match against title and content' },
        space_name: { type: 'string', description: 'Optional: filter to a specific space by name' },
        type: { type: 'string', enum: ['decision', 'resource', 'action_item', 'note'], description: 'Optional: filter by entry type' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'add_knowledge',
    description:
      'Add a knowledge entry (decision, resource, action item, or note) to a space. Use when the user asks you to capture a decision, save a link, or record something important.',
    input_schema: {
      type: 'object' as const,
      properties: {
        space_name: { type: 'string', description: 'Name of the space to add knowledge to' },
        type: { type: 'string', enum: ['decision', 'resource', 'action_item', 'note'], description: 'Entry type' },
        title: { type: 'string', description: 'Entry title' },
        content: { type: 'string', description: 'Entry content/details' },
        metadata: {
          type: 'object',
          description: 'Type-specific metadata. For resource: { url }. For decision: { status: "proposed"|"accepted"|"revisited" }. For action_item: { status: "open"|"done" }.',
        },
      },
      required: ['space_name', 'type', 'title'],
    },
  },
  {
    name: 'create_plan',
    description:
      'Create a multi-step execution plan for complex requests. Use this when the task requires 3+ sequential operations, has write actions that need approval, or involves conditional logic. The plan will be shown to the user for approval before execution.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short title for the plan' },
        description: { type: 'string', description: 'What this plan accomplishes' },
        steps: {
          type: 'array',
          description: 'Ordered list of steps',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique step identifier' },
              description: { type: 'string', description: 'What this step does' },
              tool: { type: 'string', description: 'Tool to call' },
              params: {
                type: 'object',
                description:
                  'Tool parameters. Use $step.{id}.result.{field} to reference prior results',
              },
              depends_on: {
                type: 'array',
                items: { type: 'string' },
                description: 'Step IDs this depends on',
              },
              condition: {
                type: 'object',
                description: 'Optional condition for execution',
              },
            },
            required: ['id', 'description', 'tool', 'params'],
          },
        },
      },
      required: ['title', 'steps'],
    },
  },
  // ─── Wiki Tools (LLM Wiki pattern) ───
  {
    name: 'wiki_search',
    description:
      'Search the team wiki for knowledge pages about concepts, decisions, preferences, entities, or facts. The wiki accumulates structured knowledge from conversations and manual entries. Use this first before searching messages — wiki pages contain synthesized, up-to-date knowledge.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search topic or keywords' },
        type: { type: 'string', enum: ['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact'], description: 'Optional: filter by page type' },
        scope: { type: 'string', enum: ['org', 'space', 'user'], description: 'Optional: filter by scope' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'wiki_read',
    description:
      'Read the full content of a wiki page including its linked pages, backlinks, and source citations. Use after wiki_search to get details on a specific topic.',
    input_schema: {
      type: 'object' as const,
      properties: {
        slug: { type: 'string', description: 'The page slug (from wiki_search results)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'wiki_write',
    description:
      'Create or update a wiki page. Use to capture important knowledge, decisions, or preferences that the team should remember. For updates, provide the slug of the existing page.',
    input_schema: {
      type: 'object' as const,
      properties: {
        slug: { type: 'string', description: 'Optional: slug of existing page to update. Omit to create new.' },
        title: { type: 'string', description: 'Page title (required for new pages)' },
        content: { type: 'string', description: 'Page content in markdown' },
        type: { type: 'string', enum: ['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact'], description: 'Page type (required for new pages)' },
        summary: { type: 'string', description: 'One-sentence summary' },
        related_slugs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Slugs of related wiki pages to link to',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'wiki_suggest_update',
    description:
      'Suggest an update to an existing wiki page based on new information from the conversation. The suggestion is saved for user review — it does NOT auto-apply. Use when you notice a wiki page is outdated or incomplete based on what you learned in this conversation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        slug: { type: 'string', description: 'Slug of the wiki page to suggest updating' },
        suggested_content: { type: 'string', description: 'The suggested new content for the page' },
        reason: { type: 'string', description: 'Why this update is needed — what new information prompted it' },
      },
      required: ['slug', 'suggested_content', 'reason'],
    },
  },
  // ─── Block 2.6 — decision tools ─────────────────────────────────────
  {
    name: 'link_decision_to_tasks',
    description:
      'Link a decision to one or more tasks in your org. Creates `cross_references` rows (source=decision → target=task). Use when a conversation decision implies the team needs to act.',
    input_schema: {
      type: 'object' as const,
      properties: {
        decision_id: { type: 'string' },
        task_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        context: { type: 'string', description: 'Optional explanation of why these tasks implement this decision.' },
      },
      required: ['decision_id', 'task_ids'],
    },
  },
  {
    name: 'mark_decision_implemented',
    description:
      'Mark a decision as implemented (sets decisions.implemented_at = now()). Use after the linked tasks have been completed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        decision_id: { type: 'string' },
      },
      required: ['decision_id'],
    },
  },
  // ─── Block 2.3 — canvas tools ──────────────────────────────────────
  {
    name: 'read_canvas',
    description:
      'Read the shared canvas (TipTap JSON document) attached to a space. One canvas per space. Returns title + content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        space_name: { type: 'string', description: 'Space name, e.g. "engineering".' },
      },
      required: ['space_name'],
    },
  },
  {
    name: 'write_canvas',
    description:
      'Replace the canvas content for a space. Upserts the canvas row (one per space). Pass the full next content as a TipTap JSON document or HTML string.',
    input_schema: {
      type: 'object' as const,
      properties: {
        space_name: { type: 'string' },
        title: { type: 'string', description: 'Optional new title.' },
        content: {
          description: 'TipTap JSON document (object) or HTML string.',
          oneOf: [{ type: 'string' }, { type: 'object' }],
        },
      },
      required: ['space_name', 'content'],
    },
  },
  // ─── Block 2.2 — thread reply ───────────────────────────────────────
  {
    name: 'post_thread_reply',
    description:
      'Reply to an existing message in its thread. Requires the parent message id; the reply inherits the parent\'s space. REQUIRES USER APPROVAL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        parent_message_id: {
          type: 'string',
          description: 'The id of the message to reply to (the thread parent).',
        },
        content: { type: 'string', description: 'Reply content (plain text or minimal markdown).' },
      },
      required: ['parent_message_id', 'content'],
    },
  },
  // ─── Block 2.1 — note tools ─────────────────────────────────────────
  {
    name: 'search_notes',
    description:
      'Search the caller\'s private notes + org-visible notes by title/content. Returns up to `limit` matches (default 10).',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search keywords' },
        scope: {
          type: 'string',
          enum: ['mine', 'org', 'all'],
          description: 'Restrict to your own notes, org-visible notes, or both (default).',
        },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_note',
    description:
      'Create a new note owned by the caller. Defaults to private visibility. Use when the user asks you to "save this as a note" or "jot this down".',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Note title (required, may be short)' },
        content: { type: 'string', description: 'HTML body (TipTap-compatible)' },
        visibility: {
          type: 'string',
          enum: ['private', 'org', 'space'],
          description: 'Default private. Use "org" for shareable, "space" to attach to a space.',
        },
        visibility_space_id: {
          type: 'string',
          description: 'Required when visibility="space". The target space id.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'read_note',
    description:
      'Read a single note by id. Returns title, content (HTML), visibility, updated_at. Respects visibility: you can only read notes you own or are org-visible.',
    input_schema: {
      type: 'object' as const,
      properties: {
        note_id: { type: 'string', description: 'Note id' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'note_to_wiki',
    description:
      'Promote a note into a wiki page so it is durably searchable by every agent in the org. Creates a new wiki page seeded with the note\'s title + content; the original note stays put (this is a copy, not a move).',
    input_schema: {
      type: 'object' as const,
      properties: {
        note_id: { type: 'string', description: 'Note id to promote' },
        type: {
          type: 'string',
          enum: ['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact'],
          description: 'Wiki page type. Default "fact".',
        },
      },
      required: ['note_id'],
    },
  },
];

/** Tool names that require user approval before execution */
export const ACTION_TOOLS = new Set([
  'create_task',
  'update_task_status',
  'assign_task',
  'post_message',
  'add_knowledge',
  'wiki_write',
  // Task 3.4 — new task-mutation tools
  'comment_on_task',
  'set_due_date',
  'set_priority',
  'add_label',
  // Task 3.5 — status shortcuts
  'close_task',
  'reopen_task',
  // Task 3.6 — dependency tools
  'add_dependency',
  'remove_dependency',
  // ─── Block 2.1 — note writes ─────────────────────────────────────────
  'create_note',
  'note_to_wiki',
  // ─── Block 2.2 — thread reply ────────────────────────────────────────
  'post_thread_reply',
  // ─── Block 2.3 — canvas write ────────────────────────────────────────
  'write_canvas',
  // ─── Block 2.6 — decision writes ────────────────────────────────────
  'link_decision_to_tasks',
  'mark_decision_implemented',
]);

// Calendar tools (only added when calendar is connected)
export const CALENDAR_TOOLS: Anthropic.Tool[] = [
  {
    name: 'check_calendar',
    description: 'Check the user\'s Google Calendar for events and meetings.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Date to check (YYYY-MM-DD). Default: today' },
        query: { type: 'string', description: 'Search for events by title or attendee' },
      },
      required: [],
    },
  },
  {
    name: 'create_calendar_event',
    description: 'Create a new event on Google Calendar. REQUIRES USER APPROVAL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: 'Start time ISO 8601' },
        end: { type: 'string', description: 'End time ISO 8601' },
        description: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'List of email addresses' },
        location: { type: 'string' },
      },
      required: ['title', 'start', 'end'],
    },
  },
];

export const GITHUB_TOOLS: Anthropic.Tool[] = [
  {
    name: 'check_github_prs',
    description: 'Check open pull requests, recent merges, review requests from GitHub.',
    input_schema: {
      type: 'object' as const,
      properties: {
        state: { type: 'string', enum: ['open', 'merged', 'closed'], description: 'Filter by PR state' },
        repo: { type: 'string', description: 'Filter by repository name' },
      },
      required: [],
    },
  },
];

// Action tools for calendar/github that require approval
export const CALENDAR_ACTION_TOOLS = ['create_calendar_event'];
export const GITHUB_ACTION_TOOLS = ['create_github_issue'];

// ─── Manager / Team Tools ───

export const MANAGER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_team_health',
    description:
      'Get current health status for team members. Shows activity, overdue tasks, and engagement signals per person.',
    input_schema: {
      type: 'object' as const,
      properties: {
        user_name: {
          type: 'string',
          description: 'Optional: filter to a specific team member by name',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_team_performance',
    description:
      'Analyze team velocity and output. Shows tasks completed per week, trends, and per-person breakdowns.',
    input_schema: {
      type: 'object' as const,
      properties: {
        timeframe: {
          type: 'string',
          enum: ['7d', '14d', '30d'],
          description: 'Timeframe for analysis (default: 30d)',
        },
        project_name: {
          type: 'string',
          description: 'Optional: filter by project name',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_workload_balance',
    description:
      'Show how work is distributed across the team. Identifies overloaded and underloaded members.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'prep_oneone',
    description:
      'Generate a 1:1 prep for meeting with a team member. REQUIRES MANAGER ROLE.',
    input_schema: {
      type: 'object' as const,
      properties: {
        person: {
          type: 'string',
          description: 'Name of the person you are meeting with',
        },
      },
      required: ['person'],
    },
  },
  {
    name: 'find_expert',
    description:
      'Find who has expertise on a topic. Searches the people expertise graph.',
    input_schema: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          description: 'Topic or skill to search for',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'get_team_dynamics',
    description:
      'Show collaboration patterns and relationships. Reveals who works closely together, mentoring pairs, and potential tensions.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'analyze_skills_gap',
    description:
      'Identify missing skills and single points of failure in the team for hiring decisions.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_burnout_risks',
    description:
      'Show team members showing signs of strain. MANAGER ONLY. Returns patterns without message content.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

/** Tool names that require manager (owner/admin) role */
export const MANAGER_ONLY_TOOLS = new Set([
  'prep_oneone',
  'get_burnout_risks',
]);

// ─── Superintendent Tools (Defty only, not agent employees) ───

export const SUPERINTENDENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_agent_employees',
    description:
      'List all agent employees in the organization with their status, role, daily action usage, and last active timestamp.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status_filter: {
          type: 'string',
          enum: ['active', 'paused', 'all'],
          description: 'Filter by status. Default: all',
        },
      },
      required: [],
    },
  },
  {
    name: 'manage_agent_employee',
    description:
      'Create, update, pause, resume, or delete an agent employee. REQUIRES USER APPROVAL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'pause', 'resume', 'delete'],
          description: 'Action to perform',
        },
        employee_id: { type: 'string', description: 'Employee ID (required for update/pause/resume/delete)' },
        name: { type: 'string', description: 'Employee name (required for create)' },
        role: { type: 'string', description: 'Employee role' },
        system_prompt: { type: 'string', description: 'System prompt for the employee' },
        trust_level: {
          type: 'string',
          enum: ['conservative', 'standard', 'autonomous'],
          description: 'Trust level for the employee',
        },
        max_daily_actions: { type: 'number', description: 'Maximum daily actions allowed' },
      },
      required: ['action'],
    },
  },
  {
    name: 'get_agent_activity',
    description:
      'Get recent agent actions across employees. Optionally filter by a specific employee.',
    input_schema: {
      type: 'object' as const,
      properties: {
        employee_id: { type: 'string', description: 'Optional: filter to a specific employee by ID' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'get_agent_economics',
    description:
      'Get token spend and action counts per employee. Shows daily usage, limits, and active status.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'manage_mcp_connection',
    description:
      'Add, remove, test, or update an MCP (Model Context Protocol) connection. REQUIRES USER APPROVAL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove', 'test', 'update'],
          description: 'Action to perform',
        },
        connection_id: { type: 'string', description: 'Connection ID (required for remove/test/update)' },
        name: { type: 'string', description: 'Connection name (required for add)' },
        server_url: { type: 'string', description: 'MCP server URL (required for add)' },
        transport: {
          type: 'string',
          enum: ['stdio', 'sse', 'streamable-http'],
          description: 'Transport type',
        },
        auth_type: {
          type: 'string',
          enum: ['none', 'bearer', 'api_key'],
          description: 'Authentication type',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_triggers',
    description:
      'Create, update, disable, enable, delete, or list triggers for agent employees. REQUIRES USER APPROVAL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'disable', 'enable', 'delete', 'list'],
          description: 'Action to perform',
        },
        trigger_id: { type: 'string', description: 'Trigger ID (required for update/disable/enable/delete)' },
        employee_id: { type: 'string', description: 'Employee ID to attach trigger to (required for create)' },
        event_type: { type: 'string', description: 'Event type that fires the trigger (e.g., "task:overdue", "pr:merged")' },
        conditions: {
          type: 'object',
          description: 'Conditions that must be met for the trigger to fire',
        },
        action_template: {
          type: 'object',
          description: 'Action template to execute when trigger fires',
        },
      },
      required: ['action'],
    },
  },
];

/** Superintendent tool names that require user approval before execution */
export const SUPERINTENDENT_ACTION_TOOLS = new Set([
  'manage_agent_employee',
  'manage_mcp_connection',
  'manage_triggers',
]);
