'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { sanitizeHtml } from '@/lib/sanitize';
import { api } from '@/lib/api';
import { formatRelativeCompact, formatFullDateLong, formatCurrentTime, formatEventTime, formatMessageTime } from '@/lib/time';
import Link from 'next/link';
import {
  Clock, CheckCircle2, Circle, MessageSquare,
  Plus, Bot, Sunrise, Loader2, X, Shield, Activity, Users,
  LayoutDashboard, ArrowRight, ChevronLeft, ChevronRight, FileText, ExternalLink,
} from 'lucide-react';
import { CalTask, CalEvent, CalNote, DayBucket, toDateKey, buildMonthGrid, bucketByDay, CAL_DAYS_SHORT, ITEM_COLORS } from '@/lib/calendar';
import { statusLabel } from '@/lib/task-status-labels';
import { TaskCardUnified, type UnifiedTask } from '@/components/task-card-unified';

// ═══ Types (self-contained) ═══

type DashboardTask = {
  id: string; title: string; status: string; priority: 'p0' | 'p1' | 'p2' | 'p3';
  project_prefix: string; project_name: string; number: number;
  due_date: string | null; updated_at?: string;
};

type UnreadSpace = {
  space_id: string; space_name: string; space_type: string;
  unread_count: number; last_message: string | null;
  last_message_by: string | null; last_message_at: string | null;
};

type DashboardProject = {
  id: string; name: string; prefix: string; color: string | null;
  total_tasks: number; done_tasks: number; my_tasks: number;
};

type ActivityEntry = {
  id: string; action: string; field: string | null;
  old_value: string | null; new_value: string | null;
  user_name: string | null; task_number: number | null;
  task_title: string | null; task_prefix: string | null; created_at: string;
};

type CalendarEvent = {
  id: string; title: string; url: string | null; timestamp: string;
  metadata: { start: string; end: string; location?: string; attendees?: { email: string; displayName?: string }[]; hangoutLink?: string; allDay?: boolean; };
};

type GitHubEvent = {
  id: string; title: string; event_type: string; url: string | null;
  actor: string | null; timestamp: string;
  metadata: { repo?: string; number?: number; state?: string; merged?: boolean };
};

type StandupData = { summary: string; date: string; } | null;

type HealthCard = {
  userId: string; name: string; status: 'green' | 'yellow' | 'red';
  insight: string; activeTasks: number; overdueTasks: number;
  messageCount: number; blockers: string[];
};

type TeamHealthData = {
  healthCards: HealthCard[];
  actionItems: { userId: string; name: string; action: string; urgency: string }[];
  wins: string[]; summary: string;
};

type OneOnePrepData = {
  id: string; report_id: string; report_name: string;
  prep_content: any; created_at: string;
};

type MyInsightsData = {
  activity: { messages_sent: number; tasks_completed: number; spaces_active: string[] };
  expertise: { topic: string; score: number }[];
  top_collaborators: { name: string; score: number; interactions: number }[];
  work_patterns: { type: string; data: any }[];
  pace: { week: string; completed: number }[];
};

type AgentActivity = {
  id: string;
  action: string;
  params: any;
  result: any;
  approval_status: string;
  approval_tier: string;
  executed_at: string | null;
  created_at: string;
  error: string | null;
  agent_employee_id: string | null;
};

type AgentEmployeeBrief = {
  id: string;
  name: string;
};

type DashboardData = {
  greeting: string; standup: StandupData; due_today: DashboardTask[];
  due_this_week: DashboardTask[]; overdue: DashboardTask[];
  in_progress: DashboardTask[]; my_work: DashboardTask[];
  unread_spaces: UnreadSpace[];
  recent_activity: ActivityEntry[]; projects: DashboardProject[];
  calendar_events: CalendarEvent[]; github_activity: GitHubEvent[];
};

// ═══ Helpers ═══

function renderSimpleMarkdown(text: string): string {
  if (!text) return '';
  let html = text
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3 style="font-size:13px;font-weight:600;margin:8px 0 3px">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:14px;font-weight:600;margin:10px 0 4px">$1</h2>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul style="list-style:disc;padding-left:20px;margin:4px 0">$1</ul>')
    .replace(/^> (.+)$/gm, '<blockquote style="border-left:3px solid var(--accent);padding-left:12px;margin:6px 0">$1</blockquote>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br/>');
  if (!html.startsWith('<')) html = '<p>' + html + '</p>';
  return html;
}

const PRIORITY_COLORS: Record<string, string> = {
  p0: 'var(--status-red)', p1: 'var(--status-amber)', p2: 'var(--status-blue)', p3: 'var(--status-gray)',
};

function formatActivity(a: ActivityEntry): string {
  const task = a.task_prefix && a.task_number ? `${a.task_prefix}-${a.task_number}` : '';
  const who = a.user_name?.split(' ')[0] || 'Someone';
  if (a.action === 'created') return `${who} created ${task}`;
  if (a.action === 'status_changed') return `${who} moved ${task} to ${statusLabel(a.new_value || '')}`;
  if (a.action === 'assigned') return `${who} assigned ${task}`;
  if (a.action === 'priority_changed') return `${who} changed ${task} priority`;
  if (a.action === 'commented') return `${who} commented on ${task}`;
  return `${who} updated ${task}`;
}

function formatAgentAction(a: AgentActivity): string {
  const p = a.params as Record<string, any>;
  switch (a.action) {
    case 'create_task': return `Created task "${p.title}" in ${p.project_name}`;
    case 'update_task_status': return `Moved ${p.task_identifier} to ${(p.new_status || '').replace(/_/g, ' ')}`;
    case 'assign_task': return `Assigned ${p.task_identifier} to ${p.assignee_name}`;
    case 'post_message': return `Posted in #${p.space_name}`;
    case 'add_knowledge': return `Added ${p.type}: "${p.title}"`;
    case 'wiki_write': return `Updated wiki: ${p.title || p.slug}`;
    case 'create_calendar_event': return `Created event: ${p.title}`;
    default: return a.action.replace(/_/g, ' ');
  }
}

// ═══ Bento Card component ═══

function BentoCard({ title, span = 1, children, headerRight, bg }: {
  title: string; span?: number; children: React.ReactNode;
  headerRight?: React.ReactNode; bg?: string;
}) {
  // On mobile (< md), everything is 1 col. On md, span 2 cards get col-span-2. On lg, full 3-col grid.
  const spanClass = span >= 2 ? 'md:col-span-2' : '';
  return (
    <div className={`rounded-lg p-4 flex flex-col col-span-1 ${spanClass}`} style={{
      background: bg || 'var(--surface-container-low, var(--bg-surface))',
      border: '1px solid var(--border-default)',
      minHeight: 0,
    }}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</span>
        {headerRight}
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

// ═══ Donut Ring for project progress ═══

function ProgressRing({ percent, color, size = 36 }: { percent: number; color: string; size?: number }) {
  const r = (size - 6) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (percent / 100) * circ;
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="var(--bg-overlay, var(--border-default))" strokeWidth={3} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={color} strokeWidth={3} strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={offset} />
    </svg>
  );
}

// ═══ Calendar Mini-Widget ═══

function CalendarWidget() {
  const today = toDateKey(new Date());
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [calData, setCalData] = useState<{ tasks: CalTask[]; events: CalEvent[]; notes: CalNote[] } | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const grid = buildMonthGrid(month);
  const gridFrom = grid[0];
  const gridTo = grid[grid.length - 1];

  useEffect(() => {
    const from = new Date(gridFrom); from.setHours(0, 0, 0, 0);
    const to = new Date(gridTo); to.setHours(23, 59, 59, 999);
    api.get(`/api/calendar?from=${from.toISOString()}&to=${to.toISOString()}`).then(async res => {
      if (res.ok) setCalData(await res.json());
    });
  }, [gridFrom.getTime(), gridTo.getTime()]);

  // Bucket by day
  const dayBuckets = calData ? bucketByDay(calData) : new Map<string, DayBucket>();

  const goMonth = (offset: number) => {
    const d = new Date(month);
    d.setMonth(d.getMonth() + offset);
    setMonth(d);
    setSelectedDay(null);
  };

  const selectedBucket = selectedDay ? dayBuckets.get(selectedDay) : null;

  return (
    <div>
      {/* Month header */}
      <div className="flex items-center justify-between mb-2">
        <button onClick={() => goMonth(-1)} className="p-2.5 md:p-0.5 min-h-[44px] md:min-h-0 min-w-[44px] md:min-w-0 flex items-center justify-center rounded" style={{ color: 'var(--text-tertiary)' }}>
          <ChevronLeft size={14} />
        </button>
        <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
        </span>
        <button onClick={() => goMonth(1)} className="p-2.5 md:p-0.5 min-h-[44px] md:min-h-0 min-w-[44px] md:min-w-0 flex items-center justify-center rounded" style={{ color: 'var(--text-tertiary)' }}>
          <ChevronRight size={14} />
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 mb-0.5">
        {CAL_DAYS_SHORT.map((d, i) => (
          <div key={i} className="text-center text-[9px] font-semibold py-0.5"
            style={{ color: 'var(--text-tertiary)' }}>{d}</div>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-7">
        {grid.map((date, i) => {
          const key = toDateKey(date);
          const inMonth = date.getMonth() === month.getMonth();
          const isToday = key === today;
          const isSelected = key === selectedDay;
          const bucket = dayBuckets.get(key);
          const hasItems = bucket && (bucket.tasks.length + bucket.events.length + bucket.notes.length) > 0;

          return (
            <button key={i} onClick={() => setSelectedDay(isSelected ? null : key)}
              className="relative flex flex-col items-center py-3 md:py-1 min-h-[44px] md:min-h-0 justify-center rounded transition-colors"
              style={{
                background: isSelected ? 'var(--bg-active)' : isToday ? 'var(--accent-muted, rgba(99,102,241,0.1))' : 'transparent',
                opacity: inMonth ? 1 : 0.3,
              }}>
              <span className="text-[10px] font-medium" style={{
                color: isToday ? 'var(--accent)' : 'var(--text-primary)',
              }}>{date.getDate()}</span>
              {hasItems && (
                <div className="flex gap-px mt-0.5">
                  {bucket!.events.length > 0 && <div className="w-[4px] h-[4px] rounded-full" style={{ background: ITEM_COLORS.event }} />}
                  {bucket!.tasks.length > 0 && <div className="w-[4px] h-[4px] rounded-full" style={{ background: ITEM_COLORS.task }} />}
                  {bucket!.notes.length > 0 && <div className="w-[4px] h-[4px] rounded-full" style={{ background: ITEM_COLORS.note }} />}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Day detail (expanded inline) */}
      {selectedDay && selectedBucket && (selectedBucket.tasks.length + selectedBucket.events.length + selectedBucket.notes.length) > 0 && (
        <div className="mt-2 pt-2 space-y-1" style={{ borderTop: '1px solid var(--border-default)' }}>
          {selectedBucket.events.map(e => (
            <div key={e.id} className="flex items-center gap-2 text-[11px]">
              <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: ITEM_COLORS.event }} />
              <span className="truncate flex-1" style={{ color: 'var(--text-primary)' }}>{e.title}</span>
              <span style={{ color: 'var(--text-tertiary)' }}>{new Date(e.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
            </div>
          ))}
          {selectedBucket.tasks.map(t => (
            <Link key={t.id} href={`/tasks?task=${t.project_prefix}-${t.number}`}
              className="flex items-center gap-2 text-[11px]">
              {t.status === 'done'
                ? <CheckCircle2 size={11} style={{ color: 'var(--status-green)' }} />
                : <Circle size={11} style={{ color: PRIORITY_COLORS[t.priority] || 'var(--text-tertiary)' }} />}
              <span className="truncate flex-1" style={{
                color: 'var(--text-primary)',
                textDecoration: t.status === 'done' ? 'line-through' : 'none',
                opacity: t.status === 'done' ? 0.5 : 1,
              }}>{t.title}</span>
              <span className="text-[9px] font-mono" style={{ color: 'var(--text-tertiary)' }}>
                {t.project_prefix}-{t.number}
              </span>
            </Link>
          ))}
          {selectedBucket.notes.map(n => (
            <Link key={n.id} href={`/notes?id=${n.id}`} className="flex items-center gap-2 text-[11px]">
              <span className="text-[10px]">{n.icon || '\uD83D\uDCC4'}</span>
              <span className="truncate" style={{ color: 'var(--text-primary)' }}>{n.title || 'Untitled'}</span>
            </Link>
          ))}
        </div>
      )}

      {selectedDay && (!selectedBucket || (selectedBucket.tasks.length + selectedBucket.events.length + selectedBucket.notes.length) === 0) && (
        <div className="mt-2 pt-2 text-center" style={{ borderTop: '1px solid var(--border-default)' }}>
          <p className="text-[10px] py-1" style={{ color: 'var(--text-tertiary)' }}>Nothing on this day</p>
        </div>
      )}
    </div>
  );
}

// ═══ Bento Grid Dashboard ═══

function getLocalGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function Dashboard3Page() {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [clientGreeting, setClientGreeting] = useState<string | null>(null);

  useEffect(() => {
    setClientGreeting(getLocalGreeting());
  }, []);
  const [standupGenerating, setStandupGenerating] = useState(false);
  const [standupOpen, setStandupOpen] = useState(false);

  const isManagerRole = user?.role === 'owner' || user?.role === 'admin';
  const [teamHealth, setTeamHealth] = useState<TeamHealthData | null>(null);
  const [oneonePreps, setOneonePreps] = useState<OneOnePrepData[]>([]);
  const [prepModal, setPrepModal] = useState<OneOnePrepData | null>(null);
  const [myInsights, setMyInsights] = useState<MyInsightsData | null>(null);
  const [agentActivity, setAgentActivity] = useState<AgentActivity[]>([]);
  const [agentEmployees, setAgentEmployees] = useState<AgentEmployeeBrief[]>([]);
  const [employeeFilter, setEmployeeFilter] = useState('all');

  useEffect(() => {
    api.get('/api/dashboard').then(async res => {
      if (res.ok) setData(await res.json());
      setLoading(false);
    }).catch(() => setLoading(false));

    api.get('/api/dashboard/my-insights').then(async res => {
      if (res.ok) setMyInsights(await res.json());
    }).catch(() => {});

    api.get('/api/dashboard/agent-activity').then(async res => {
      if (res.ok) setAgentActivity(await res.json());
    }).catch(() => {});

    api.get('/api/agent-employees').then(async res => {
      if (res.ok) {
        const data = await res.json();
        setAgentEmployees(data.map((e: any) => ({ id: e.id, name: e.name })));
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isManagerRole) return;
    api.get('/api/manager/team-health').then(async res => {
      if (res.ok) {
        const data = await res.json();
        if (data.snapshot?.team_data) setTeamHealth(data.snapshot.team_data as TeamHealthData);
        else if (data.healthCards) setTeamHealth(data as TeamHealthData);
      }
    }).catch(() => {});
    api.get('/api/manager/oneone-preps').then(async res => {
      if (res.ok) {
        const data = await res.json();
        const preps = data.preps || data;
        if (Array.isArray(preps)) {
          setOneonePreps(preps.map((p: any) => ({
            id: p.id, report_id: p.report_id,
            report_name: (p.prep_content as any)?.reportName || (p.prep_content as any)?.report_name || 'Team member',
            prep_content: p.prep_content, created_at: p.created_at,
          })));
        }
      }
    }).catch(() => {});
  }, [isManagerRole]);

  const handleGenerateStandup = async () => {
    setStandupGenerating(true);
    try {
      const res = await api.post('/api/dashboard/standup');
      if (res.ok) {
        const result = await res.json();
        if (result.standup && data) setData({ ...data, standup: result.standup });
      }
    } catch {} finally { setStandupGenerating(false); }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
      </div>
    );
  }

  const d = data || {
    greeting: 'Good morning', standup: null, due_today: [], due_this_week: [],
    overdue: [], in_progress: [], my_work: [], unread_spaces: [], recent_activity: [],
    projects: [], calendar_events: [], github_activity: [],
  };

  if (d.due_today.length === 0 && d.in_progress.length === 0 && d.projects.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <LayoutDashboard size={24} strokeWidth={1.5} style={{ color: 'var(--outline)', margin: '0 auto 12px' }} />
          <p className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>Your workspace is ready</p>
          <p className="text-[12px] mt-1" style={{ color: 'var(--text-tertiary)' }}>Create your first task to get started.</p>
          <Link href="/tasks" className="inline-block mt-3 text-[12px] font-medium px-4 py-2 rounded-lg"
            style={{ background: 'var(--accent)', color: 'white' }}>Create a task</Link>
        </div>
      </div>
    );
  }

  // Today tasks = overdue + due today (merged, sorted by priority)
  const todayTasks = [...d.overdue, ...d.due_today];
  const seenToday = new Set<string>();
  const todayUnique = todayTasks.filter(t => { if (seenToday.has(t.id)) return false; seenToday.add(t.id); return true; });
  todayUnique.sort((a, b) => {
    const pOrder: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };
    return (pOrder[a.priority] ?? 3) - (pOrder[b.priority] ?? 3);
  });

  // Kanban-lite groups — source of truth is my_work (filtered server-side to
  // tasks assigned to the current user, primary or additional).
  const kanban: Record<string, DashboardTask[]> = { todo: [], in_progress: [], in_review: [] };
  const seenWork = new Set<string>();
  (d.my_work ?? []).forEach(t => {
    if (seenWork.has(t.id)) return;
    seenWork.add(t.id);
    if (kanban[t.status]) kanban[t.status].push(t);
  });

  const doneThisWeek = d.due_this_week.filter(t => t.status === 'done').length + d.due_today.filter(t => t.status === 'done').length;

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--bg-primary)' }}>
      <div className="w-full max-w-[1100px] mx-auto px-3 md:px-5 py-5">

        {/* Header row */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 mb-4">
          <div>
            <h1 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
              {clientGreeting ?? d.greeting}, {user?.name?.split(' ')[0]}
            </h1>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{formatFullDateLong(new Date())}</p>
          </div>
          <div className="flex items-center gap-1">
            {[
              { label: 'Task', icon: Plus, href: '/tasks' },
              { label: 'Message', icon: MessageSquare, href: '/chat' },
              { label: 'Deft', icon: Bot, href: '/agent' },
            ].map(a => (
              <Link key={a.label} href={a.href}
                className="flex items-center gap-1 px-2.5 py-1.5 min-h-[44px] md:min-h-0 rounded-lg text-[11px] font-medium"
                style={{ color: 'var(--text-secondary)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <a.icon size={13} strokeWidth={1.5} /> {a.label}
              </Link>
            ))}
            <button
              onClick={() => { if (!d.standup) handleGenerateStandup(); setStandupOpen(true); }}
              disabled={standupGenerating}
              className="flex items-center gap-1 px-2.5 py-1.5 min-h-[44px] md:min-h-0 rounded-lg text-[11px] font-medium"
              style={{ color: d.standup ? 'var(--status-amber)' : 'var(--text-secondary)' }}>
              {standupGenerating ? <Loader2 size={13} className="animate-spin" /> : <Sunrise size={13} strokeWidth={1.5} />}
              Standup
            </button>
          </div>
        </div>

        {/* Bento Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">

          {/* Card 1: Today (span 2) */}
          <BentoCard title="Today" span={2} headerRight={
            todayUnique.length > 0 ? (
              <span className="text-[10px] font-mono" style={{ color: 'var(--text-tertiary)' }}>{todayUnique.length} tasks</span>
            ) : null
          }>
            {todayUnique.length > 0 ? (
              <div className="space-y-0.5">
                {todayUnique.slice(0, 8).map(t => {
                  const isOverdue = d.overdue.some(o => o.id === t.id);
                  return (
                    <Link key={t.id} href={`/tasks?task=${t.project_prefix}-${t.number}`} className="block">
                      <TaskCardUnified
                        variant="dashboard"
                        task={t as UnifiedTask}
                        isOverdue={isOverdue}
                      />
                    </Link>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center justify-center h-full py-6">
                <div className="text-center">
                  <CheckCircle2 size={20} strokeWidth={1.5} style={{ color: 'var(--status-green)', margin: '0 auto 6px', opacity: 0.5 }} />
                  <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>Nothing due today</p>
                </div>
              </div>
            )}
          </BentoCard>

          {/* Card 2: Quick Stats */}
          <BentoCard title="Quick Stats" bg="var(--surface-container, var(--bg-surface))">
            <div className="grid grid-cols-2 gap-3 h-full">
              {[
                { label: 'Overdue', value: d.overdue.length, color: 'var(--status-red)' },
                { label: 'Due Today', value: d.due_today.length, color: 'var(--status-amber)' },
                { label: 'In Progress', value: d.in_progress.length, color: 'var(--status-blue)' },
                { label: 'Completed', value: doneThisWeek, color: 'var(--status-green)' },
              ].map(m => (
                <div key={m.label} className="flex flex-col items-center justify-center rounded-lg py-3"
                  style={{ background: m.color + '08' }}>
                  <span className="text-[24px] font-bold" style={{ color: m.color, lineHeight: 1, fontFamily: 'var(--font-mono, monospace)' }}>
                    {m.value}
                  </span>
                  <span className="text-[10px] mt-1 font-medium" style={{ color: m.color, opacity: 0.7 }}>{m.label}</span>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Card 3: Unread */}
          <BentoCard title="Unread" headerRight={
            d.unread_spaces.length > 0 ? (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full"
                style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
                {d.unread_spaces.reduce((s, u) => s + u.unread_count, 0)}
              </span>
            ) : null
          }>
            {d.unread_spaces.length > 0 ? (
              <div className="space-y-1">
                {d.unread_spaces.map(s => (
                  <Link key={s.space_id} href="/chat"
                    className="flex items-center gap-2 px-2 py-1.5 min-h-[44px] md:min-h-0 rounded-lg -mx-2"
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <span className="text-[12px] font-medium flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
                      {s.space_type === 'dm' ? s.space_name : `#${s.space_name}`}
                    </span>
                    <span className="text-[10px] min-w-4 h-4 flex items-center justify-center rounded-full font-bold"
                      style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
                      {s.unread_count}
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-[11px] py-2" style={{ color: 'var(--text-tertiary)' }}>All caught up!</p>
            )}
          </BentoCard>

          {/* Card 4: Projects with donut rings */}
          <BentoCard title="Projects">
            {d.projects.length > 0 ? (
              <div className="space-y-3">
                {d.projects.map(p => {
                  const pct = p.total_tasks > 0 ? Math.round((p.done_tasks / p.total_tasks) * 100) : 0;
                  return (
                    <Link key={p.id} href={`/tasks?project=${p.id}`} className="flex items-center gap-3">
                      <ProgressRing percent={pct} color={p.color || 'var(--accent)'} size={32} />
                      <div className="flex-1 min-w-0">
                        <span className="text-[12px] font-medium block truncate" style={{ color: 'var(--text-primary)' }}>{p.name}</span>
                        <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                          {p.done_tasks}/{p.total_tasks} done
                        </span>
                      </div>
                      <span className="text-[11px] font-mono font-bold" style={{ color: p.color || 'var(--accent)' }}>{pct}%</span>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <p className="text-[11px] py-2" style={{ color: 'var(--text-tertiary)' }}>No projects yet</p>
            )}
          </BentoCard>

          {/* Card 5: Activity */}
          <BentoCard title="Activity">
            {d.recent_activity.length > 0 ? (
              <div className="space-y-1">
                {d.recent_activity.slice(0, 5).map(a => (
                  <div key={a.id} className="flex items-start gap-2 py-0.5">
                    <div className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: 'var(--border-strong)' }} />
                    <span className="text-[11px] flex-1" style={{ color: 'var(--text-secondary)' }}>
                      {formatActivity(a)}
                    </span>
                    <span className="text-[9px] flex-shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                      {formatRelativeCompact(a.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px] py-2" style={{ color: 'var(--text-tertiary)' }}>No recent activity</p>
            )}
          </BentoCard>

          {/* Agent Activity card */}
          <BentoCard title="Agent Activity" headerRight={
            agentEmployees.length > 0 ? (
              <select
                value={employeeFilter}
                onChange={(e) => setEmployeeFilter(e.target.value)}
                style={{
                  fontSize: '11px',
                  background: 'var(--surface-container)',
                  border: '1px solid var(--border)',
                  borderRadius: '4px',
                  padding: '2px 8px',
                  color: 'var(--muted)',
                  outline: 'none',
                }}
              >
                <option value="all">All Agents</option>
                {agentEmployees.map(emp => (
                  <option key={emp.id} value={emp.id}>{emp.name}</option>
                ))}
              </select>
            ) : undefined
          }>
            {agentActivity.filter(a => employeeFilter === 'all' || a.agent_employee_id === employeeFilter).length === 0 ? (
              <p className="text-[12px]" style={{ color: 'var(--muted)' }}>No recent agent activity</p>
            ) : (
              <div className="space-y-2">
                {agentActivity.filter(a => employeeFilter === 'all' || a.agent_employee_id === employeeFilter).slice(0, 8).map((a) => (
                  <div key={a.id} className="flex items-start gap-2 text-[12px]">
                    <div
                      className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
                      style={{
                        background: a.approval_status === 'approved'
                          ? a.error ? '#EF4444' : '#22C55E'
                          : '#EAB308',
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate" style={{ color: 'var(--foreground)' }}>
                        {formatAgentAction(a)}
                      </p>
                      <p style={{ color: 'var(--muted)', fontSize: '10px' }}>
                        {a.approval_status === 'pending' ? 'Awaiting approval \u00b7 ' : ''}
                        {new Date(a.executed_at || a.created_at).toLocaleString('en', {
                          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                        })}
                      </p>
                      {/* Block 2.8 — inline approve/reject buttons when pending */}
                      {a.approval_status === 'pending' && (
                        <div className="flex gap-1.5 mt-1">
                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              const res = await api.post(`/api/agent/actions/${a.id}/approve`);
                              if (res.ok) {
                                const r = await api.get('/api/dashboard/agent-activity');
                                if (r.ok) setAgentActivity(await r.json());
                              }
                            }}
                            className="min-h-[44px] md:min-h-0 px-4 md:px-2 py-2 md:py-0.5 text-sm md:text-[10px]"
                            style={{
                              borderRadius: '4px',
                              background: 'var(--status-green)',
                              color: 'white',
                              border: 'none',
                              cursor: 'pointer',
                              fontWeight: 500,
                            }}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              const res = await api.post(`/api/agent/actions/${a.id}/reject`);
                              if (res.ok) {
                                const r = await api.get('/api/dashboard/agent-activity');
                                if (r.ok) setAgentActivity(await r.json());
                              }
                            }}
                            className="min-h-[44px] md:min-h-0 px-4 md:px-2 py-2 md:py-0.5 text-sm md:text-[10px]"
                            style={{
                              borderRadius: '4px',
                              background: 'transparent',
                              color: 'var(--text-secondary)',
                              border: '1px solid var(--border-default)',
                              cursor: 'pointer',
                              fontWeight: 500,
                            }}
                          >
                            Reject
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </BentoCard>

          {/* Card 6: Calendar */}
          <BentoCard title="Calendar">
            <CalendarWidget />
          </BentoCard>

          {/* Card 7: My Work — Kanban-lite (span 2) */}
          <BentoCard title="My Work" span={2}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 h-full">
              {(['todo', 'in_progress', 'in_review'] as const).map(status => (
                <div key={status}>
                  <div className="flex items-center gap-1.5 mb-2 pb-1"
                    style={{ borderBottom: '1px solid var(--border-default)' }}>
                    <div className="w-1.5 h-1.5 rounded-full" style={{
                      background: status === 'in_progress' ? 'var(--status-amber)' :
                        status === 'in_review' ? 'var(--status-blue)' : 'var(--text-tertiary)',
                    }} />
                    <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                      {statusLabel(status)}
                    </span>
                    <span className="text-[9px] font-mono" style={{ color: 'var(--text-tertiary)' }}>
                      {(kanban[status] || []).length}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {(kanban[status] || []).slice(0, 3).map(t => (
                      <Link key={t.id} href={`/tasks?task=${t.project_prefix}-${t.number}`} className="block">
                        <TaskCardUnified
                          variant="dashboard"
                          task={t as UnifiedTask}
                        />
                      </Link>
                    ))}
                    {(kanban[status] || []).length === 0 && (
                      <p className="text-[10px] py-2 text-center" style={{ color: 'var(--text-tertiary)' }}>Empty</p>
                    )}
                    {(kanban[status] || []).length > 3 && (
                      <p className="text-[10px] text-center pt-1" style={{ color: 'var(--text-tertiary)' }}>
                        +{(kanban[status] || []).length - 3} more
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Card 7: Team (manager only) */}
          {isManagerRole && teamHealth && teamHealth.healthCards.length > 0 && (
            <BentoCard title="Team" headerRight={
              <span className="text-[9px] px-1.5 py-0.5 rounded font-medium"
                style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>Manager</span>
            }>
              <div className="space-y-2">
                {teamHealth.healthCards.map(card => {
                  const dotColor = card.status === 'green' ? 'var(--status-green)' : card.status === 'yellow' ? 'var(--status-amber)' : 'var(--status-red)';
                  return (
                    <div key={card.userId} className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: dotColor }} />
                      <span className="text-[11px] font-medium flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
                        {card.name}
                      </span>
                      <span className="text-[9px]" style={{ color: 'var(--text-tertiary)' }}>
                        {card.activeTasks}t
                      </span>
                    </div>
                  );
                })}
                {oneonePreps.length > 0 && (
                  <div className="pt-2 mt-1 space-y-1" style={{ borderTop: '1px solid var(--border-default)' }}>
                    {oneonePreps.map(prep => (
                      <button key={prep.id} onClick={() => setPrepModal(prep)}
                        className="flex items-center gap-1.5 text-[10px] font-medium w-full"
                        style={{ color: 'var(--accent)' }}>
                        <Users size={10} /> 1:1 {prep.report_name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </BentoCard>
          )}

          {/* My Insights card */}
          {myInsights && (
            <BentoCard title="My Insights" bg="var(--surface-container, var(--bg-surface))">
              <div className="space-y-3">
                <div className="flex gap-3">
                  <div className="text-center flex-1">
                    <span className="text-[18px] font-bold block" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono, monospace)' }}>
                      {myInsights.activity.tasks_completed}
                    </span>
                    <span className="text-[9px]" style={{ color: 'var(--text-tertiary)' }}>done</span>
                  </div>
                  <div className="text-center flex-1">
                    <span className="text-[18px] font-bold block" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono, monospace)' }}>
                      {myInsights.activity.messages_sent}
                    </span>
                    <span className="text-[9px]" style={{ color: 'var(--text-tertiary)' }}>msgs</span>
                  </div>
                  <div className="text-center flex-1">
                    <span className="text-[18px] font-bold block" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono, monospace)' }}>
                      {myInsights.activity.spaces_active.length}
                    </span>
                    <span className="text-[9px]" style={{ color: 'var(--text-tertiary)' }}>spaces</span>
                  </div>
                </div>
                {myInsights.pace.length > 0 && (
                  <div className="flex items-end gap-1 h-8">
                    {myInsights.pace.map((w, i) => {
                      const max = Math.max(...myInsights.pace.map(p => p.completed), 1);
                      const height = Math.max((w.completed / max) * 100, 10);
                      return (
                        <div key={i} className="flex-1 rounded-sm" style={{
                          background: i === myInsights.pace.length - 1 ? 'var(--accent)' : 'var(--accent-muted)',
                          height: `${height}%`, minHeight: '2px',
                        }} />
                      );
                    })}
                  </div>
                )}
                {myInsights.expertise.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {myInsights.expertise.slice(0, 4).map(e => (
                      <span key={e.topic} className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                        style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
                        {e.topic}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </BentoCard>
          )}
        </div>
      </div>

      {/* 1:1 Prep Modal */}
      {prepModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="w-[calc(100vw-2rem)] max-w-lg rounded-xl p-5 max-h-[90vh] overflow-y-auto"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', boxShadow: '0 8px 30px rgba(0,0,0,0.12)' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                1:1 Prep — {prepModal.report_name}
              </h3>
              <button onClick={() => setPrepModal(null)} className="p-1 rounded-md" style={{ color: 'var(--text-tertiary)' }}>
                <X size={16} />
              </button>
            </div>
            {prepModal.prep_content && (
              <div className="space-y-3 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                {prepModal.prep_content.summary && (
                  <div><span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Summary</span><p className="mt-1">{prepModal.prep_content.summary}</p></div>
                )}
                {prepModal.prep_content.wins?.length > 0 && (
                  <div><span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Wins</span>
                    <ul className="mt-1 list-disc pl-4 space-y-0.5">{prepModal.prep_content.wins.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>
                  </div>
                )}
                {prepModal.prep_content.currentFocus?.length > 0 && (
                  <div><span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Current Focus</span>
                    <ul className="mt-1 list-disc pl-4 space-y-0.5">{prepModal.prep_content.currentFocus.map((f: string, i: number) => <li key={i}>{f}</li>)}</ul>
                  </div>
                )}
                {prepModal.prep_content.concerns?.length > 0 && (
                  <div><span className="font-semibold" style={{ color: 'var(--status-amber)' }}>Concerns</span>
                    <ul className="mt-1 list-disc pl-4 space-y-0.5">{prepModal.prep_content.concerns.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul>
                  </div>
                )}
                {prepModal.prep_content.talkingPoints?.length > 0 && (
                  <div><span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Talking Points</span>
                    <ul className="mt-1 list-disc pl-4 space-y-0.5">{prepModal.prep_content.talkingPoints.map((t: string, i: number) => <li key={i}>{t}</li>)}</ul>
                  </div>
                )}
                {prepModal.prep_content.commitments?.length > 0 && (
                  <div><span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Follow-up Commitments</span>
                    <ul className="mt-1 list-disc pl-4 space-y-0.5">{prepModal.prep_content.commitments.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul>
                  </div>
                )}
                {prepModal.prep_content.talking_points?.length > 0 && !prepModal.prep_content.talkingPoints && (
                  <div><span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Talking Points</span>
                    <ul className="mt-1 list-disc pl-4 space-y-0.5">{prepModal.prep_content.talking_points.map((t: string, i: number) => <li key={i}>{t}</li>)}</ul>
                  </div>
                )}
                {prepModal.prep_content.suggested_questions?.length > 0 && (
                  <div><span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Suggested Questions</span>
                    <ul className="mt-1 list-disc pl-4 space-y-0.5">{prepModal.prep_content.suggested_questions.map((q: string, i: number) => <li key={i}>{q}</li>)}</ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Standup Modal */}
      {standupOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
          onClick={e => { if (e.target === e.currentTarget) setStandupOpen(false); }}>
          <div className="w-full max-w-[520px] mx-4 max-h-[70vh] flex flex-col rounded-xl overflow-hidden"
            style={{ background: 'var(--surface-container)', boxShadow: 'var(--glass-shadow)' }}>
            <div className="flex items-center justify-between px-5 py-4 flex-shrink-0"
              style={{ borderBottom: '1px solid var(--ghost-border)' }}>
              <div className="flex items-center gap-2">
                <Sunrise size={16} strokeWidth={1.5} style={{ color: 'var(--status-amber)' }} />
                <h2 className="text-[0.9375rem] font-semibold" style={{ color: 'var(--on-surface)' }}>Daily Standup</h2>
                {d.standup && (
                  <span className="text-[0.6875rem]" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
                    {formatMessageTime(d.standup.date)}
                  </span>
                )}
              </div>
              <button onClick={() => setStandupOpen(false)} className="p-3 md:p-1 min-h-[44px] md:min-h-0 min-w-[44px] md:min-w-0 flex items-center justify-center rounded-md" style={{ color: 'var(--outline)' }}>
                <X size={16} strokeWidth={1.5} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {d.standup ? (
                <div className="text-[0.8125rem] leading-relaxed message-content" style={{ color: 'var(--on-surface-variant)' }}
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderSimpleMarkdown(d.standup.summary)) }} />
              ) : standupGenerating ? (
                <div className="flex items-center justify-center py-12 gap-2" style={{ color: 'var(--outline)' }}>
                  <Loader2 size={16} className="animate-spin" />
                  <span className="text-[0.8125rem]">Generating standup...</span>
                </div>
              ) : (
                <div className="text-center py-12">
                  <p className="text-[0.8125rem]" style={{ color: 'var(--outline)' }}>No standup generated yet today.</p>
                  <button onClick={handleGenerateStandup}
                    className="mt-3 px-4 py-2 rounded-lg text-[0.8125rem] font-medium text-white"
                    style={{ background: 'var(--primary-container)' }}>Generate Now</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
