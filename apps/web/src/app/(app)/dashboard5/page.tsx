'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { sanitizeHtml } from '@/lib/sanitize';
import { api } from '@/lib/api';
import { formatRelativeCompact, formatFullDateLong, formatMessageTime } from '@/lib/time';
import Link from 'next/link';
import {
  CheckCircle2, Circle, MessageSquare, Plus, Bot, Sunrise, Loader2, X,
  Users, ArrowRight, ChevronLeft, ChevronRight, GitPullRequest, GitMerge,
  GitBranch, AlertCircle, Shield, TrendingUp, Clock, LayoutDashboard,
} from 'lucide-react';
import { CalTask, CalEvent, CalNote, DayBucket, toDateKey, buildMonthGrid, bucketByDay, CAL_DAYS_SHORT, ITEM_COLORS } from '@/lib/calendar';
import { statusLabel } from '@/lib/task-status-labels';
import { TaskCardUnified, type UnifiedTask } from '@/components/task-card-unified';

// ─── Types ───────────────────────────────────────────────────────────────────

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
  id: string; action: string; params: any; result: any;
  approval_status: string; approval_tier: string;
  executed_at: string | null; created_at: string;
  error: string | null; agent_employee_id: string | null;
};

type AgentEmployeeBrief = { id: string; name: string };

type DashboardData = {
  greeting: string; standup: StandupData;
  due_today: DashboardTask[]; due_this_week: DashboardTask[];
  overdue: DashboardTask[]; in_progress: DashboardTask[];
  my_work: DashboardTask[]; unread_spaces: UnreadSpace[];
  recent_activity: ActivityEntry[]; projects: DashboardProject[];
  calendar_events: any[]; github_activity: GitHubEvent[];
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderSimpleMarkdown(text: string): string {
  if (!text) return '';
  let html = text
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3 style="font-size:12px;font-weight:600;margin:6px 0 2px">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:13px;font-weight:600;margin:8px 0 3px">$1</h2>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul style="list-style:disc;padding-left:16px;margin:3px 0">$1</ul>')
    .replace(/^> (.+)$/gm, '<blockquote style="border-left:2px solid var(--accent);padding-left:10px;margin:4px 0;opacity:0.8">$1</blockquote>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br/>');
  if (!html.startsWith('<')) html = '<p>' + html + '</p>';
  return html;
}

const PRIORITY_COLORS: Record<string, string> = {
  p0: 'var(--status-red)', p1: 'var(--status-amber)',
  p2: 'var(--status-blue)', p3: 'var(--status-gray)',
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
    case 'create_task': return `Created "${p.title}"`;
    case 'update_task_status': return `Moved ${p.task_identifier} → ${(p.new_status || '').replace(/_/g, ' ')}`;
    case 'assign_task': return `Assigned ${p.task_identifier} to ${p.assignee_name}`;
    case 'post_message': return `Posted in #${p.space_name}`;
    case 'add_knowledge': return `Added ${p.type}: "${p.title}"`;
    case 'wiki_write': return `Updated wiki: ${p.title || p.slug}`;
    case 'create_calendar_event': return `Created event: ${p.title}`;
    default: return a.action.replace(/_/g, ' ');
  }
}

function getLocalGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Card({ title, span = 1, children, headerRight, accent }: {
  title: string; span?: number; children: React.ReactNode;
  headerRight?: React.ReactNode; accent?: boolean;
}) {
  const spanClass = span >= 3 ? 'md:col-span-3' : span >= 2 ? 'md:col-span-2' : '';
  return (
    <div className={`rounded-xl flex flex-col col-span-1 ${spanClass} overflow-hidden`} style={{
      background: 'var(--surface-container-low, var(--bg-surface))',
      border: '1px solid var(--border-default)',
      borderTop: accent ? '2px solid var(--primary-container)' : undefined,
    }}>
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2 flex-shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: 'var(--text-tertiary, var(--outline))' }}>{title}</span>
        {headerRight}
      </div>
      <div className="flex-1 min-h-0 px-4 pb-3">{children}</div>
    </div>
  );
}

function ProgressRing({ percent, color, size = 32 }: { percent: number; color: string; size?: number }) {
  const r = (size - 5) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="var(--border-default)" strokeWidth={2.5} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={color} strokeWidth={2.5} strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={circ - (percent / 100) * circ} />
    </svg>
  );
}

function CalendarWidget() {
  const today = toDateKey(new Date());
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [calData, setCalData] = useState<{ tasks: CalTask[]; events: CalEvent[]; notes: CalNote[] } | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const grid = buildMonthGrid(month);
  const dayBuckets = calData ? bucketByDay(calData) : new Map<string, DayBucket>();

  useEffect(() => {
    const from = new Date(grid[0]); from.setHours(0, 0, 0, 0);
    const to = new Date(grid[grid.length - 1]); to.setHours(23, 59, 59, 999);
    api.get(`/api/calendar?from=${from.toISOString()}&to=${to.toISOString()}`).then(async res => {
      if (res.ok) setCalData(await res.json());
    });
  }, [grid[0].getTime()]);

  const selectedBucket = selectedDay ? dayBuckets.get(selectedDay) : null;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <button onClick={() => { const d = new Date(month); d.setMonth(d.getMonth() - 1); setMonth(d); setSelectedDay(null); }}
          className="p-0.5 rounded" style={{ color: 'var(--text-tertiary)' }}>
          <ChevronLeft size={13} />
        </button>
        <span className="text-[10px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
        </span>
        <button onClick={() => { const d = new Date(month); d.setMonth(d.getMonth() + 1); setMonth(d); setSelectedDay(null); }}
          className="p-0.5 rounded" style={{ color: 'var(--text-tertiary)' }}>
          <ChevronRight size={13} />
        </button>
      </div>
      <div className="grid grid-cols-7 mb-0.5">
        {CAL_DAYS_SHORT.map((d, i) => (
          <div key={i} className="text-center text-[9px] font-semibold py-0.5" style={{ color: 'var(--text-tertiary)' }}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {grid.map((date, i) => {
          const key = toDateKey(date);
          const isToday = key === today;
          const isSelected = key === selectedDay;
          const bucket = dayBuckets.get(key);
          const hasItems = bucket && (bucket.tasks.length + bucket.events.length + bucket.notes.length) > 0;
          return (
            <button key={i} onClick={() => setSelectedDay(isSelected ? null : key)}
              className="relative flex flex-col items-center py-1 rounded"
              style={{
                background: isSelected ? 'var(--bg-active)' : isToday ? 'var(--accent-muted,rgba(99,102,241,0.1))' : 'transparent',
                opacity: date.getMonth() === month.getMonth() ? 1 : 0.3,
              }}>
              <span className="text-[10px] font-medium" style={{ color: isToday ? 'var(--accent)' : 'var(--text-primary)' }}>
                {date.getDate()}
              </span>
              {hasItems && (
                <div className="flex gap-px mt-0.5">
                  {bucket!.events.length > 0 && <div className="w-[3px] h-[3px] rounded-full" style={{ background: ITEM_COLORS.event }} />}
                  {bucket!.tasks.length > 0 && <div className="w-[3px] h-[3px] rounded-full" style={{ background: ITEM_COLORS.task }} />}
                  {bucket!.notes.length > 0 && <div className="w-[3px] h-[3px] rounded-full" style={{ background: ITEM_COLORS.note }} />}
                </div>
              )}
            </button>
          );
        })}
      </div>
      {selectedDay && selectedBucket && (selectedBucket.tasks.length + selectedBucket.events.length + selectedBucket.notes.length) > 0 && (
        <div className="mt-2 pt-2 space-y-1" style={{ borderTop: '1px solid var(--border-default)' }}>
          {selectedBucket.events.map(e => (
            <div key={e.id} className="flex items-center gap-2 text-[10px]">
              <div className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: ITEM_COLORS.event }} />
              <span className="truncate flex-1" style={{ color: 'var(--text-primary)' }}>{e.title}</span>
              <span style={{ color: 'var(--text-tertiary)' }}>{new Date(e.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
            </div>
          ))}
          {selectedBucket.tasks.map(t => (
            <Link key={t.id} href={`/tasks?task=${t.project_prefix}-${t.number}`} className="flex items-center gap-2 text-[10px]">
              {t.status === 'done'
                ? <CheckCircle2 size={10} style={{ color: 'var(--status-green)' }} />
                : <Circle size={10} style={{ color: PRIORITY_COLORS[t.priority] || 'var(--text-tertiary)' }} />}
              <span className="truncate flex-1" style={{ color: 'var(--text-primary)', textDecoration: t.status === 'done' ? 'line-through' : 'none', opacity: t.status === 'done' ? 0.5 : 1 }}>{t.title}</span>
            </Link>
          ))}
        </div>
      )}
      {selectedDay && (!selectedBucket || (selectedBucket.tasks.length + selectedBucket.events.length + selectedBucket.notes.length) === 0) && (
        <p className="text-[10px] text-center pt-2 mt-2" style={{ borderTop: '1px solid var(--border-default)', color: 'var(--text-tertiary)' }}>Nothing on this day</p>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Dashboard5Page() {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [clientGreeting, setClientGreeting] = useState<string | null>(null);
  const [standupGenerating, setStandupGenerating] = useState(false);
  const [standupOpen, setStandupOpen] = useState(false);
  const [myInsights, setMyInsights] = useState<MyInsightsData | null>(null);
  const [agentActivity, setAgentActivity] = useState<AgentActivity[]>([]);
  const [agentEmployees, setAgentEmployees] = useState<AgentEmployeeBrief[]>([]);
  const [employeeFilter, setEmployeeFilter] = useState('all');
  const [teamHealth, setTeamHealth] = useState<TeamHealthData | null>(null);
  const [oneonePreps, setOneonePreps] = useState<OneOnePrepData[]>([]);
  const [prepModal, setPrepModal] = useState<OneOnePrepData | null>(null);

  const isManager = user?.role === 'owner' || user?.role === 'admin';

  useEffect(() => { setClientGreeting(getLocalGreeting()); }, []);

  useEffect(() => {
    api.get('/api/dashboard').then(async r => { if (r.ok) setData(await r.json()); setLoading(false); }).catch(() => setLoading(false));
    api.get('/api/dashboard/my-insights').then(async r => { if (r.ok) setMyInsights(await r.json()); }).catch(() => {});
    api.get('/api/dashboard/agent-activity').then(async r => { if (r.ok) setAgentActivity(await r.json()); }).catch(() => {});
    api.get('/api/agent-employees').then(async r => { if (r.ok) { const d = await r.json(); setAgentEmployees(d.map((e: any) => ({ id: e.id, name: e.name }))); } }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isManager) return;
    api.get('/api/manager/team-health').then(async r => {
      if (r.ok) { const d = await r.json(); if (d.snapshot?.team_data) setTeamHealth(d.snapshot.team_data); else if (d.healthCards) setTeamHealth(d); }
    }).catch(() => {});
    api.get('/api/manager/oneone-preps').then(async r => {
      if (r.ok) { const d = await r.json(); const preps = d.preps || d; if (Array.isArray(preps)) setOneonePreps(preps.map((p: any) => ({ id: p.id, report_id: p.report_id, report_name: p.prep_content?.reportName || p.prep_content?.report_name || 'Team member', prep_content: p.prep_content, created_at: p.created_at }))); }
    }).catch(() => {});
  }, [isManager]);

  const handleGenerateStandup = async () => {
    setStandupGenerating(true);
    try {
      const r = await api.post('/api/dashboard/standup');
      if (r.ok) { const result = await r.json(); if (result.standup && data) setData({ ...data, standup: result.standup }); }
    } catch {} finally { setStandupGenerating(false); }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
    </div>
  );

  const d = data || {
    greeting: 'Good morning', standup: null, due_today: [], due_this_week: [],
    overdue: [], in_progress: [], my_work: [], unread_spaces: [], recent_activity: [],
    projects: [], calendar_events: [], github_activity: [],
  };

  // Derived
  const todayTasks = [...d.overdue, ...d.due_today].filter((t, i, arr) => arr.findIndex(x => x.id === t.id) === i)
    .sort((a, b) => (['p0','p1','p2','p3'].indexOf(a.priority)) - (['p0','p1','p2','p3'].indexOf(b.priority)));

  const kanban: Record<string, DashboardTask[]> = { todo: [], in_progress: [], in_review: [] };
  const seenWork = new Set<string>();
  (d.my_work ?? []).forEach(t => { if (!seenWork.has(t.id)) { seenWork.add(t.id); if (kanban[t.status]) kanban[t.status].push(t); } });

  const doneThisWeek = [...d.due_this_week, ...d.due_today].filter(t => t.status === 'done').length;
  const pendingApprovals = agentActivity.filter(a => a.approval_status === 'pending');
  const filteredAgentActivity = agentActivity.filter(a => employeeFilter === 'all' || a.agent_employee_id === employeeFilter);

  // GitHub helpers
  function ghEventIcon(e: GitHubEvent) {
    if (e.metadata.merged) return <GitMerge size={12} style={{ color: 'var(--status-purple, #a78bfa)', flexShrink: 0 }} />;
    if (e.event_type?.includes('pr')) return <GitPullRequest size={12} style={{ color: e.metadata.state === 'open' ? 'var(--status-green)' : 'var(--status-gray)', flexShrink: 0 }} />;
    if (e.event_type?.includes('issue')) return <AlertCircle size={12} style={{ color: e.metadata.state === 'open' ? 'var(--status-amber)' : 'var(--status-gray)', flexShrink: 0 }} />;
    return <GitBranch size={12} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />;
  }

  function ghStateBadge(e: GitHubEvent) {
    if (e.metadata.merged) return { label: 'merged', bg: 'rgba(167,139,250,0.15)', color: '#a78bfa' };
    if (e.metadata.state === 'open') return { label: 'open', bg: 'rgba(34,197,94,0.12)', color: 'var(--status-green)' };
    if (e.metadata.state === 'closed') return { label: 'closed', bg: 'rgba(107,114,128,0.12)', color: 'var(--status-gray)' };
    return null;
  }

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--bg-primary)' }}>
      <div className="w-full max-w-[1140px] mx-auto px-4 md:px-6 py-5">

        {/* ── Header ── */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 mb-5">
          <div>
            <h1 className="text-[20px] font-semibold" style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
              {clientGreeting ?? d.greeting}, {user?.name?.split(' ')[0]}
            </h1>
            <p className="text-[11px] mt-0.5 font-mono" style={{ color: 'var(--text-tertiary)' }}>{formatFullDateLong(new Date())}</p>
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            {[
              { label: '+ Task', href: '/tasks', style: { background: 'var(--primary-container)', color: 'white' } },
              { label: 'Chat', href: '/chat', icon: MessageSquare },
              { label: 'Agent', href: '/agent', icon: Bot },
            ].map(a => (
              <Link key={a.label} href={a.href}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium"
                style={a.style || { color: 'var(--text-secondary)', background: 'var(--surface-container-high)' }}>
                {a.icon && <a.icon size={12} strokeWidth={1.5} />}
                {a.label}
              </Link>
            ))}
            <button
              onClick={() => { if (!d.standup) handleGenerateStandup(); setStandupOpen(true); }}
              disabled={standupGenerating}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium"
              style={{ color: d.standup ? 'var(--status-amber)' : 'var(--text-secondary)', background: 'var(--surface-container-high)' }}>
              {standupGenerating ? <Loader2 size={12} className="animate-spin" /> : <Sunrise size={12} strokeWidth={1.5} />}
              Standup
            </button>
            {pendingApprovals.length > 0 && (
              <Link href="/agent" className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium"
                style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--status-red)' }}>
                <Shield size={12} strokeWidth={1.5} />
                {pendingApprovals.length} pending
              </Link>
            )}
          </div>
        </div>

        {/* ── Grid ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">

          {/* 1. Today (span 2) */}
          <Card title="Today" span={2} accent={d.overdue.length > 0} headerRight={
            <div className="flex items-center gap-2">
              {d.overdue.length > 0 && (
                <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full uppercase tracking-wide"
                  style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--status-red)' }}>
                  {d.overdue.length} overdue
                </span>
              )}
              {todayTasks.length > 0 && (
                <Link href="/tasks" className="text-[10px] flex items-center gap-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  All <ArrowRight size={10} />
                </Link>
              )}
            </div>
          }>
            {todayTasks.length > 0 ? (
              <div className="space-y-0.5">
                {todayTasks.slice(0, 7).map(t => (
                  <Link key={t.id} href={`/tasks?task=${t.project_prefix}-${t.number}`} className="block">
                    <TaskCardUnified variant="dashboard" task={t as UnifiedTask} isOverdue={d.overdue.some(o => o.id === t.id)} />
                  </Link>
                ))}
                {todayTasks.length > 7 && (
                  <p className="text-[10px] pt-1" style={{ color: 'var(--text-tertiary)' }}>+{todayTasks.length - 7} more</p>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-center py-8">
                <div className="text-center">
                  <CheckCircle2 size={18} strokeWidth={1.5} style={{ color: 'var(--status-green)', margin: '0 auto 6px', opacity: 0.5 }} />
                  <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>Nothing due today</p>
                </div>
              </div>
            )}
          </Card>

          {/* 2. Stats */}
          <Card title="At a Glance">
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: 'Overdue', value: d.overdue.length, color: 'var(--status-red)' },
                { label: 'Due Today', value: d.due_today.length, color: 'var(--status-amber)' },
                { label: 'In Progress', value: d.in_progress.length, color: 'var(--status-blue)' },
                { label: 'Done This Week', value: doneThisWeek, color: 'var(--status-green)' },
              ].map(s => (
                <div key={s.label} className="flex flex-col items-center justify-center rounded-lg py-3"
                  style={{ background: s.color + '10' }}>
                  <span className="text-[22px] font-bold font-mono leading-none" style={{ color: s.color }}>{s.value}</span>
                  <span className="text-[9px] mt-1 font-medium text-center" style={{ color: s.color, opacity: 0.75 }}>{s.label}</span>
                </div>
              ))}
            </div>
          </Card>

          {/* 3. My Work (span 2) */}
          <Card title="My Work" span={2}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {(['todo', 'in_progress', 'in_review'] as const).map(status => (
                <div key={status}>
                  <div className="flex items-center gap-1.5 mb-2 pb-1" style={{ borderBottom: '1px solid var(--border-default)' }}>
                    <div className="w-1.5 h-1.5 rounded-full" style={{
                      background: status === 'in_progress' ? 'var(--status-amber)' : status === 'in_review' ? 'var(--status-blue)' : 'var(--text-tertiary)',
                    }} />
                    <span className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                      {statusLabel(status)}
                    </span>
                    <span className="text-[9px] font-mono ml-auto" style={{ color: 'var(--text-tertiary)' }}>
                      {(kanban[status] || []).length}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {(kanban[status] || []).slice(0, 3).map(t => (
                      <Link key={t.id} href={`/tasks?task=${t.project_prefix}-${t.number}`} className="block">
                        <TaskCardUnified variant="dashboard" task={t as UnifiedTask} />
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
          </Card>

          {/* 4. Calendar */}
          <Card title="Calendar">
            <CalendarWidget />
          </Card>

          {/* 5. Due This Week — NEW: was never shown in any dashboard */}
          <Card title="Due This Week" headerRight={
            d.due_this_week.length > 0 ? (
              <Link href="/tasks" className="text-[10px] flex items-center gap-0.5" style={{ color: 'var(--text-tertiary)' }}>
                All <ArrowRight size={10} />
              </Link>
            ) : null
          }>
            {d.due_this_week.filter(t => t.status !== 'done').length > 0 ? (
              <div className="space-y-1.5">
                {d.due_this_week.filter(t => t.status !== 'done').slice(0, 6).map(t => {
                  const dueDate = t.due_date ? new Date(t.due_date) : null;
                  const dayLabel = dueDate ? dueDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
                  return (
                    <Link key={t.id} href={`/tasks?task=${t.project_prefix}-${t.number}`}
                      className="flex items-center gap-2 py-0.5 rounded -mx-1 px-1"
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: PRIORITY_COLORS[t.priority] }} />
                      <span className="text-[11px] flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{t.title}</span>
                      <span className="text-[9px] font-mono flex-shrink-0" style={{ color: 'var(--text-tertiary)' }}>{dayLabel}</span>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <p className="text-[11px] py-2" style={{ color: 'var(--text-tertiary)' }}>
                {d.due_this_week.length > 0 ? 'All done for the week 🎉' : 'Nothing due this week'}
              </p>
            )}
          </Card>

          {/* 6. GitHub Activity — NEW: data existed but never shown */}
          <Card title="GitHub" headerRight={
            d.github_activity.length > 0 ? (
              <span className="text-[9px] font-mono" style={{ color: 'var(--text-tertiary)' }}>{d.github_activity.length} events</span>
            ) : null
          }>
            {d.github_activity.length > 0 ? (
              <div className="space-y-2">
                {d.github_activity.slice(0, 6).map(e => {
                  const badge = ghStateBadge(e);
                  return (
                    <div key={e.id} className="flex items-start gap-2">
                      <div className="mt-0.5">{ghEventIcon(e)}</div>
                      <div className="flex-1 min-w-0">
                        {e.url ? (
                          <a href={e.url} target="_blank" rel="noopener noreferrer"
                            className="text-[11px] font-medium truncate block hover:underline" style={{ color: 'var(--text-primary)' }}>
                            {e.title}
                          </a>
                        ) : (
                          <span className="text-[11px] font-medium truncate block" style={{ color: 'var(--text-primary)' }}>{e.title}</span>
                        )}
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {e.metadata.repo && (
                            <span className="text-[9px] font-mono" style={{ color: 'var(--text-tertiary)' }}>{e.metadata.repo}</span>
                          )}
                          {badge && (
                            <span className="text-[9px] font-semibold px-1 py-px rounded" style={{ background: badge.bg, color: badge.color }}>
                              {badge.label}
                            </span>
                          )}
                          <span className="text-[9px] ml-auto" style={{ color: 'var(--text-tertiary)' }}>
                            {formatRelativeCompact(e.timestamp)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-6 gap-2">
                <GitBranch size={16} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)', opacity: 0.5 }} />
                <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>No GitHub activity</p>
                <Link href="/settings/integrations" className="text-[10px]" style={{ color: 'var(--accent)' }}>Connect GitHub →</Link>
              </div>
            )}
          </Card>

          {/* 7. Unread */}
          <Card title="Unread" headerRight={
            d.unread_spaces.length > 0 ? (
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full"
                style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
                {d.unread_spaces.reduce((s, u) => s + u.unread_count, 0)}
              </span>
            ) : null
          }>
            {d.unread_spaces.length > 0 ? (
              <div className="space-y-0.5">
                {d.unread_spaces.slice(0, 6).map(s => (
                  <Link key={s.space_id} href="/chat"
                    className="flex items-center gap-2 px-1.5 py-1 rounded-lg -mx-1.5"
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <span className="text-[11px] font-medium flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
                      {s.space_type === 'dm' ? s.space_name : `#${s.space_name}`}
                    </span>
                    {s.last_message && (
                      <span className="text-[10px] flex-1 truncate hidden sm:block" style={{ color: 'var(--text-tertiary)' }}>
                        {s.last_message}
                      </span>
                    )}
                    <span className="text-[9px] min-w-[18px] h-[18px] flex items-center justify-center rounded-full font-bold flex-shrink-0"
                      style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
                      {s.unread_count}
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-[11px] py-2" style={{ color: 'var(--text-tertiary)' }}>All caught up!</p>
            )}
          </Card>

          {/* 8. Projects */}
          <Card title="Projects">
            {d.projects.length > 0 ? (
              <div className="space-y-2.5">
                {d.projects.map(p => {
                  const pct = p.total_tasks > 0 ? Math.round((p.done_tasks / p.total_tasks) * 100) : 0;
                  return (
                    <Link key={p.id} href={`/tasks?project=${p.id}`} className="flex items-center gap-2.5">
                      <ProgressRing percent={pct} color={p.color || 'var(--accent)'} size={30} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1">
                          <span className="text-[11px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{p.name}</span>
                          {p.my_tasks > 0 && (
                            <span className="text-[9px] px-1 py-px rounded flex-shrink-0"
                              style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
                              {p.my_tasks} mine
                            </span>
                          )}
                        </div>
                        <span className="text-[9px] font-mono" style={{ color: 'var(--text-tertiary)' }}>
                          {p.done_tasks}/{p.total_tasks} done
                        </span>
                      </div>
                      <span className="text-[10px] font-mono font-bold flex-shrink-0" style={{ color: p.color || 'var(--accent)' }}>{pct}%</span>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <p className="text-[11px] py-2" style={{ color: 'var(--text-tertiary)' }}>No projects yet</p>
            )}
          </Card>

          {/* 9. Top Collaborators — NEW: from my-insights, never shown */}
          <Card title="Top Collaborators" headerRight={
            <TrendingUp size={12} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)' }} />
          }>
            {myInsights?.top_collaborators && myInsights.top_collaborators.length > 0 ? (
              <div className="space-y-2">
                {myInsights.top_collaborators.slice(0, 5).map((c, i) => {
                  const maxScore = myInsights.top_collaborators[0]?.score || 1;
                  const barWidth = Math.round((c.score / maxScore) * 100);
                  return (
                    <div key={c.name} className="flex items-center gap-2">
                      <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0"
                        style={{ background: `hsl(${(i * 47 + 250) % 360}, 60%, 55%)` }}>
                        {c.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-[11px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{c.name}</span>
                          <span className="text-[9px] font-mono flex-shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                            {c.interactions} interactions
                          </span>
                        </div>
                        <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--border-default)' }}>
                          <div className="h-full rounded-full" style={{ width: `${barWidth}%`, background: 'var(--accent)' }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-6 gap-1">
                <Users size={16} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)', opacity: 0.5 }} />
                <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>No collaboration data yet</p>
              </div>
            )}
          </Card>

          {/* 10. Agent Activity (span 2) */}
          <Card title="Agent Activity" span={2} headerRight={
            <div className="flex items-center gap-2">
              {pendingApprovals.length > 0 && (
                <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full"
                  style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--status-red)' }}>
                  {pendingApprovals.length} need approval
                </span>
              )}
              {agentEmployees.length > 0 && (
                <select value={employeeFilter} onChange={e => setEmployeeFilter(e.target.value)} style={{
                  fontSize: '10px', background: 'var(--surface-container)', border: '1px solid var(--border)',
                  borderRadius: '4px', padding: '2px 6px', color: 'var(--muted)', outline: 'none',
                }}>
                  <option value="all">All Agents</option>
                  {agentEmployees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              )}
            </div>
          }>
            {filteredAgentActivity.length === 0 ? (
              <p className="text-[11px] py-2" style={{ color: 'var(--text-tertiary)' }}>No recent agent activity</p>
            ) : (
              <div className="space-y-2">
                {filteredAgentActivity.slice(0, 8).map(a => (
                  <div key={a.id} className="flex items-start gap-2">
                    <div className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{
                      background: a.approval_status === 'pending' ? 'var(--status-amber)'
                        : a.error ? 'var(--status-red)' : 'var(--status-green)',
                    }} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] truncate" style={{ color: 'var(--text-primary)' }}>
                        {formatAgentAction(a)}
                      </p>
                      <p className="text-[9px] font-mono" style={{ color: 'var(--text-tertiary)' }}>
                        {a.approval_status === 'pending' ? '⏳ awaiting approval · ' : ''}
                        {formatRelativeCompact(a.executed_at || a.created_at)}
                      </p>
                    </div>
                    {a.approval_status === 'pending' && (
                      <Link href="/agent" className="text-[9px] px-1.5 py-0.5 rounded flex-shrink-0"
                        style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--status-red)' }}>
                        Review
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* 11. Activity Feed */}
          <Card title="Activity">
            {d.recent_activity.length > 0 ? (
              <div className="space-y-1.5">
                {d.recent_activity.slice(0, 7).map(a => (
                  <div key={a.id} className="flex items-start gap-2">
                    <div className="w-1 h-1 rounded-full mt-1.5 flex-shrink-0" style={{ background: 'var(--border-strong, var(--accent-muted))' }} />
                    <span className="text-[11px] flex-1 leading-snug" style={{ color: 'var(--text-secondary)' }}>{formatActivity(a)}</span>
                    <span className="text-[9px] flex-shrink-0 font-mono" style={{ color: 'var(--text-tertiary)' }}>
                      {formatRelativeCompact(a.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px] py-2" style={{ color: 'var(--text-tertiary)' }}>No recent activity</p>
            )}
          </Card>

          {/* 12. My Insights */}
          {myInsights && (
            <Card title="My Insights" span={2}>
              <div className="flex gap-4 flex-wrap">
                {/* Stats */}
                <div className="flex gap-4 flex-shrink-0">
                  {[
                    { value: myInsights.activity.tasks_completed, label: 'done' },
                    { value: myInsights.activity.messages_sent, label: 'msgs' },
                    { value: myInsights.activity.spaces_active.length, label: 'spaces' },
                  ].map(s => (
                    <div key={s.label} className="text-center">
                      <span className="text-[20px] font-bold font-mono block leading-none" style={{ color: 'var(--text-primary)' }}>{s.value}</span>
                      <span className="text-[9px] mt-1 block" style={{ color: 'var(--text-tertiary)' }}>{s.label}</span>
                    </div>
                  ))}
                </div>

                {/* Pace chart */}
                {myInsights.pace.length > 0 && (
                  <div className="flex-1 min-w-[80px]">
                    <p className="text-[9px] mb-1 font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>Weekly pace</p>
                    <div className="flex items-end gap-1 h-8">
                      {myInsights.pace.map((w, i) => {
                        const max = Math.max(...myInsights.pace.map(p => p.completed), 1);
                        return (
                          <div key={i} title={`${w.completed} tasks`} className="flex-1 rounded-sm" style={{
                            background: i === myInsights.pace.length - 1 ? 'var(--accent)' : 'var(--accent-muted)',
                            height: `${Math.max((w.completed / max) * 100, 8)}%`,
                          }} />
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Expertise */}
                {myInsights.expertise.length > 0 && (
                  <div className="flex-shrink-0">
                    <p className="text-[9px] mb-1 font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>Expertise</p>
                    <div className="flex flex-wrap gap-1">
                      {myInsights.expertise.slice(0, 6).map(e => (
                        <span key={e.topic} className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                          style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
                          {e.topic}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* 13. Team Health (manager only) */}
          {isManager && teamHealth && teamHealth.healthCards.length > 0 && (
            <Card title="Team" headerRight={
              <span className="text-[9px] px-1.5 py-0.5 rounded font-medium"
                style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>Manager</span>
            }>
              <div className="space-y-2">
                {teamHealth.healthCards.map(c => {
                  const dotColor = c.status === 'green' ? 'var(--status-green)' : c.status === 'yellow' ? 'var(--status-amber)' : 'var(--status-red)';
                  return (
                    <div key={c.userId} className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: dotColor }} />
                      <span className="text-[11px] font-medium flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{c.name}</span>
                      {c.overdueTasks > 0 && (
                        <span className="text-[9px] font-mono" style={{ color: 'var(--status-red)' }}>{c.overdueTasks} overdue</span>
                      )}
                      <span className="text-[9px]" style={{ color: 'var(--text-tertiary)' }}>{c.activeTasks}t</span>
                    </div>
                  );
                })}
                {oneonePreps.length > 0 && (
                  <div className="pt-1.5 mt-0.5 space-y-1" style={{ borderTop: '1px solid var(--border-default)' }}>
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
            </Card>
          )}

        </div>
      </div>

      {/* ── 1:1 Prep Modal ── */}
      {prepModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="w-[calc(100vw-2rem)] max-w-lg rounded-xl p-5 max-h-[90vh] overflow-y-auto"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', boxShadow: '0 8px 30px rgba(0,0,0,0.12)' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>1:1 Prep — {prepModal.report_name}</h3>
              <button onClick={() => setPrepModal(null)} className="p-1 rounded-md" style={{ color: 'var(--text-tertiary)' }}><X size={16} /></button>
            </div>
            {prepModal.prep_content && (
              <div className="space-y-3 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                {(['summary', 'wins', 'currentFocus', 'concerns', 'talkingPoints', 'commitments', 'talking_points', 'suggested_questions'] as const).map(key => {
                  const val = (prepModal.prep_content as any)[key];
                  if (!val) return null;
                  const label = key === 'currentFocus' ? 'Current Focus' : key === 'talkingPoints' || key === 'talking_points' ? 'Talking Points' : key === 'suggested_questions' ? 'Suggested Questions' : key.charAt(0).toUpperCase() + key.slice(1);
                  if (typeof val === 'string') return (
                    <div key={key}><span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{label}</span><p className="mt-1">{val}</p></div>
                  );
                  if (Array.isArray(val) && val.length > 0) return (
                    <div key={key}><span className="font-semibold" style={{ color: key === 'concerns' ? 'var(--status-amber)' : 'var(--text-primary)' }}>{label}</span>
                      <ul className="mt-1 list-disc pl-4 space-y-0.5">{val.map((v: string, i: number) => <li key={i}>{v}</li>)}</ul>
                    </div>
                  );
                  return null;
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Standup Modal ── */}
      {standupOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
          onClick={e => { if (e.target === e.currentTarget) setStandupOpen(false); }}>
          <div className="w-full max-w-[520px] mx-4 max-h-[70vh] flex flex-col rounded-xl overflow-hidden"
            style={{ background: 'var(--surface-container)', boxShadow: 'var(--glass-shadow)' }}>
            <div className="flex items-center justify-between px-5 py-4 flex-shrink-0"
              style={{ borderBottom: '1px solid var(--ghost-border)' }}>
              <div className="flex items-center gap-2">
                <Sunrise size={15} strokeWidth={1.5} style={{ color: 'var(--status-amber)' }} />
                <h2 className="text-[14px] font-semibold" style={{ color: 'var(--on-surface)' }}>Daily Standup</h2>
                {d.standup && <span className="text-[10px] font-mono" style={{ color: 'var(--outline)' }}>{formatMessageTime(d.standup.date)}</span>}
              </div>
              <button onClick={() => setStandupOpen(false)} className="p-1 rounded-md" style={{ color: 'var(--outline)' }}><X size={15} strokeWidth={1.5} /></button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {d.standup ? (
                <div className="text-[12px] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderSimpleMarkdown(d.standup.summary)) }} />
              ) : standupGenerating ? (
                <div className="flex items-center justify-center py-12 gap-2" style={{ color: 'var(--outline)' }}>
                  <Loader2 size={15} className="animate-spin" /><span className="text-[12px]">Generating...</span>
                </div>
              ) : (
                <div className="text-center py-12">
                  <p className="text-[12px] mb-3" style={{ color: 'var(--outline)' }}>No standup generated yet today.</p>
                  <button onClick={handleGenerateStandup}
                    className="px-4 py-2 rounded-lg text-[12px] font-medium text-white"
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
