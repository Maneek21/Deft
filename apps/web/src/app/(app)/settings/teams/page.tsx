'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Bot,
  Briefcase,
  CalendarDays,
  CheckCircle2,
  CircleDot,
  Clock,
  FileText,
  Layers3,
  Link2,
  Lock,
  MessageSquare,
  Plus,
  Search,
  Shield,
  Sparkles,
  Trash2,
  UserPlus,
  UserRound,
  Users,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

type Team = {
  id: string;
  name: string;
  handle: string;
  description: string | null;
  type: string;
  visibility: 'private' | 'org';
  avatar_url: string | null;
  color: string | null;
  lead_user_id: string | null;
  default_space_id: string | null;
  is_archived: boolean;
  member_count: number;
  resource_count: number;
  current_user_role: string | null;
};

type Member = {
  id: string;
  user_id: string;
  role: 'lead' | 'member' | 'viewer';
  name: string;
  email: string | null;
  avatar_url: string | null;
  kind: 'human' | 'agent' | 'system';
  title: string | null;
};

type SimpleMember = {
  id: string;
  name: string;
  email: string | null;
  avatar_url: string | null;
  kind?: 'human' | 'agent' | 'system';
};

type TeamResource = {
  id: string;
  resource_type: string;
  resource_id: string;
  label: string | null;
  created_at: string;
};

type ResourceOption = {
  id: string;
  label: string;
  hint?: string | null;
};

type TeamSummary = {
  member_count: number;
  agent_count: number;
  resources_by_type: Record<string, number>;
  latest_snapshot: { snapshot_type: string; generated_at: string } | null;
};

type TeamDetail = {
  team: Team;
  lead: { id: string; name: string; email: string | null; avatar_url: string | null } | null;
  members: Member[];
  resources: TeamResource[];
  summary: TeamSummary;
};

type TeamDashboard = {
  generated_at: string;
  summary: TeamSummary;
  attention: {
    overdue_tasks: number;
    due_soon_tasks: number;
    in_review_tasks: number;
    pending_agent_actions: number;
    top_tasks: Array<{
      id: string;
      title: string;
      status: string;
      priority: string;
      due_date: string | null;
      number: number;
      project_name: string;
      project_prefix: string;
      assignee_name: string | null;
    }>;
  };
  workload: {
    open_tasks: number;
    by_status: Record<string, number>;
    by_owner: Array<{ user_id: string | null; name: string; count: number }>;
  };
  context: {
    linked_projects: number;
    linked_spaces: number;
    linked_wiki_pages: number;
    linked_notes: number;
    linked_calendar_feeds: number;
    linked_agents: number;
    human_members: number;
    agent_members: number;
    latest_snapshot: { snapshot_type: string; generated_at: string } | null;
  };
};

const RESOURCE_LABELS: Record<string, string> = {
  space: 'Spaces',
  project: 'Projects',
  wiki_page: 'Wiki',
  note: 'Notes',
  calendar_feed: 'Calendar',
  task_template: 'Templates',
  agent_employee: 'Agents',
};

const RESOURCE_SINGULAR_LABELS: Record<string, string> = {
  space: 'Space',
  project: 'Project',
  wiki_page: 'Wiki',
  note: 'Note',
  calendar_feed: 'Calendar',
  task_template: 'Template',
  agent_employee: 'Agent',
};

const LINKABLE_RESOURCE_TYPES = ['project', 'space', 'wiki_page', 'agent_employee'] as const;
const TEAM_ROLES = ['lead', 'member', 'viewer'] as const;

const STATUS_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '?';
}

function resourceLabel(type: string) {
  return RESOURCE_LABELS[type] ?? type.replace(/_/g, ' ');
}

function resourceSingularLabel(type: string) {
  return RESOURCE_SINGULAR_LABELS[type] ?? resourceLabel(type);
}

function relativeTime(iso: string | null | undefined) {
  if (!iso) return 'No recent snapshot';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function Avatar({ name, avatarUrl, kind, size = 'md' }: { name: string; avatarUrl?: string | null; kind?: string; size?: 'sm' | 'md' | 'lg' }) {
  const classes = size === 'lg' ? 'h-14 w-14 text-[17px]' : size === 'sm' ? 'h-8 w-8 text-[11px]' : 'h-10 w-10 text-[13px]';
  return (
    <div
      className={`${classes} shrink-0 overflow-hidden rounded-full flex items-center justify-center font-semibold text-white`}
      style={{ background: kind === 'agent' ? 'var(--accent)' : 'var(--avatar-bg)' }}
    >
      {avatarUrl ? <img src={avatarUrl} alt="" className="h-full w-full object-cover" /> : kind === 'agent' ? <Bot size={size === 'lg' ? 24 : 15} /> : initials(name)}
    </div>
  );
}

function Pill({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'accent' | 'warning' | 'success' }) {
  const styles = {
    neutral: { color: 'var(--foreground-secondary)', background: 'var(--surface)' },
    accent: { color: 'var(--accent)', background: 'var(--accent-light, rgba(124,107,79,0.12))' },
    warning: { color: 'var(--warning)', background: 'rgba(234,179,8,0.12)' },
    success: { color: 'var(--success)', background: 'rgba(34,197,94,0.12)' },
  }[tone];
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium" style={styles}>
      {children}
    </span>
  );
}

function MetricCard({ icon: Icon, label, value, tone = 'neutral' }: { icon: any; label: string; value: number | string; tone?: 'neutral' | 'warning' | 'success' | 'accent' }) {
  const colors = {
    neutral: 'var(--foreground)',
    warning: 'var(--warning)',
    success: 'var(--success)',
    accent: 'var(--accent)',
  };
  return (
    <div className="min-h-[74px] rounded-lg p-3" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
        <Icon size={12} />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 text-[24px] font-semibold leading-none" style={{ color: colors[tone] }}>
        {value}
      </div>
    </div>
  );
}

function SectionTitle({ icon: Icon, title, eyebrow }: { icon: any; title: string; eyebrow?: string }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{eyebrow}</p>}
        <h3 className="mt-0.5 flex items-center gap-2 truncate text-[15px] font-semibold" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>
          <Icon size={15} />
          {title}
        </h3>
      </div>
    </div>
  );
}

export default function TeamsSettingsPage() {
  const { user } = useAuth();
  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<SimpleMember[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [dashboard, setDashboard] = useState<TeamDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState('');
  const [workingKey, setWorkingKey] = useState<string | null>(null);
  const [resourceOptions, setResourceOptions] = useState<Record<string, ResourceOption[]>>({});
  const [memberForm, setMemberForm] = useState<{ user_id: string; role: (typeof TEAM_ROLES)[number] }>({ user_id: '', role: 'member' });
  const [resourceForm, setResourceForm] = useState<{ resource_type: (typeof LINKABLE_RESOURCE_TYPES)[number]; resource_id: string; label: string }>({
    resource_type: 'project',
    resource_id: '',
    label: '',
  });
  const [form, setForm] = useState({
    name: '',
    handle: '',
    description: '',
    visibility: 'org' as 'org' | 'private',
    lead_user_id: '',
  });

  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const canManageSelectedTeam = Boolean(
    detail && (
      isAdmin ||
      detail.team.lead_user_id === user?.id ||
      detail.members.some((member) => member.user_id === user?.id && member.role === 'lead')
    ),
  );

  async function loadTeams(preferredId?: string | null) {
    setLoading(true);
    const res = await api.get(`/api/teams${showArchived ? '?include_archived=true' : ''}`);
    if (res.ok) {
      const rows = await res.json() as Team[];
      setTeams(rows);
      const nextId = preferredId && rows.some((team) => team.id === preferredId)
        ? preferredId
        : rows[0]?.id ?? null;
      setSelectedId(nextId);
    }
    setLoading(false);
  }

  async function loadMembers() {
    const res = await api.get('/api/members');
    if (res.ok) {
      const rows = await res.json() as SimpleMember[];
      setMembers(rows);
    }
  }

  async function loadResourceOptions() {
    const [projectsRes, spacesRes, wikiRes, agentsRes] = await Promise.all([
      api.get('/api/projects'),
      api.get('/api/spaces'),
      api.get('/api/wiki?limit=100'),
      api.get('/api/agent-employees'),
    ]);

    const projectsData = projectsRes.ok ? await projectsRes.json().catch(() => []) : [];
    const spacesData = spacesRes.ok ? await spacesRes.json().catch(() => []) : [];
    const wikiData = wikiRes.ok ? await wikiRes.json().catch(() => []) : [];
    const agentsData = agentsRes.ok ? await agentsRes.json().catch(() => []) : [];

    const projectRows = Array.isArray(projectsData) ? projectsData : projectsData.projects ?? [];
    const spaceRows = Array.isArray(spacesData) ? spacesData : spacesData.spaces ?? [];
    const wikiRows = Array.isArray(wikiData) ? wikiData : wikiData.pages ?? wikiData.items ?? [];
    const agentRows = Array.isArray(agentsData) ? agentsData : agentsData.agents ?? agentsData.employees ?? [];

    setResourceOptions({
      project: projectRows.map((row: any) => ({ id: row.id, label: row.name, hint: row.prefix })).filter((row: ResourceOption) => row.id && row.label),
      space: spaceRows.map((row: any) => ({ id: row.id, label: row.name, hint: row.type })).filter((row: ResourceOption) => row.id && row.label),
      wiki_page: wikiRows.map((row: any) => ({ id: row.id, label: row.title || row.name || row.slug, hint: row.kind || row.slug })).filter((row: ResourceOption) => row.id && row.label),
      agent_employee: agentRows.map((row: any) => ({ id: row.id, label: row.name || row.slug, hint: row.runtime_kind || row.role })).filter((row: ResourceOption) => row.id && row.label),
    });
  }

  async function loadTeamDetail(teamId: string | null) {
    if (!teamId) {
      setDetail(null);
      setDashboard(null);
      return;
    }
    setDetailLoading(true);
    const [detailRes, dashboardRes] = await Promise.all([
      api.get(`/api/teams/${teamId}`),
      api.get(`/api/teams/${teamId}/dashboard`),
    ]);
    setDetail(detailRes.ok ? await detailRes.json() : null);
    setDashboard(dashboardRes.ok ? await dashboardRes.json() : null);
    setDetailLoading(false);
  }

  useEffect(() => {
    loadTeams();
    loadMembers();
    loadResourceOptions();
  }, []);

  useEffect(() => {
    loadTeams(selectedId);
  }, [showArchived]);

  useEffect(() => {
    loadTeamDetail(selectedId);
  }, [selectedId]);

  const filteredTeams = useMemo(() => {
    const q = query.trim().toLowerCase();
    return teams.filter((team) => {
      if (!showArchived && team.is_archived) return false;
      if (!q) return true;
      return [team.name, team.handle, team.description ?? '', team.type].some((value) => value.toLowerCase().includes(q));
    });
  }, [teams, query, showArchived]);

  const summary = useMemo(() => ({
    teams: teams.filter((team) => !team.is_archived).length,
    members: teams.reduce((sum, team) => sum + Number(team.member_count || 0), 0),
    resources: teams.reduce((sum, team) => sum + Number(team.resource_count || 0), 0),
    private: teams.filter((team) => team.visibility === 'private' && !team.is_archived).length,
  }), [teams]);

  const availableMembers = useMemo(() => {
    const existing = new Set(detail?.members.map((member) => member.user_id) ?? []);
    return members.filter((member) => !existing.has(member.id));
  }, [members, detail]);

  const availableResources = useMemo(() => {
    const existing = new Set(detail?.resources.map((resource) => `${resource.resource_type}:${resource.resource_id}`) ?? []);
    return (resourceOptions[resourceForm.resource_type] ?? []).filter((option) => !existing.has(`${resourceForm.resource_type}:${option.id}`));
  }, [detail, resourceOptions, resourceForm.resource_type]);

  useEffect(() => {
    if (memberForm.user_id && availableMembers.some((member) => member.id === memberForm.user_id)) return;
    setMemberForm((prev) => ({ ...prev, user_id: availableMembers[0]?.id ?? '' }));
  }, [availableMembers, memberForm.user_id]);

  useEffect(() => {
    if (resourceForm.resource_id && availableResources.some((resource) => resource.id === resourceForm.resource_id)) return;
    setResourceForm((prev) => ({ ...prev, resource_id: availableResources[0]?.id ?? '' }));
  }, [availableResources, resourceForm.resource_id]);

  async function refreshSelectedTeam() {
    if (!selectedId) return;
    await Promise.all([loadTeamDetail(selectedId), loadTeams(selectedId)]);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError('');
    setCreating(true);
    try {
      const payload = {
        name: form.name.trim(),
        handle: form.handle.trim() || undefined,
        description: form.description.trim() || null,
        visibility: form.visibility,
        lead_user_id: form.lead_user_id || null,
      };
      const res = await api.post('/api/teams', payload);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to create team');
      setShowCreate(false);
      setForm({ name: '', handle: '', description: '', visibility: 'org', lead_user_id: '' });
      await loadTeams(data.id);
    } catch (err: any) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleAddMember(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || !memberForm.user_id) return;
    setActionError('');
    setWorkingKey('add-member');
    try {
      const res = await api.post(`/api/teams/${selectedId}/members`, memberForm);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to add team member');
      setMemberForm({ user_id: '', role: 'member' });
      await refreshSelectedTeam();
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setWorkingKey(null);
    }
  }

  async function handleMemberRole(userId: string, role: (typeof TEAM_ROLES)[number]) {
    if (!selectedId) return;
    setActionError('');
    setWorkingKey(`role-${userId}`);
    try {
      const res = await api.patch(`/api/teams/${selectedId}/members/${userId}`, { role });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to update team role');
      await refreshSelectedTeam();
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setWorkingKey(null);
    }
  }

  async function handleRemoveMember(userId: string) {
    if (!selectedId) return;
    setActionError('');
    setWorkingKey(`remove-member-${userId}`);
    try {
      const res = await api.delete(`/api/teams/${selectedId}/members/${userId}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to remove team member');
      await refreshSelectedTeam();
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setWorkingKey(null);
    }
  }

  async function handleLinkResource(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || !resourceForm.resource_id) return;
    setActionError('');
    setWorkingKey('link-resource');
    try {
      const selectedOption = (resourceOptions[resourceForm.resource_type] ?? []).find((option) => option.id === resourceForm.resource_id);
      const res = await api.post(`/api/teams/${selectedId}/resources`, {
        resource_type: resourceForm.resource_type,
        resource_id: resourceForm.resource_id,
        label: resourceForm.label.trim() || selectedOption?.label || null,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to link resource');
      setResourceForm((prev) => ({ ...prev, resource_id: '', label: '' }));
      await refreshSelectedTeam();
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setWorkingKey(null);
    }
  }

  async function handleDetachResource(resource: TeamResource) {
    if (!selectedId) return;
    setActionError('');
    setWorkingKey(`detach-${resource.id}`);
    try {
      const res = await api.delete(`/api/teams/${selectedId}/resources/${resource.resource_type}/${resource.resource_id}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to detach resource');
      await refreshSelectedTeam();
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setWorkingKey(null);
    }
  }

  async function handleArchiveSelectedTeam(isArchived: boolean) {
    if (!selectedId || !detail) return;
    const verb = isArchived ? 'archive' : 'restore';
    const confirmed = window.confirm(
      isArchived
        ? `Archive ${detail.team.name}? It will be hidden from the default teams view, but its members and linked context will remain intact.`
        : `Restore ${detail.team.name}? It will return to the active teams view.`,
    );
    if (!confirmed) return;

    setActionError('');
    setWorkingKey(`${verb}-team`);
    try {
      const res = await api.patch(`/api/teams/${selectedId}`, { is_archived: isArchived });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Failed to ${verb} team`);

      if (isArchived && !showArchived) {
        setDetail(null);
        setDashboard(null);
        await loadTeams(null);
        return;
      }

      await Promise.all([loadTeams(selectedId), loadTeamDetail(selectedId)]);
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setWorkingKey(null);
    }
  }

  const leadName = detail?.lead?.name ?? (detail?.team.lead_user_id ? 'Assigned lead' : 'No lead yet');

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1220px] space-y-4 p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <h2 className="section-title" style={{ fontFamily: 'var(--font-heading)' }}>Teams</h2>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed" style={{ color: 'var(--muted)' }}>
              Shape work around real operating teams, then give managers one place to see people, linked work, context, and agent activity.
            </p>
          </div>
          {isAdmin && (
            <button
              onClick={() => { setShowCreate(!showCreate); setCreateError(''); }}
              className="inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 text-[12px] font-semibold"
              style={{ background: 'var(--accent)', color: 'white', fontFamily: 'var(--font-heading)' }}
            >
              <Plus size={14} />
              New team
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <MetricCard icon={Users} label="Teams" value={summary.teams} />
          <MetricCard icon={UserRound} label="Seats" value={summary.members} tone="accent" />
          <MetricCard icon={Link2} label="Links" value={summary.resources} />
          <MetricCard icon={Lock} label="Private" value={summary.private} />
        </div>

        {showCreate && (
          <form onSubmit={handleCreate} className="rounded-lg p-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
            <div className="mb-3">
              <p className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>Create a team</p>
              <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
                Start simple: name, lead, and visibility. Members and linked resources can be expanded as the team gets real work.
              </p>
            </div>
            {createError && (
              <div className="mb-3 rounded px-3 py-2 text-[12px]" style={{ background: 'rgba(147,0,10,0.2)', color: 'var(--error)' }}>
                {createError}
              </div>
            )}
            <div className="grid gap-2 md:grid-cols-[minmax(0,1.2fr)_minmax(160px,0.8fr)_160px]">
              <input
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="Marketing"
                className="h-9 min-w-0 rounded-md px-3 text-[13px] outline-none"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                required
              />
              <input
                value={form.handle}
                onChange={(e) => setForm((prev) => ({ ...prev, handle: e.target.value }))}
                placeholder="marketing"
                className="h-9 min-w-0 rounded-md px-3 text-[13px] outline-none"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              />
              <select
                value={form.visibility}
                onChange={(e) => setForm((prev) => ({ ...prev, visibility: e.target.value as 'org' | 'private' }))}
                className="h-9 rounded-md px-2 text-[12px] outline-none"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              >
                <option value="org">Org-visible</option>
                <option value="private">Private</option>
              </select>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
              <textarea
                value={form.description}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="What this team owns..."
                rows={2}
                className="min-w-0 resize-none rounded-md px-3 py-2 text-[13px] outline-none"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              />
              <div className="grid gap-2 sm:grid-cols-[180px_auto] md:grid-cols-1">
                <select
                  value={form.lead_user_id}
                  onChange={(e) => setForm((prev) => ({ ...prev, lead_user_id: e.target.value }))}
                  className="h-9 rounded-md px-2 text-[12px] outline-none"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                >
                  <option value="">No lead yet</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>{member.name}</option>
                  ))}
                </select>
                <button
                  type="submit"
                  disabled={creating}
                  className="h-9 rounded-md px-4 text-[12px] font-semibold disabled:opacity-50"
                  style={{ background: 'var(--accent)', color: 'white' }}
                >
                  {creating ? 'Creating...' : 'Create'}
                </button>
              </div>
            </div>
          </form>
        )}

        <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <section className="min-w-0 overflow-hidden rounded-lg" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
            <div className="border-b p-3" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
              <div className="relative">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search teams..."
                  className="h-9 w-full min-w-0 rounded-md pl-9 pr-3 text-[13px] outline-none"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                />
              </div>
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12px]" style={{ color: 'var(--muted)' }}>
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                Show archived teams
              </label>
            </div>

            <div>
              {loading ? (
                <div className="p-6 text-[13px]" style={{ color: 'var(--muted)' }}>Loading teams...</div>
              ) : filteredTeams.length === 0 ? (
                <div className="p-6 text-[13px]" style={{ color: 'var(--muted)' }}>No teams match this view.</div>
              ) : filteredTeams.map((team) => {
                const selected = selectedId === team.id;
                return (
                  <button
                    key={team.id}
                    onClick={() => setSelectedId(team.id)}
                    className="flex w-full min-w-0 items-start gap-3 border-b px-3 py-3 text-left transition last:border-b-0 hover:bg-white/[0.025]"
                    style={{ background: selected ? 'var(--hover-tint)' : 'transparent', borderColor: 'rgba(255,255,255,0.08)' }}
                  >
                    <div
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold text-white"
                      style={{ background: team.color || 'var(--accent)' }}
                    >
                      {initials(team.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <p className="truncate text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>{team.name}</p>
                        {team.visibility === 'private' ? <Pill><Lock size={11} />Private</Pill> : <Pill>Org</Pill>}
                        {team.is_archived && <Pill tone="warning">Archived</Pill>}
                      </div>
                      <p className="mt-0.5 truncate text-[12px]" style={{ color: 'var(--muted)' }}>#{team.handle}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Pill><Users size={11} />{team.member_count}</Pill>
                        <Pill><Link2 size={11} />{team.resource_count}</Pill>
                        {team.current_user_role && <Pill tone="accent">{team.current_user_role}</Pill>}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="min-w-0 space-y-4">
            {detailLoading ? (
              <div className="rounded-lg p-8 text-center text-[13px]" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
                Loading team dashboard...
              </div>
            ) : !detail ? (
              <div className="rounded-lg p-8 text-center text-[13px]" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
                Select a team to inspect its roster, work, context, and operating signals.
              </div>
            ) : (
              <>
                <div className="rounded-lg p-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-[22px] font-semibold" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>
                          {detail.team.name}
                        </h3>
                        {detail.team.visibility === 'private' ? <Pill><Lock size={11} />Private</Pill> : <Pill tone="success"><Shield size={11} />Org-visible</Pill>}
                        {detail.team.is_archived && <Pill tone="warning">Archived</Pill>}
                      </div>
                      <p className="mt-1 text-[13px]" style={{ color: 'var(--muted)' }}>
                        #{detail.team.handle} - Lead: {leadName}
                      </p>
                      {detail.team.description && (
                        <p className="mt-3 max-w-3xl text-[13px] leading-relaxed" style={{ color: 'var(--foreground-secondary)' }}>
                          {detail.team.description}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col gap-2 sm:w-[320px]">
                      {canManageSelectedTeam && (
                        <button
                          data-testid={detail.team.is_archived ? 'team-restore-button' : 'team-archive-button'}
                          type="button"
                          onClick={() => handleArchiveSelectedTeam(!detail.team.is_archived)}
                          disabled={workingKey === 'archive-team' || workingKey === 'restore-team'}
                          className="inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-[12px] font-semibold disabled:opacity-50"
                          style={{
                            color: detail.team.is_archived ? 'white' : 'var(--muted)',
                            background: detail.team.is_archived ? 'var(--accent)' : 'transparent',
                            border: '1px solid var(--border)',
                          }}
                        >
                          {detail.team.is_archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                          {detail.team.is_archived ? 'Restore team' : 'Archive team'}
                        </button>
                      )}
                      <div className="grid grid-cols-3 gap-2">
                        <MetricCard icon={Users} label="People" value={detail.summary.member_count} />
                        <MetricCard icon={Bot} label="Agents" value={detail.summary.agent_count} />
                        <MetricCard icon={Link2} label="Links" value={detail.resources.length} />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-4">
                  <MetricCard icon={AlertTriangle} label="Overdue" value={dashboard?.attention.overdue_tasks ?? 0} tone={(dashboard?.attention.overdue_tasks ?? 0) > 0 ? 'warning' : 'success'} />
                  <MetricCard icon={Clock} label="Due soon" value={dashboard?.attention.due_soon_tasks ?? 0} tone="accent" />
                  <MetricCard icon={CheckCircle2} label="In review" value={dashboard?.attention.in_review_tasks ?? 0} />
                  <MetricCard icon={Sparkles} label="Approvals" value={dashboard?.attention.pending_agent_actions ?? 0} />
                </div>

                {actionError && (
                  <div className="rounded-lg px-3 py-2 text-[12px]" style={{ background: 'rgba(147,0,10,0.2)', color: 'var(--error)', border: '1px solid rgba(147,0,10,0.25)' }}>
                    {actionError}
                  </div>
                )}

                <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
                  <div className="space-y-4">
                    <div className="rounded-lg p-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
                      <SectionTitle icon={Briefcase} title="Team Workload" eyebrow="Action surface" />
                      <div className="grid gap-3 md:grid-cols-[140px_minmax(0,1fr)]">
                        <div>
                          <p className="text-[34px] font-semibold leading-none" style={{ color: 'var(--foreground)' }}>{dashboard?.workload.open_tasks ?? 0}</p>
                          <p className="mt-1 text-[12px]" style={{ color: 'var(--muted)' }}>open tasks in linked projects</p>
                        </div>
                        <div className="space-y-2">
                          {Object.entries(dashboard?.workload.by_status ?? {}).length === 0 ? (
                            <p className="text-[13px]" style={{ color: 'var(--muted)' }}>Link a project to this team to populate workload.</p>
                          ) : Object.entries(dashboard?.workload.by_status ?? {}).map(([status, count]) => (
                            <div key={status} className="flex items-center justify-between gap-3 rounded-md px-3 py-2" style={{ background: 'var(--surface)' }}>
                              <span className="text-[12px] font-medium" style={{ color: 'var(--foreground)' }}>{STATUS_LABELS[status] ?? status}</span>
                              <span className="text-[12px] font-semibold" style={{ color: 'var(--muted)' }}>{count}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="rounded-lg p-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
                      <SectionTitle icon={CircleDot} title="Needs Attention" eyebrow="Manager view" />
                      <div className="space-y-2">
                        {(dashboard?.attention.top_tasks ?? []).length === 0 ? (
                          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>No linked task needs attention right now.</p>
                        ) : dashboard!.attention.top_tasks.map((task) => (
                          <div key={task.id} className="rounded-md p-3" style={{ background: 'var(--surface)' }}>
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="min-w-0 flex-1 truncate text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>
                                {task.project_prefix}-{task.number} {task.title}
                              </p>
                              <Pill tone={task.priority === 'p0' || task.priority === 'p1' ? 'warning' : 'neutral'}>{task.priority.toUpperCase()}</Pill>
                            </div>
                            <p className="mt-1 text-[11px]" style={{ color: 'var(--muted)' }}>
                              {STATUS_LABELS[task.status] ?? task.status} - {task.assignee_name ?? 'Unassigned'} - {task.due_date ? new Date(task.due_date).toLocaleDateString() : 'No due date'}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-lg p-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
                      <SectionTitle icon={Users} title="Roster" eyebrow="People and agents" />
                      {canManageSelectedTeam && (
                        <form onSubmit={handleAddMember} className="mb-3 grid gap-2 rounded-lg p-2 sm:grid-cols-[minmax(0,1fr)_100px_auto]" style={{ background: 'var(--surface)' }}>
                          <select
                            data-testid="team-add-member-select"
                            value={memberForm.user_id}
                            onChange={(e) => setMemberForm((prev) => ({ ...prev, user_id: e.target.value }))}
                            className="h-8 min-w-0 rounded-md px-2 text-[12px] outline-none"
                            style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                            disabled={availableMembers.length === 0}
                          >
                            {availableMembers.length === 0 ? (
                              <option value="">Everyone is on this team</option>
                            ) : availableMembers.map((member) => (
                              <option key={member.id} value={member.id}>{member.name}</option>
                            ))}
                          </select>
                          <select
                            data-testid="team-add-member-role"
                            value={memberForm.role}
                            onChange={(e) => setMemberForm((prev) => ({ ...prev, role: e.target.value as (typeof TEAM_ROLES)[number] }))}
                            className="h-8 rounded-md px-2 text-[12px] outline-none"
                            style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                          >
                            {TEAM_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                          </select>
                          <button
                            data-testid="team-add-member-submit"
                            type="submit"
                            disabled={!memberForm.user_id || workingKey === 'add-member'}
                            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-semibold disabled:opacity-50"
                            style={{ background: 'var(--accent)', color: 'white' }}
                          >
                            <UserPlus size={12} />
                            Add
                          </button>
                        </form>
                      )}
                      <div className="space-y-2">
                        {detail.members.length === 0 ? (
                          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>No members have been added yet.</p>
                        ) : detail.members.map((member) => (
                          <div key={member.id} className="flex min-w-0 items-center gap-3 rounded-md p-2" style={{ background: 'var(--surface)' }}>
                            <Avatar name={member.name} avatarUrl={member.avatar_url} kind={member.kind} size="sm" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>{member.name}</p>
                              <p className="truncate text-[11px]" style={{ color: 'var(--muted)' }}>{member.title || member.email || member.kind}</p>
                            </div>
                            {canManageSelectedTeam ? (
                              <div className="flex shrink-0 items-center gap-1">
                                <select
                                  data-testid={`team-member-role-${member.user_id}`}
                                  value={member.role}
                                  onChange={(e) => handleMemberRole(member.user_id, e.target.value as (typeof TEAM_ROLES)[number])}
                                  disabled={workingKey === `role-${member.user_id}`}
                                  className="h-7 rounded-md px-1.5 text-[11px] outline-none"
                                  style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                                >
                                  {TEAM_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                                </select>
                                <button
                                  data-testid={`team-member-remove-${member.user_id}`}
                                  type="button"
                                  onClick={() => handleRemoveMember(member.user_id)}
                                  disabled={workingKey === `remove-member-${member.user_id}`}
                                  aria-label={`Remove ${member.name}`}
                                  className="inline-flex h-7 w-7 items-center justify-center rounded-md disabled:opacity-50"
                                  style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            ) : (
                              <Pill tone={member.role === 'lead' ? 'accent' : 'neutral'}>{member.role}</Pill>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-lg p-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
                      <SectionTitle icon={Layers3} title="Team Context" eyebrow="Knowledge surface" />
                      <div className="grid grid-cols-2 gap-2">
                        <MetricCard icon={MessageSquare} label="Spaces" value={dashboard?.context.linked_spaces ?? 0} />
                        <MetricCard icon={Briefcase} label="Projects" value={dashboard?.context.linked_projects ?? 0} />
                        <MetricCard icon={FileText} label="Wiki pages" value={dashboard?.context.linked_wiki_pages ?? 0} />
                        <MetricCard icon={CalendarDays} label="Calendars" value={dashboard?.context.linked_calendar_feeds ?? 0} />
                      </div>
                      <p className="mt-3 text-[12px]" style={{ color: 'var(--muted)' }}>
                        Snapshot freshness: {relativeTime(dashboard?.context.latest_snapshot?.generated_at)}
                      </p>
                    </div>

                    <div className="rounded-lg p-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
                      <SectionTitle icon={Link2} title="Linked Resources" eyebrow="Operating map" />
                      {canManageSelectedTeam && (
                        <form onSubmit={handleLinkResource} className="mb-3 grid gap-2 rounded-lg p-2" style={{ background: 'var(--surface)' }}>
                          <div className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)]">
                            <select
                              data-testid="team-resource-type-select"
                              value={resourceForm.resource_type}
                              onChange={(e) => setResourceForm({ resource_type: e.target.value as (typeof LINKABLE_RESOURCE_TYPES)[number], resource_id: '', label: '' })}
                              className="h-8 rounded-md px-2 text-[12px] outline-none"
                              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                            >
                              {LINKABLE_RESOURCE_TYPES.map((type) => <option key={type} value={type}>{resourceLabel(type)}</option>)}
                            </select>
                            <select
                              data-testid="team-resource-select"
                              value={resourceForm.resource_id}
                              onChange={(e) => setResourceForm((prev) => ({ ...prev, resource_id: e.target.value }))}
                              className="h-8 min-w-0 rounded-md px-2 text-[12px] outline-none"
                              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                              disabled={availableResources.length === 0}
                            >
                              {availableResources.length === 0 ? (
                                <option value="">No available {resourceLabel(resourceForm.resource_type).toLowerCase()}</option>
                              ) : availableResources.map((resource) => (
                                <option key={resource.id} value={resource.id}>
                                  {resource.label}{resource.hint ? ` - ${resource.hint}` : ''}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                            <input
                              data-testid="team-resource-label-input"
                              value={resourceForm.label}
                              onChange={(e) => setResourceForm((prev) => ({ ...prev, label: e.target.value }))}
                              placeholder="Optional label"
                              className="h-8 min-w-0 rounded-md px-2 text-[12px] outline-none"
                              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                            />
                            <button
                              data-testid="team-resource-link-submit"
                              type="submit"
                              disabled={!resourceForm.resource_id || workingKey === 'link-resource'}
                              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-[12px] font-semibold disabled:opacity-50"
                              style={{ background: 'var(--accent)', color: 'white' }}
                            >
                              <Link2 size={12} />
                              Link
                            </button>
                          </div>
                        </form>
                      )}
                      <div className="flex flex-wrap gap-1.5">
                        {detail.resources.length === 0 ? (
                          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>No linked resources yet.</p>
                        ) : detail.resources.map((resource) => (
                          <span
                            key={resource.id}
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                            style={{ color: 'var(--accent)', background: 'var(--accent-light, rgba(124,107,79,0.12))' }}
                          >
                            {resourceSingularLabel(resource.resource_type)}: {resource.label || resource.resource_id.slice(0, 8)}
                            {canManageSelectedTeam && (
                              <button
                                data-testid={`team-resource-detach-${resource.resource_type}-${resource.resource_id}`}
                                type="button"
                                onClick={() => handleDetachResource(resource)}
                                disabled={workingKey === `detach-${resource.id}`}
                                aria-label={`Detach ${resource.label || resource.resource_type}`}
                                className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full disabled:opacity-50"
                                style={{ color: 'var(--muted)' }}
                              >
                                <Trash2 size={10} />
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
