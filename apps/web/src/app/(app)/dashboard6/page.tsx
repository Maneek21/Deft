'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useTheme } from '@/components/theme-provider';
import { sanitizeHtml } from '@/lib/sanitize';
import { api } from '@/lib/api';
import { formatRelativeCompact, formatFullDateLong, formatMessageTime } from '@/lib/time';
import Link from 'next/link';
import {
  CheckCircle2, Circle, MessageSquare, Plus, Bot, Sunrise, Loader2, X,
  Users, ChevronLeft, ChevronRight, GitPullRequest, GitMerge, GitBranch,
  AlertCircle, Sparkles, RefreshCw, AlertTriangle, FilePlus, TrendingUp,
} from 'lucide-react';
import { CalTask, CalEvent, CalNote, DayBucket, toDateKey, buildMonthGrid, bucketByDay, CAL_DAYS_SHORT, ITEM_COLORS } from '@/lib/calendar';
import { statusLabel } from '@/lib/task-status-labels';

// ─── Design tokens (from Stitch) — dark + light ───────────────────────────────
const DARK_T = {
  bgBase:      '#09090b',
  bgSurface:   '#111113',
  bgCard:      '#0e0e10',
  border:      'rgba(255,255,255,0.08)',
  borderHover: 'rgba(255,255,255,0.16)',
  textMain:    '#e5e1e4',
  textMuted:   '#c9c4d5',
  textFaint:   'rgba(229,225,228,0.38)',
  accent:      '#9080fa',
  primary:     '#c8bfff',
  urgent:      '#ffb4ab',
  success:     '#22c55e',
  warning:     '#eab308',
  blue:        '#60a5fa',
};
const LIGHT_T = {
  bgBase:      '#f8f8fa',
  bgSurface:   '#ffffff',
  bgCard:      '#f1f1f4',
  border:      'rgba(0,0,0,0.07)',
  borderHover: 'rgba(0,0,0,0.14)',
  textMain:    '#18181b',
  textMuted:   '#52525b',
  textFaint:   'rgba(24,24,27,0.38)',
  accent:      '#6d28d9',
  primary:     '#7c3aed',
  urgent:      '#dc2626',
  success:     '#16a34a',
  warning:     '#b45309',
  blue:        '#1d4ed8',
};

// ─── Types ────────────────────────────────────────────────────────────────────
type DashboardTask = {
  id: string; title: string; status: string; priority: 'p0'|'p1'|'p2'|'p3';
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
  userId: string; name: string; status: 'green'|'yellow'|'red';
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
type DashboardData = {
  greeting: string; standup: StandupData;
  due_today: DashboardTask[]; due_this_week: DashboardTask[];
  overdue: DashboardTask[]; in_progress: DashboardTask[];
  my_work: DashboardTask[]; unread_spaces: UnreadSpace[];
  recent_activity: ActivityEntry[]; projects: DashboardProject[];
  calendar_events: any[]; github_activity: GitHubEvent[];
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function renderSimpleMarkdown(text: string): string {
  if (!text) return '';
  let html = text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3 style="font-size:12px;font-weight:600;margin:6px 0 2px">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:13px;font-weight:600;margin:8px 0 3px">$1</h2>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul style="list-style:disc;padding-left:16px;margin:3px 0">$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br/>');
  if (!html.startsWith('<')) html = '<p>' + html + '</p>';
  return html;
}

function formatActivity(a: ActivityEntry): string {
  const task = a.task_prefix && a.task_number ? `${a.task_prefix}-${a.task_number}` : '';
  const who = a.user_name?.split(' ')[0] || 'Someone';
  if (a.action === 'created') return `${who} created ${task}`;
  if (a.action === 'status_changed') return `${who} moved ${task} → ${statusLabel(a.new_value || '')}`;
  if (a.action === 'assigned') return `${who} assigned ${task}`;
  if (a.action === 'commented') return `${who} commented on ${task}`;
  return `${who} updated ${task}`;
}

function formatAgentAction(a: AgentActivity): string {
  const p = a.params as Record<string, any>;
  switch (a.action) {
    case 'create_task': return `Created "${p.title}"`;
    case 'update_task_status': return `Moved ${p.task_identifier} → ${(p.new_status||'').replace(/_/g,' ')}`;
    case 'assign_task': return `Assigned ${p.task_identifier} to ${p.assignee_name}`;
    case 'post_message': return `Posted in #${p.space_name}`;
    case 'wiki_write': return `Updated wiki: ${p.title||p.slug}`;
    default: return a.action.replace(/_/g,' ');
  }
}

function getLocalGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Dashboard6Page() {
  const { user } = useAuth();
  const { theme } = useTheme();
  const T = theme === 'dark' ? DARK_T : LIGHT_T;

  // ─── Design-token-aware helpers (close over T) ───────────────────────────
  const PRIORITY_COLOR: Record<string, string> = {
    p0: T.urgent, p1: T.warning, p2: T.blue, p3: T.textFaint,
  };

  // ─── Card wrapper ──────────────────────────────────────────────────────────
  function Card({ title, children, headerRight }: {
    title: string; children: React.ReactNode; headerRight?: React.ReactNode;
  }) {
    return (
      <div className="flex flex-col rounded-xl p-4" style={{ background: T.bgCard, border: `1px solid ${T.border}` }}>
        <div className="flex items-center justify-between mb-4">
          <span className="text-[12px] font-semibold uppercase tracking-wider"
            style={{ color: T.textMain, opacity: 0.6 }}>{title}</span>
          {headerRight}
        </div>
        <div className="flex-1 min-h-0">{children}</div>
      </div>
    );
  }

  // ─── Progress ring ─────────────────────────────────────────────────────────
  function ProgressRing({ percent, color, size = 36 }: { percent: number; color: string; size?: number }) {
    const r = (size - 6) / 2;
    const circ = 2 * Math.PI * r;
    return (
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={3} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={3}
          strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={circ - (percent/100)*circ} />
      </svg>
    );
  }

  // ─── Calendar widget ───────────────────────────────────────────────────────
  function CalendarWidget() {
    const today = toDateKey(new Date());
    const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const [calData, setCalData] = useState<{ tasks: CalTask[]; events: CalEvent[]; notes: CalNote[] }|null>(null);
    const [selectedDay, setSelectedDay] = useState<string|null>(null);
    const grid = buildMonthGrid(month);
    const dayBuckets = calData ? bucketByDay(calData) : new Map<string, DayBucket>();

    useEffect(() => {
      const from = new Date(grid[0]); from.setHours(0,0,0,0);
      const to = new Date(grid[grid.length-1]); to.setHours(23,59,59,999);
      api.get(`/api/calendar?from=${from.toISOString()}&to=${to.toISOString()}`).then(async r => {
        if (r.ok) setCalData(await r.json());
      });
    }, [grid[0].getTime()]);

    const selBucket = selectedDay ? dayBuckets.get(selectedDay) : null;

    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <button onClick={() => { const d = new Date(month); d.setMonth(d.getMonth()-1); setMonth(d); setSelectedDay(null); }}
            className="p-0.5" style={{ color: T.textMuted }}><ChevronLeft size={13} /></button>
          <span className="text-[11px] font-semibold" style={{ color: T.textMain }}>
            {month.toLocaleDateString('en-US', { month:'long', year:'numeric' })}
          </span>
          <button onClick={() => { const d = new Date(month); d.setMonth(d.getMonth()+1); setMonth(d); setSelectedDay(null); }}
            className="p-0.5" style={{ color: T.textMuted }}><ChevronRight size={13} /></button>
        </div>
        <div className="grid grid-cols-7 mb-1">
          {CAL_DAYS_SHORT.map((d,i) => (
            <div key={i} className="text-center text-[9px] font-semibold py-0.5" style={{ color: T.textMuted }}>{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-px">
          {grid.map((date, i) => {
            const key = toDateKey(date);
            const isToday = key === today;
            const isSelected = key === selectedDay;
            const bucket = dayBuckets.get(key);
            const hasItems = bucket && (bucket.tasks.length + bucket.events.length + bucket.notes.length) > 0;
            return (
              <button key={i} onClick={() => setSelectedDay(isSelected ? null : key)}
                className="relative flex flex-col items-center py-1.5 rounded transition-colors"
                style={{
                  background: isSelected ? `${T.accent}25` : isToday ? `${T.accent}18` : 'transparent',
                  opacity: date.getMonth() === month.getMonth() ? 1 : 0.3,
                }}>
                <span className="text-[10px] font-medium" style={{ color: isToday ? T.accent : T.textMain }}>
                  {date.getDate()}
                </span>
                {hasItems && <div className="mt-0.5 w-1 h-1 rounded-full" style={{ background: T.accent }} />}
              </button>
            );
          })}
        </div>
        {selectedDay && selBucket && (selBucket.tasks.length + selBucket.events.length + selBucket.notes.length) > 0 && (
          <div className="mt-2 pt-2 space-y-1" style={{ borderTop: `1px solid ${T.border}` }}>
            {selBucket.events.map(e => (
              <div key={e.id} className="flex items-center gap-2 text-[10px]">
                <div className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: ITEM_COLORS.event }} />
                <span className="truncate flex-1" style={{ color: T.textMain }}>{e.title}</span>
                <span style={{ color: T.textMuted }}>{new Date(e.timestamp).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</span>
              </div>
            ))}
            {selBucket.tasks.map(t => (
              <Link key={t.id} href={`/tasks?task=${t.project_prefix}-${t.number}`}
                className="flex items-center gap-2 text-[10px]">
                <Circle size={9} style={{ color: PRIORITY_COLOR[t.priority] || T.textMuted, flexShrink: 0 }} />
                <span className="truncate flex-1" style={{ color: T.textMain }}>{t.title}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  const [data, setData] = useState<DashboardData|null>(null);
  const [loading, setLoading] = useState(true);
  const [clientGreeting, setClientGreeting] = useState<string|null>(null);
  const [standupGenerating, setStandupGenerating] = useState(false);
  const [standupOpen, setStandupOpen] = useState(false);
  const [myInsights, setMyInsights] = useState<MyInsightsData|null>(null);
  const [agentActivity, setAgentActivity] = useState<AgentActivity[]>([]);
  const [teamHealth, setTeamHealth] = useState<TeamHealthData|null>(null);
  const [oneonePreps, setOneonePreps] = useState<OneOnePrepData[]>([]);
  const [prepModal, setPrepModal] = useState<OneOnePrepData|null>(null);

  const isManager = user?.role === 'owner' || user?.role === 'admin';

  useEffect(() => { setClientGreeting(getLocalGreeting()); }, []);

  useEffect(() => {
    api.get('/api/dashboard').then(async r => { if (r.ok) setData(await r.json()); setLoading(false); }).catch(() => setLoading(false));
    api.get('/api/dashboard/my-insights').then(async r => { if (r.ok) setMyInsights(await r.json()); }).catch(() => {});
    api.get('/api/dashboard/agent-activity').then(async r => { if (r.ok) setAgentActivity(await r.json()); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isManager) return;
    api.get('/api/manager/team-health').then(async r => {
      if (r.ok) { const d = await r.json(); if (d.snapshot?.team_data) setTeamHealth(d.snapshot.team_data); else if (d.healthCards) setTeamHealth(d); }
    }).catch(() => {});
    api.get('/api/manager/oneone-preps').then(async r => {
      if (r.ok) { const d = await r.json(); const p = d.preps||d; if (Array.isArray(p)) setOneonePreps(p.map((x:any)=>({ id:x.id, report_id:x.report_id, report_name:x.prep_content?.reportName||x.prep_content?.report_name||'Team member', prep_content:x.prep_content, created_at:x.created_at }))); }
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
    <div className="flex items-center justify-center h-full" style={{ background: T.bgBase }}>
      <Loader2 size={22} className="animate-spin" style={{ color: T.textFaint }} />
    </div>
  );

  const d = data || {
    greeting:'Good morning', standup:null, due_today:[], due_this_week:[],
    overdue:[], in_progress:[], my_work:[], unread_spaces:[], recent_activity:[],
    projects:[], calendar_events:[], github_activity:[],
  };

  const overdueTasks = d.overdue || [];
  const allUrgent = [...overdueTasks, ...d.due_today]
    .filter((t,i,arr) => arr.findIndex(x=>x.id===t.id)===i)
    .sort((a,b) => (['p0','p1','p2','p3'].indexOf(a.priority))-(['p0','p1','p2','p3'].indexOf(b.priority)));

  const kanban: Record<string, DashboardTask[]> = { todo:[], in_progress:[], in_review:[] };
  const seen = new Set<string>();
  (d.my_work||[]).forEach(t => { if (!seen.has(t.id)) { seen.add(t.id); if (kanban[t.status]) kanban[t.status].push(t); } });

  const doneThisWeek = [...(d.due_this_week||[]), ...(d.due_today||[])].filter(t=>t.status==='done').length;
  const unreadCount = (d.unread_spaces||[]).reduce((s,u)=>s+u.unread_count, 0);
  const pendingApprovals = agentActivity.filter(a=>a.approval_status==='pending');

  // GitHub helpers
  function ghIcon(e: GitHubEvent) {
    if (e.metadata.merged) return <GitMerge size={12} style={{ color:'#a78bfa', flexShrink:0 }} />;
    if (e.event_type?.includes('pr')) return <GitPullRequest size={12} style={{ color: e.metadata.state==='open' ? T.success : T.textFaint, flexShrink:0 }} />;
    if (e.event_type?.includes('issue')) return <AlertCircle size={12} style={{ color: e.metadata.state==='open' ? T.warning : T.textFaint, flexShrink:0 }} />;
    return <GitBranch size={12} style={{ color:T.textFaint, flexShrink:0 }} />;
  }

  const todayDate = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' }).toUpperCase();

  return (
    <div className="h-full overflow-y-auto" style={{ background: T.bgBase, color: T.textMain, fontFamily:"'Inter',sans-serif" }}>
      <main className="w-full max-w-[1400px] mx-auto px-4 md:px-8 py-8 flex flex-col gap-8">

        {/* ── Header ── */}
        <section className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-[22px] font-bold tracking-tight" style={{ color: T.textMain }}>
              {clientGreeting ?? d.greeting}, {user?.name?.split(' ')[0]}
            </h1>
            <p className="text-[11px] font-mono mt-0.5" style={{ color: T.textMuted, opacity:0.6 }}>{todayDate}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              { href:'/tasks', icon:FilePlus, label:'New Task' },
              { href:'/chat', icon:MessageSquare, label:'New Message' },
            ].map(a => (
              <Link key={a.label} href={a.href}
                className="px-3 py-1.5 rounded-lg flex items-center gap-2 text-[12px] font-medium"
                style={{ border:`1px solid ${T.border}`, color:T.textMain }}>
                <a.icon size={13} /> {a.label}
              </Link>
            ))}
            <button
              onClick={() => { if (!d.standup) handleGenerateStandup(); setStandupOpen(true); }}
              disabled={standupGenerating}
              className="px-3 py-1.5 rounded-lg flex items-center gap-2 text-[12px] font-semibold"
              style={{ background:`${T.warning}15`, color:T.warning, border:`1px solid ${T.warning}30` }}>
              {standupGenerating ? <Loader2 size={13} className="animate-spin" /> : <Sunrise size={13} />}
              {d.standup ? 'Review Standup' : 'Capture Standup'}
            </button>
            <Link href="/agent"
              className="px-3 py-1.5 rounded-lg flex items-center gap-2 text-[12px] font-semibold"
              style={{ background:`${T.accent}15`, color:T.accent, border:`1px solid ${T.accent}30` }}>
              <Bot size={13} /> Global Agent
            </Link>
          </div>
        </section>

        {/* ── Morning Pulse ── */}
        <section className="relative p-6 rounded-xl overflow-hidden"
          style={{ background: T.bgSurface, border: `1px solid ${T.borderHover}` }}>
          <button className="absolute top-4 right-4 p-1.5 rounded-md transition-colors hover:bg-white/5" style={{ color: T.textMuted }}>
            <RefreshCw size={15} />
          </button>
          <div className="flex items-center gap-2 mb-4">
            <Sparkles size={15} style={{ color: T.accent }} />
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em]" style={{ color: T.accent }}>Morning Pulse</span>
          </div>
          <div className="grid md:grid-cols-2 gap-8">
            <div className="space-y-3">
              <p className="text-[13px] leading-relaxed" style={{ color: T.textMuted }}>
                You have{' '}
                <span className="font-semibold" style={{ color: T.textMain }}>{unreadCount} unread messages</span>
                {' '}and{' '}
                <span className="font-semibold" style={{ color: overdueTasks.length > 0 ? T.urgent : T.textMain }}>{overdueTasks.length} overdue tasks</span>
                {overdueTasks.length === 0 ? '. You\'re on track.' : ' impacting velocity.'}
              </p>
              {allUrgent.length > 0 && (
                <ul className="space-y-1.5 mt-2">
                  {allUrgent.slice(0,3).map(t => (
                    <li key={t.id}>
                      <Link href={`/tasks?task=${t.project_prefix}-${t.number}`}
                        className="flex items-center gap-3 text-[12px]"
                        style={{ color:'rgba(255,255,255,0.8)' }}>
                        <span className="mt-0.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: PRIORITY_COLOR[t.priority] }} />
                        <span className="truncate flex-1">{t.title}</span>
                        <span className="font-mono text-[10px] shrink-0" style={{ color:T.textFaint }}>{t.project_prefix}-{t.number}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {pendingApprovals.length > 0 && (
              <div className="flex items-end justify-end">
                <Link href="/agent"
                  className="p-3 rounded-lg border flex items-start gap-3 hover:-translate-y-0.5 transition-transform"
                  style={{ background:`${T.urgent}10`, borderColor:`${T.urgent}30` }}>
                  <AlertTriangle size={15} style={{ color:T.urgent, marginTop:'2px' }} />
                  <div>
                    <p className="text-[12px] font-semibold" style={{ color:T.textMain }}>Agent Actions Pending</p>
                    <p className="text-[11px] mt-0.5" style={{ color:T.urgent }}>{pendingApprovals.length} critical approvals required.</p>
                  </div>
                </Link>
              </div>
            )}
          </div>
        </section>

        {/* ── Main 12-col grid ── */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6">

          {/* LEFT: span-7 */}
          <div className="col-span-1 md:col-span-7 flex flex-col gap-6">

            {/* Stats row — at top so numbers are immediately visible */}
            <div className="grid grid-cols-4 gap-3">
              {[
                { label:'Overdue',   value:overdueTasks.length,    color:T.urgent },
                { label:'Due Today', value:d.due_today.length,     color:T.warning },
                { label:'Active',    value:d.in_progress.length,   color:T.primary },
                { label:'Done',      value:doneThisWeek,            color:T.success },
              ].map(s => (
                <div key={s.label} className="p-3 rounded-lg border text-center flex flex-col justify-center"
                  style={{ background:`${s.color}0a`, borderColor:`${s.color}1a` }}>
                  <span className="text-[22px] font-bold font-mono" style={{ color:s.color }}>{s.value}</span>
                  <span className="text-[9px] uppercase font-semibold mt-1" style={{ color:s.color, opacity:0.7 }}>{s.label}</span>
                </div>
              ))}
            </div>

            {/* My Work kanban */}
            <Card title="My Work">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {(['todo','in_progress','in_review'] as const).map(status => (
                  <div key={status} className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 mb-1 pb-2" style={{ borderBottom:`1px solid ${T.border}` }}>
                      <div className="w-1.5 h-1.5 rounded-full" style={{
                        background: status==='in_progress' ? T.warning : status==='in_review' ? T.primary : T.textMuted
                      }} />
                      <span className="text-[10px] font-bold uppercase" style={{ color:T.textMuted }}>{status.replace('_',' ')}</span>
                      <span className="text-[9px] font-mono ml-auto" style={{ color:T.textFaint }}>{kanban[status].length}</span>
                    </div>
                    {kanban[status].slice(0,3).map(t => (
                      <Link key={t.id} href={`/tasks?task=${t.project_prefix}-${t.number}`}
                        className="p-2 rounded-lg border transition-colors"
                        style={{ background:T.bgBase, borderColor:'transparent' }}
                        onMouseEnter={e=>(e.currentTarget.style.borderColor=T.borderHover)}
                        onMouseLeave={e=>(e.currentTarget.style.borderColor='transparent')}>
                        <div className="flex items-center gap-1.5 mb-1">
                          <div className="w-1 h-1 rounded-full flex-shrink-0" style={{ background:PRIORITY_COLOR[t.priority] }} />
                          <span className="text-[10px] font-mono" style={{ color:T.textFaint }}>{t.project_prefix}-{t.number}</span>
                        </div>
                        <div className="text-[12px] truncate" style={{ color:T.textMain }}>{t.title}</div>
                      </Link>
                    ))}
                    {kanban[status].length === 0 && (
                      <span className="text-[10px] italic py-3 text-center" style={{ color:T.textFaint }}>Empty</span>
                    )}
                    {kanban[status].length > 3 && (
                      <span className="text-[10px] text-center" style={{ color:T.textFaint }}>+{kanban[status].length-3} more</span>
                    )}
                  </div>
                ))}
              </div>
            </Card>

            {/* Due Today + Due This Week */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <Card title="Due Today" headerRight={
                overdueTasks.length > 0 ? (
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-sm"
                    style={{ background:`${T.urgent}20`, color:T.urgent }}>{overdueTasks.length} OVERDUE</span>
                ) : null
              }>
                {allUrgent.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-6 gap-2">
                    <CheckCircle2 size={18} style={{ color:T.success, opacity:0.4 }} />
                    <p className="text-[11px]" style={{ color:T.textFaint }}>Nothing due today</p>
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {allUrgent.slice(0,6).map(t => {
                      const isOvr = overdueTasks.some(o=>o.id===t.id);
                      return (
                        <Link key={t.id} href={`/tasks?task=${t.project_prefix}-${t.number}`}
                          className="flex items-center gap-3 px-2 py-2 rounded-lg transition-colors hover:bg-white/5">
                          <Circle size={11} style={{ color: isOvr ? T.urgent : T.textFaint, flexShrink:0 }} />
                          <span className="text-[10px] font-mono shrink-0" style={{ color:T.textFaint }}>{t.project_prefix}-{t.number}</span>
                          <span className="text-[12px] truncate flex-1" style={{ color:T.textMain }}>{t.title}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </Card>

              <Card title="Due This Week">
                {(d.due_this_week||[]).filter(t=>t.status!=='done').length === 0 ? (
                  <p className="text-[11px] py-2" style={{ color:T.textFaint }}>
                    {(d.due_this_week||[]).length > 0 ? 'All done for the week 🎉' : 'Nothing upcoming this week'}
                  </p>
                ) : (
                  <div className="space-y-0.5">
                    {(d.due_this_week||[]).filter(t=>t.status!=='done').slice(0,6).map(t => {
                      const day = t.due_date ? new Date(t.due_date).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}) : '';
                      return (
                        <Link key={t.id} href={`/tasks?task=${t.project_prefix}-${t.number}`}
                          className="flex items-center gap-3 px-2 py-2 rounded-lg transition-colors hover:bg-white/5">
                          <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background:PRIORITY_COLOR[t.priority] }} />
                          <span className="text-[10px] font-mono shrink-0" style={{ color:T.textFaint }}>{t.project_prefix}-{t.number}</span>
                          <span className="text-[12px] truncate flex-1" style={{ color:T.textMain }}>{t.title}</span>
                          <span className="text-[9px] font-mono shrink-0" style={{ color:T.textFaint }}>{day}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </Card>
            </div>

            {/* Agent Activity — card in left column, keeps columns balanced */}
            <Card title="Agent Activity" headerRight={
              pendingApprovals.length > 0 ? (
                <Link href="/agent" className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
                  style={{ background:`${T.urgent}15`, color:T.urgent, border:`1px solid ${T.urgent}25` }}>
                  {pendingApprovals.length} pending
                </Link>
              ) : null
            }>
              {agentActivity.length === 0 ? (
                <p className="text-[11px] py-2" style={{ color:T.textFaint }}>No recent agent activity</p>
              ) : (
                <div className="relative pl-5 space-y-4">
                  <div className="absolute left-[9px] top-1 bottom-1 w-px" style={{ background:'rgba(255,255,255,0.07)' }} />
                  {agentActivity.slice(0,6).map((a, i) => {
                    const dotBg = a.approval_status==='pending' ? T.warning : a.error ? T.urgent : T.success;
                    return (
                      <div key={a.id} className="relative flex items-start gap-3">
                        <div className="absolute -left-[17px] w-2 h-2 rounded-full"
                          style={{ top:'3px', background: i===0 ? T.accent : dotBg, boxShadow:`0 0 0 3px ${T.bgCard}` }} />
                        <div className="flex-1 flex items-start justify-between gap-3 min-w-0">
                          <div className="min-w-0">
                            <span className="text-[12px] block truncate" style={{ color:T.textMain }}>{formatAgentAction(a)}</span>
                            {a.approval_status==='pending' && (
                              <Link href="/agent" className="text-[9px] font-semibold mt-0.5 inline-block"
                                style={{ color:T.urgent }}>→ Review</Link>
                            )}
                          </div>
                          <span className="text-[9px] font-mono shrink-0 mt-0.5" style={{ color:T.textFaint }}>
                            {formatRelativeCompact(a.executed_at||a.created_at)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* Recent Activity — fills bottom of left column */}
            {(d.recent_activity||[]).length > 0 && (
              <Card title="Recent Activity">
                <div className="space-y-3">
                  {(d.recent_activity||[]).slice(0,7).map(a => (
                    <div key={a.id} className="flex items-start gap-3">
                      <div className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" style={{ background:T.borderHover }} />
                      <span className="text-[12px] flex-1 leading-snug" style={{ color:T.textMuted }}>{formatActivity(a)}</span>
                      <span className="text-[9px] font-mono shrink-0" style={{ color:T.textFaint }}>
                        {formatRelativeCompact(a.created_at)}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            )}

          </div>

          {/* RIGHT: span-5 */}
          <div className="col-span-1 md:col-span-5 flex flex-col gap-6">

            {/* Unread */}
            <Card title="Unread Signals" headerRight={
              unreadCount > 0 ? (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full"
                  style={{ background:`${T.accent}20`, color:T.accent }}>{unreadCount}</span>
              ) : null
            }>
              {(d.unread_spaces||[]).length === 0 ? (
                <p className="text-[11px] text-center py-4" style={{ color:T.textFaint }}>All caught up!</p>
              ) : (
                <div className="space-y-2">
                  {(d.unread_spaces||[]).map(s => (
                    <Link key={s.space_id} href="/chat"
                      className="flex items-start gap-3 p-3 rounded-xl border transition-colors"
                      style={{ background:T.bgBase, borderColor:T.border }}
                      onMouseEnter={e=>(e.currentTarget.style.borderColor=T.borderHover)}
                      onMouseLeave={e=>(e.currentTarget.style.borderColor=T.border)}>
                      <div className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ background:T.primary }} />
                      <div className="flex-1 min-w-0">
                        <span className="text-[12px] font-bold block truncate" style={{ color:T.textMain }}>
                          {s.space_type==='dm' ? s.space_name : `#${s.space_name}`}
                        </span>
                        {s.last_message && (
                          <span className="text-[10px] truncate block mt-0.5" style={{ color:T.textMuted, opacity:0.6 }}>
                            {s.last_message}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0"
                        style={{ background:`${T.accent}20`, color:T.accent }}>{s.unread_count}</span>
                    </Link>
                  ))}
                </div>
              )}
            </Card>

            {/* Calendar */}
            <Card title="Calendar">
              <CalendarWidget />
            </Card>

            {/* Top Collaborators */}
            {myInsights && myInsights.top_collaborators.length > 0 && (
              <Card title="Top Collaborators" headerRight={<TrendingUp size={12} style={{ color:T.textFaint }} />}>
                <div className="space-y-3">
                  {myInsights.top_collaborators.slice(0,5).map((c,i) => {
                    const maxScore = myInsights.top_collaborators[0]?.score || 1;
                    return (
                      <div key={c.name} className="flex items-center gap-3">
                        <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
                          style={{ background:`hsl(${(i*47+250)%360},55%,50%)` }}>
                          {c.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[12px] font-medium truncate" style={{ color:T.textMain }}>{c.name}</span>
                            <span className="text-[9px] font-mono flex-shrink-0" style={{ color:T.textFaint }}>{c.interactions}x</span>
                          </div>
                          <div className="h-1 rounded-full overflow-hidden" style={{ background:'rgba(255,255,255,0.05)' }}>
                            <div className="h-full rounded-full" style={{ width:`${Math.round((c.score/maxScore)*100)}%`, background:T.accent }} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {/* Signal Velocity */}
            {myInsights && myInsights.pace.length > 0 && (
              <Card title="Signal Velocity">
                <div className="flex items-end gap-1 h-12 mt-1">
                  {myInsights.pace.map((w,i) => {
                    const max = Math.max(...myInsights.pace.map(p=>p.completed), 1);
                    return (
                      <div key={i} className="flex-1 rounded-t-sm hover:brightness-125 transition-all"
                        style={{ height:`${Math.max((w.completed/max)*100,8)}%`, background: i===myInsights.pace.length-1 ? T.accent : `${T.accent}50` }}
                        title={`${w.completed} tasks`} />
                    );
                  })}
                </div>
                <div className="flex justify-between mt-2 text-[9px] font-mono" style={{ color:T.textFaint }}>
                  <span>{myInsights.pace.length}w ago</span><span>this week</span>
                </div>
              </Card>
            )}

            {/* My Insights */}
            {myInsights && (
              <Card title="My Insights">
                <div className="flex gap-4 mb-4">
                  {[
                    { value:myInsights.activity.tasks_completed, label:'tasks done' },
                    { value:myInsights.activity.messages_sent,   label:'messages' },
                    { value:myInsights.activity.spaces_active.length, label:'spaces' },
                  ].map(s => (
                    <div key={s.label} className="flex-1 text-center">
                      <span className="text-[20px] font-bold font-mono block leading-none" style={{ color:T.textMain }}>{s.value}</span>
                      <span className="text-[9px] block mt-1" style={{ color:T.textFaint }}>{s.label}</span>
                    </div>
                  ))}
                </div>
                {myInsights.expertise.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {myInsights.expertise.slice(0,6).map(e => (
                      <span key={e.topic} className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                        style={{ background:`${T.accent}15`, color:T.accent, border:`1px solid ${T.accent}25` }}>
                        {e.topic}
                      </span>
                    ))}
                  </div>
                )}
              </Card>
            )}

            {/* Team Health (manager only) */}
            {isManager && teamHealth && teamHealth.healthCards.length > 0 && (
              <Card title="Team Operations" headerRight={
                <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
                  style={{ background:'rgba(255,255,255,0.08)', color:T.textMain }}>Manager</span>
              }>
                <div className="space-y-2.5">
                  {teamHealth.healthCards.map(c => {
                    const dot = c.status==='green' ? T.success : c.status==='yellow' ? T.warning : T.urgent;
                    return (
                      <div key={c.userId} className="flex items-center gap-3">
                        <div className="w-1.5 h-1.5 rounded-full" style={{ background:dot }} />
                        <span className="text-[12px] font-medium flex-1 truncate" style={{ color:T.textMain }}>{c.name}</span>
                        {c.overdueTasks > 0 && <span className="text-[9px] font-mono" style={{ color:T.urgent }}>{c.overdueTasks} overdue</span>}
                        <span className="text-[9px] font-mono" style={{ color:T.textFaint }}>{c.activeTasks} active</span>
                      </div>
                    );
                  })}
                  {oneonePreps.length > 0 && (
                    <div className="pt-2 mt-1 space-y-1.5" style={{ borderTop:`1px solid ${T.border}` }}>
                      {oneonePreps.map(prep => (
                        <button key={prep.id} onClick={()=>setPrepModal(prep)}
                          className="flex items-center gap-1.5 text-[11px] font-medium w-full"
                          style={{ color:T.accent }}>
                          <Users size={11} /> 1:1 with {prep.report_name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </Card>
            )}

          </div>

          {/* Projects — full-width row inside the grid */}
          {(d.projects||[]).length > 0 && (
            <div className="col-span-1 md:col-span-12">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-[12px] font-semibold uppercase tracking-wider" style={{ color:T.textMain, opacity:0.6 }}>Projects</h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {(d.projects||[]).map((p,i) => {
                  const pct = p.total_tasks > 0 ? Math.round((p.done_tasks/p.total_tasks)*100) : 0;
                  const colors = [T.accent, T.primary, T.warning, T.blue];
                  const c = p.color || colors[i%colors.length];
                  return (
                    <Link key={p.id} href={`/tasks?project=${p.id}`}
                      className="p-4 rounded-xl border flex items-center gap-4 transition-colors"
                      style={{ background:T.bgCard, borderColor:T.border }}
                      onMouseEnter={e=>(e.currentTarget.style.borderColor=T.borderHover)}
                      onMouseLeave={e=>(e.currentTarget.style.borderColor=T.border)}>
                      <ProgressRing percent={pct} color={c} size={38} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-bold truncate mb-0.5" style={{ color:T.textMain }}>{p.name}</div>
                        <div className="text-[10px]" style={{ color:T.textFaint }}>
                          {p.done_tasks}/{p.total_tasks} done
                          {p.my_tasks > 0 && <span className="ml-1.5 font-semibold" style={{ color:T.accent }}>· {p.my_tasks} mine</span>}
                        </div>
                      </div>
                      <span className="text-[13px] font-bold font-mono flex-shrink-0" style={{ color:c }}>{pct}%</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}

        </div>

        {/* ── GitHub (full-width, only when connected) ── */}
        {d.github_activity.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[12px] font-semibold uppercase tracking-wider" style={{ color:T.textMain, opacity:0.6 }}>GitHub</h3>
              <span className="text-[10px] font-mono" style={{ color:T.textFaint }}>{d.github_activity.length} events</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {d.github_activity.slice(0,6).map(e => {
                const isMerged = e.metadata.merged;
                const badgeColor = isMerged ? '#a78bfa' : e.metadata.state==='open' ? T.success : T.textFaint;
                const badgeBg = isMerged ? 'rgba(167,139,250,0.12)' : e.metadata.state==='open' ? `${T.success}12` : 'rgba(255,255,255,0.05)';
                const badgeLabel = isMerged ? 'merged' : e.metadata.state || '';
                return (
                  <div key={e.id} className="flex items-start gap-3 p-3 rounded-xl border"
                    style={{ background:T.bgCard, borderColor:T.border }}>
                    {ghIcon(e)}
                    <div className="flex-1 min-w-0">
                      {e.url ? (
                        <a href={e.url} target="_blank" rel="noopener noreferrer"
                          className="text-[12px] truncate block hover:underline font-medium" style={{ color:T.textMain }}>{e.title}</a>
                      ) : (
                        <span className="text-[12px] truncate block font-medium" style={{ color:T.textMain }}>{e.title}</span>
                      )}
                      <div className="flex items-center gap-1.5 mt-1">
                        {e.metadata.repo && <span className="text-[9px] font-mono" style={{ color:T.textFaint }}>{e.metadata.repo}</span>}
                        {badgeLabel && <span className="text-[9px] font-semibold px-1 py-px rounded" style={{ background:badgeBg, color:badgeColor }}>{badgeLabel}</span>}
                        <span className="text-[9px] font-mono ml-auto" style={{ color:T.textFaint }}>{formatRelativeCompact(e.timestamp)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

      </main>

      {/* ── 1:1 Prep Modal ── */}
      {prepModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background:'rgba(0,0,0,0.6)' }}>
          <div className="w-[calc(100vw-2rem)] max-w-lg rounded-xl p-5 max-h-[90vh] overflow-y-auto"
            style={{ background:T.bgSurface, border:`1px solid ${T.borderHover}`, boxShadow:'0 24px 60px rgba(0,0,0,0.5)' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[14px] font-bold" style={{ color:T.textMain }}>1:1 Prep — {prepModal.report_name}</h3>
              <button onClick={()=>setPrepModal(null)} className="p-1 rounded" style={{ color:T.textMuted }}><X size={16} /></button>
            </div>
            {prepModal.prep_content && (
              <div className="space-y-3 text-[12px]" style={{ color:T.textMuted }}>
                {(['summary','wins','currentFocus','concerns','talkingPoints','commitments'] as const).map(key => {
                  const val = (prepModal.prep_content as any)[key];
                  if (!val) return null;
                  const label = key==='currentFocus'?'Current Focus':key==='talkingPoints'?'Talking Points':key.charAt(0).toUpperCase()+key.slice(1);
                  if (typeof val==='string') return <div key={key}><p className="font-semibold mb-1" style={{ color:T.textMain }}>{label}</p><p>{val}</p></div>;
                  if (Array.isArray(val)&&val.length>0) return <div key={key}><p className="font-semibold mb-1" style={{ color:key==='concerns'?T.urgent:T.textMain }}>{label}</p><ul className="list-disc pl-4 space-y-0.5">{val.map((v:string,i:number)=><li key={i}>{v}</li>)}</ul></div>;
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
          style={{ background:'rgba(0,0,0,0.6)', backdropFilter:'blur(6px)' }}
          onClick={e=>{ if(e.target===e.currentTarget) setStandupOpen(false); }}>
          <div className="w-full max-w-[520px] mx-4 max-h-[70vh] flex flex-col rounded-xl overflow-hidden"
            style={{ background:T.bgSurface, border:`1px solid ${T.borderHover}`, boxShadow:'0 24px 60px rgba(0,0,0,0.5)' }}>
            <div className="flex items-center justify-between px-5 py-4 flex-shrink-0"
              style={{ borderBottom:`1px solid ${T.border}` }}>
              <div className="flex items-center gap-2">
                <Sunrise size={15} strokeWidth={1.5} style={{ color:T.warning }} />
                <h2 className="text-[14px] font-bold" style={{ color:T.textMain }}>Daily Standup</h2>
                {d.standup && <span className="text-[10px] font-mono" style={{ color:T.textFaint }}>{formatMessageTime(d.standup.date)}</span>}
              </div>
              <button onClick={()=>setStandupOpen(false)} className="p-1 rounded" style={{ color:T.textMuted }}><X size={15} /></button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {d.standup ? (
                <div className="text-[13px] leading-relaxed" style={{ color:T.textMuted }}
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderSimpleMarkdown(d.standup.summary)) }} />
              ) : standupGenerating ? (
                <div className="flex items-center justify-center py-12 gap-2" style={{ color:T.textFaint }}>
                  <Loader2 size={16} className="animate-spin" /><span className="text-[13px]">Generating standup...</span>
                </div>
              ) : (
                <div className="text-center py-12">
                  <p className="text-[13px] mb-3" style={{ color:T.textFaint }}>No standup generated yet today.</p>
                  <button onClick={handleGenerateStandup}
                    className="px-4 py-2 rounded-lg text-[12px] font-semibold"
                    style={{ background:`${T.accent}20`, color:T.accent, border:`1px solid ${T.accent}30` }}>
                    Generate Now
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
