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
];

/** Tool names that require user approval before execution */
export const ACTION_TOOLS = new Set([
  'create_task',
  'update_task_status',
  'assign_task',
  'post_message',
  'add_knowledge',
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
