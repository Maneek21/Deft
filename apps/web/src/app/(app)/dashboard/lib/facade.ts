/**
 * WidgetApiFacade
 *
 * A curated, stable surface that widgets consume instead of importing @/lib/api
 * directly. This is the boundary that lets us later:
 *   - sandbox third-party widgets (iframe/worker) — they talk to the facade
 *     over postMessage instead of calling fetch()
 *   - swap the underlying transport (REST → GraphQL → local state) without
 *     editing any widget
 *   - enforce permission scopes per widget when third-party widgets arrive
 *
 * Rule: if a widget needs a new API call, add it here first. Widgets must not
 * reach into @/lib/api on their own.
 */
import { api } from '@/lib/api';

// ───── domain types (re-exported so widgets don't import from page.tsx) ─────

export type Task = {
  id: string; title: string; status: string;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  project_prefix: string; project_name: string; number: number;
  due_date: string | null;
};

export type UnreadSpace = {
  space_id: string; space_name: string; space_type: string;
  unread_count: number; last_message: string | null;
  last_message_by: string | null; last_message_at: string | null;
};

export type Project = {
  id: string; name: string; prefix: string; color: string | null;
  total_tasks: number; done_tasks: number; my_tasks: number;
};

export type Activity = {
  id: string; action: string; user_name: string | null;
  task_number: number | null; task_title: string | null;
  task_prefix: string | null; new_value: string | null; created_at: string;
};

export type Standup = { summary: string; date: string } | null;

export type HealthCard = {
  userId: string; name: string; status: 'green' | 'yellow' | 'red';
  insight: string; activeTasks: number; overdueTasks: number;
  messageCount: number; blockers: string[];
};

export type TeamHealth = {
  healthCards: HealthCard[];
  actionItems: unknown[];
  wins: string[];
  summary: string;
};

export type OneOnePrep = {
  id: string;
  report_id: string;
  report_name: string;
  prep_content: Record<string, any>;
  created_at: string;
};

export type Insights = {
  activity: { messages_sent: number; tasks_completed: number; spaces_active: string[] };
  expertise: { topic: string; score: number }[];
  pace: { week: string; completed: number }[];
};

export type AgentActivity = {
  id: string; action: string; params: any; result: any;
  approval_status: string; executed_at: string | null;
  created_at: string; error: string | null; agent_employee_id: string | null;
};

export type AgentEmployeeBrief = { id: string; name: string };

export type DashboardCore = {
  greeting: string;
  standup: Standup;
  due_today: Task[]; due_this_week: Task[]; overdue: Task[];
  in_progress: Task[]; my_work: Task[];
  unread_spaces: UnreadSpace[];
  recent_activity: Activity[];
  projects: Project[];
};

export type CalendarPayload = {
  tasks: { id: string; title: string; status: string; priority: Task['priority']; project_prefix: string; number: number; timestamp: string }[];
  events: { id: string; title: string; timestamp: string }[];
  notes: { id: string; title: string; timestamp: string }[];
};

// ───── facade ─────

export type WidgetApiFacade = {
  getDashboardCore: () => Promise<DashboardCore | null>;
  getInsights: () => Promise<Insights | null>;
  getAgentActivity: () => Promise<AgentActivity[]>;
  getAgentEmployees: () => Promise<AgentEmployeeBrief[]>;
  getTeamHealth: () => Promise<TeamHealth | null>;
  getOneOnePreps: () => Promise<OneOnePrep[]>;
  getCalendar: (fromIso: string, toIso: string) => Promise<CalendarPayload | null>;

  approveAgentAction: (id: string) => Promise<boolean>;
  rejectAgentAction: (id: string) => Promise<boolean>;
  generateStandup: () => Promise<Standup>;
};

async function ok<T>(p: Promise<Response>): Promise<T | null> {
  try {
    const res = await p;
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Concrete facade built on the in-repo api client. Swap this impl later. */
export const widgetApi: WidgetApiFacade = {
  getDashboardCore: () => ok<DashboardCore>(api.get('/api/dashboard')),
  getInsights: () => ok<Insights>(api.get('/api/dashboard/my-insights')),
  getAgentActivity: async () => (await ok<AgentActivity[]>(api.get('/api/dashboard/agent-activity'))) ?? [],
  getAgentEmployees: async () => {
    const d = await ok<{ id: string; name: string }[]>(api.get('/api/agent-employees'));
    return (d ?? []).map(e => ({ id: e.id, name: e.name }));
  },
  getTeamHealth: async () => {
    const d = await ok<any>(api.get('/api/manager/team-health'));
    if (!d) return null;
    if (d.snapshot?.team_data) return d.snapshot.team_data as TeamHealth;
    if (d.healthCards) return d as TeamHealth;
    return null;
  },
  getOneOnePreps: async () => {
    const d = await ok<any>(api.get('/api/manager/oneone-preps'));
    const preps = d?.preps ?? d;
    if (!Array.isArray(preps)) return [];
    return preps.map((p: any) => ({
      id: p.id,
      report_id: p.report_id,
      report_name:
        p.prep_content?.reportName ||
        p.prep_content?.report_name ||
        'Team member',
      prep_content: p.prep_content,
      created_at: p.created_at,
    }));
  },
  getCalendar: (fromIso, toIso) =>
    ok<CalendarPayload>(api.get(`/api/calendar?from=${fromIso}&to=${toIso}`)),

  approveAgentAction: async id => {
    const res = await api.post(`/api/agent/actions/${id}/approve`);
    return res.ok;
  },
  rejectAgentAction: async id => {
    const res = await api.post(`/api/agent/actions/${id}/reject`);
    return res.ok;
  },
  generateStandup: async () => {
    try {
      const res = await api.post('/api/dashboard/standup');
      if (!res.ok) return null;
      const j = await res.json();
      return j.standup ?? null;
    } catch {
      return null;
    }
  },
};
