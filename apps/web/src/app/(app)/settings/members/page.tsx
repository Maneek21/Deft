'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Bot,
  Briefcase,
  Check,
  ChevronDown,
  Clock,
  Copy,
  KeyRound,
  MailPlus,
  PlugZap,
  RefreshCw,
  Search,
  Shield,
  Trash2,
  UserMinus,
  UserPlus,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

const ROLE_OPTIONS = ['admin', 'member', 'guest'] as const;
const FILTERS = ['all', 'humans', 'agents', 'pending', 'inactive'] as const;

type LifecycleStatus = 'active' | 'pending' | 'inactive';

type DirectoryStats = {
  spaces: number;
  assigned_tasks_open: number;
  assigned_tasks_total: number;
  led_projects: number;
  wiki_pages: number;
  active_mcp_tokens: number;
  active_api_keys: number;
  active_oauth_grants: number;
};

type AgentMeta = {
  id: string;
  name: string | null;
  role: string | null;
  trust_level: string | null;
  runtime_kind: string | null;
  certification_status: string | null;
  is_active: boolean | null;
  unhealthy: boolean | null;
  last_mcp_call_at: string | null;
  last_heartbeat_at: string | null;
};

type DirectoryMember = {
  id: string;
  name: string;
  email: string | null;
  kind: 'human' | 'agent';
  avatar_url: string | null;
  title: string | null;
  profile_summary: string | null;
  expertise_tags: string[];
  timezone: string | null;
  status_emoji: string | null;
  status_text: string | null;
  last_seen_at: string | null;
  email_verified: boolean;
  role: string;
  is_active: boolean;
  joined_at: string | null;
  lifecycle_status: LifecycleStatus;
  pending_invite_id: string | null;
  pending_invite_expires_at: string | null;
  stats: DirectoryStats;
  agent: AgentMeta | null;
};

type InviteRow = {
  id: string;
  email: string;
  role: string;
  user_id: string | null;
  inviter_name: string | null;
  accepted_at: string | null;
  expires_at: string | null;
  created_at: string | null;
  status: 'pending' | 'accepted' | 'expired';
};

type MemberDetail = {
  member: DirectoryMember;
  spaces: Array<{ id: string; name: string; type: string; is_default: boolean; joined_at: string | null }>;
  open_tasks: Array<{ id: string; title: string; status: string; priority: string; due_date: string | null; updated_at: string | null }>;
  led_projects: Array<{ id: string; name: string; prefix: string; is_archived: boolean }>;
  pending_invites: InviteRow[];
  mcp_tokens: Array<{ id: string; name: string; token_prefix: string; scopes: string[]; last_used_at: string | null; created_at: string | null }>;
  oauth_grants: Array<{ id: string; app_name: string; connector_profile: string; scopes: string[]; created_at: string | null; updated_at: string | null }>;
};

type DirectoryResponse = {
  members: DirectoryMember[];
  invites: InviteRow[];
  summary: {
    active: number;
    pending: number;
    inactive: number;
    agents: number;
  };
};

type ShareLink = {
  url: string;
  expiresAt: string | null;
  context: string;
};

function formatExpiry(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const hrs = Math.round((d.getTime() - Date.now()) / 3_600_000);
  if (hrs <= 0) return 'expired';
  if (hrs < 48) return `expires in ${hrs}h`;
  const days = Math.round(hrs / 24);
  return `expires in ${days}d`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'Just now';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function lifecycleTone(status: LifecycleStatus) {
  if (status === 'active') return { label: 'Active', color: 'var(--success)', bg: 'rgba(34,197,94,0.12)' };
  if (status === 'pending') return { label: 'Pending', color: 'var(--warning)', bg: 'rgba(234,179,8,0.12)' };
  return { label: 'Inactive', color: 'var(--muted)', bg: 'var(--surface)' };
}

function roleLabel(role: string) {
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Member';
}

function Avatar({ member, size = 'md' }: { member: Pick<DirectoryMember, 'name' | 'avatar_url' | 'kind'>; size?: 'sm' | 'md' | 'lg' }) {
  const classes = size === 'lg' ? 'h-14 w-14 text-[17px]' : size === 'sm' ? 'h-8 w-8 text-[11px]' : 'h-9 w-9 text-[12px]';
  return (
    <div
      className={`${classes} shrink-0 overflow-hidden rounded-full flex items-center justify-center font-semibold text-white`}
      style={{ background: member.kind === 'agent' ? 'var(--accent)' : 'var(--avatar-bg)' }}
    >
      {member.avatar_url ? (
        <img src={member.avatar_url} alt="" className="h-full w-full object-cover" />
      ) : member.kind === 'agent' ? (
        <Bot size={size === 'lg' ? 24 : 16} />
      ) : (
        member.name.charAt(0).toUpperCase()
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: any; label: string; value: number | string }) {
  return (
    <div className="rounded-lg p-2.5" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
        <Icon size={12} />
        {label}
      </div>
      <div className="mt-1 text-[19px] font-semibold" style={{ color: 'var(--foreground)' }}>{value}</div>
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value }: { icon: any; label: string; value: number }) {
  return (
    <div
      className="flex min-h-[62px] items-center justify-between gap-2 rounded-lg px-3 py-2"
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
          <Icon size={12} />
          <span className="truncate">{label}</span>
        </div>
        <div className="mt-1 text-[22px] font-semibold leading-none" style={{ color: 'var(--foreground)' }}>{value}</div>
      </div>
    </div>
  );
}

function Pill({ children, tone, className = '' }: { children: React.ReactNode; tone?: { color: string; bg: string }; className?: string }) {
  const displayClass = /(^|\s)(hidden|inline-flex|flex|grid|block)(\s|$)/.test(className) ? '' : 'inline-flex';
  return (
    <span
      className={`${displayClass} items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${className}`}
      style={{ color: tone?.color ?? 'var(--foreground-secondary)', background: tone?.bg ?? 'var(--surface)' }}
    >
      {children}
    </span>
  );
}

export default function MembersPage() {
  const { user } = useAuth();
  const [members, setMembers] = useState<DirectoryMember[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [summary, setSummary] = useState<DirectoryResponse['summary']>({ active: 0, pending: 0, inactive: 0, agents: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<string>('member');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [shareLink, setShareLink] = useState<ShareLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [roleDropdown, setRoleDropdown] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [workingInviteId, setWorkingInviteId] = useState<string | null>(null);
  const [recoveringId, setRecoveringId] = useState<string | null>(null);

  const isAdmin = user?.role === 'owner' || user?.role === 'admin';

  const fetchDirectory = async (preferredId?: string | null) => {
    setLoading(true);
    const res = await api.get('/api/members/directory');
    if (res.ok) {
      const data = await res.json() as DirectoryResponse;
      setMembers(data.members);
      setInvites(data.invites);
      setSummary(data.summary);
      const nextId = preferredId && data.members.some((m) => m.id === preferredId)
        ? preferredId
        : data.members[0]?.id ?? null;
      setSelectedId(nextId);
    }
    setLoading(false);
  };

  const fetchDetail = async (id: string | null) => {
    if (!id) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    const res = await api.get(`/api/members/${id}/detail`);
    if (res.ok) {
      setDetail(await res.json());
    } else {
      setDetail(null);
    }
    setDetailLoading(false);
  };

  useEffect(() => { fetchDirectory(); }, []);
  useEffect(() => { fetchDetail(selectedId); }, [selectedId]);

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members.filter((m) => {
      if (filter === 'humans' && m.kind !== 'human') return false;
      if (filter === 'agents' && m.kind !== 'agent') return false;
      if (filter === 'pending' && m.lifecycle_status !== 'pending') return false;
      if (filter === 'inactive' && m.lifecycle_status !== 'inactive') return false;
      if (!q) return true;
      return [
        m.name,
        m.email ?? '',
        m.title ?? '',
        m.profile_summary ?? '',
        ...m.expertise_tags,
      ].some((value) => value.toLowerCase().includes(q));
    });
  }, [members, filter, search]);

  const pendingInvites = invites.filter((invite) => invite.status === 'pending');

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteError('');
    setShareLink(null);
    setInviteLoading(true);
    try {
      const res = await api.post('/api/members/invite', { email: inviteEmail, role: inviteRole });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create invite');
      setShareLink({
        url: data.invite_url,
        expiresAt: data.expires_at,
        context: `Invite link for ${inviteEmail}`,
      });
      setInviteEmail('');
      setInviteRole('member');
      setShowInvite(false);
      await fetchDirectory(selectedId);
    } catch (err: any) {
      setInviteError(err.message);
    } finally {
      setInviteLoading(false);
    }
  };

  const handleRoleChange = async (memberId: string, newRole: string) => {
    const res = await api.patch(`/api/members/${memberId}`, { role: newRole });
    if (res.ok) {
      await fetchDirectory(memberId);
      await fetchDetail(memberId);
    }
    setRoleDropdown(null);
  };

  const handleRemove = async (memberId: string) => {
    const res = await api.delete(`/api/members/${memberId}`);
    if (res.ok) {
      await fetchDirectory(null);
      setDetail(null);
    }
    setConfirmRemove(null);
  };

  const handleRecoveryLink = async (m: DirectoryMember) => {
    setRecoveringId(m.id);
    setShareLink(null);
    setInviteError('');
    try {
      const res = await api.post(`/api/members/${m.id}/recovery-url`, {});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate recovery link');
      setShareLink({
        url: data.recovery_url,
        expiresAt: data.expires_at,
        context: `Password recovery link for ${m.name}`,
      });
    } catch (err: any) {
      setInviteError(err.message);
    } finally {
      setRecoveringId(null);
    }
  };

  const handleReissueInvite = async (invite: InviteRow) => {
    setWorkingInviteId(invite.id);
    setShareLink(null);
    setInviteError('');
    try {
      const res = await api.post(`/api/members/invites/${invite.id}/reissue`, {});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reissue invite');
      setShareLink({
        url: data.invite_url,
        expiresAt: data.expires_at,
        context: `Fresh invite link for ${invite.email}`,
      });
      await fetchDirectory(selectedId);
    } catch (err: any) {
      setInviteError(err.message);
    } finally {
      setWorkingInviteId(null);
    }
  };

  const handleRevokeInvite = async (invite: InviteRow) => {
    setWorkingInviteId(invite.id);
    setInviteError('');
    const res = await api.delete(`/api/members/invites/${invite.id}`);
    if (res.ok) {
      setShareLink(null);
      await fetchDirectory(selectedId);
      if (detail?.pending_invites.some((i) => i.id === invite.id)) {
        await fetchDetail(selectedId);
      }
    } else {
      const data = await res.json().catch(() => ({}));
      setInviteError(data.error || 'Failed to revoke invite');
    }
    setWorkingInviteId(null);
  };

  const copyShareLink = async () => {
    if (!shareLink) return;
    await navigator.clipboard.writeText(shareLink.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1180px] space-y-4 p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <h2 className="section-title" style={{ fontFamily: 'var(--font-heading)' }}>People</h2>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed" style={{ color: 'var(--muted)' }}>
              Manage humans, agent employees, pending invites, access recovery, and workspace offboarding from one place.
            </p>
          </div>
          {isAdmin && (
            <button
              onClick={() => { setShowInvite(!showInvite); setShareLink(null); setInviteError(''); }}
              className="inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 text-[12px] font-semibold"
              style={{ background: 'var(--accent)', color: 'white', fontFamily: 'var(--font-heading)' }}
            >
              <UserPlus size={14} />
              <span className="lg:hidden">Invite</span>
              <span className="hidden lg:inline">Invite teammate</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <SummaryCard icon={Users} label="Active" value={summary.active} />
          <SummaryCard icon={MailPlus} label="Pending" value={summary.pending} />
          <SummaryCard icon={Bot} label="Agents" value={summary.agents} />
          <SummaryCard icon={UserMinus} label="Inactive" value={summary.inactive} />
        </div>

        {showInvite && (
          <form onSubmit={handleInvite} className="rounded-lg p-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <p className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>Create an invite link</p>
                <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
                  Links expire in 7 days. New teammates appear as pending until they accept and set a password.
                </p>
              </div>
              <button type="button" onClick={() => setShowInvite(false)} style={{ color: 'var(--muted)' }} aria-label="Close invite form">
                <X size={16} />
              </button>
            </div>
            {inviteError && (
              <div className="mb-3 rounded px-3 py-2 text-[12px]" style={{ background: 'rgba(147,0,10,0.2)', color: 'var(--error)' }}>
                {inviteError}
              </div>
            )}
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_130px_auto]">
              <input
                type="email"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                placeholder="name@company.com"
                className="h-9 min-w-0 rounded-md px-3 text-[13px] outline-none"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                required
              />
              <select
                value={inviteRole}
                onChange={e => setInviteRole(e.target.value)}
                className="h-9 rounded-md px-2 text-[12px] outline-none"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              >
                {ROLE_OPTIONS.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
              </select>
              <button
                type="submit"
                disabled={inviteLoading}
                className="h-9 rounded-md px-4 text-[12px] font-semibold disabled:opacity-50"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                {inviteLoading ? 'Generating...' : 'Generate'}
              </button>
            </div>
          </form>
        )}

        {shareLink && (
          <div className="rounded-lg p-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--accent)' }}>
            <div className="mb-2 flex items-start justify-between gap-3">
              <div>
                <p className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>{shareLink.context}</p>
                {shareLink.expiresAt && <p className="mt-0.5 text-[11px]" style={{ color: 'var(--muted)' }}>{formatExpiry(shareLink.expiresAt)}</p>}
              </div>
              <button onClick={() => setShareLink(null)} style={{ color: 'var(--muted)' }} aria-label="Dismiss">
                <X size={14} />
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <input
                type="text"
                readOnly
                value={shareLink.url}
                onFocus={e => e.currentTarget.select()}
                className="h-9 min-w-0 rounded-md px-3 font-mono text-[12px] outline-none"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              />
              <button
                type="button"
                onClick={copyShareLink}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-3 text-[12px] font-semibold"
                style={{ background: copied ? 'var(--accent)' : 'var(--surface)', color: copied ? 'white' : 'var(--foreground)', border: '1px solid var(--border)' }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(360px,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_390px]">
          <section className="min-w-0 overflow-hidden rounded-lg" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
            <div className="border-b p-3" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
              <div className="space-y-2">
                <div className="relative min-w-0">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search people, roles, expertise..."
                    className="h-9 w-full min-w-0 rounded-md pl-9 pr-3 text-[13px] outline-none"
                    style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                  />
                </div>
                <div className="flex gap-1 overflow-x-auto rounded-lg p-1" style={{ background: 'var(--surface)' }}>
                  {FILTERS.map((f) => (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      className="shrink-0 rounded-md px-2.5 py-1.5 text-[12px] font-semibold transition"
                      style={{
                        background: filter === f ? 'var(--accent)' : 'transparent',
                        color: filter === f ? 'white' : 'var(--foreground-secondary)',
                      }}
                    >
                      {f.charAt(0).toUpperCase() + f.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div>
              {loading ? (
                <div className="p-6 text-[13px]" style={{ color: 'var(--muted)' }}>Loading people...</div>
              ) : filteredMembers.length === 0 ? (
                <div className="p-6 text-[13px]" style={{ color: 'var(--muted)' }}>No people match this filter.</div>
              ) : filteredMembers.map((m) => {
                const tone = lifecycleTone(m.lifecycle_status);
                const selected = selectedId === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => setSelectedId(m.id)}
                    className="group flex w-full min-w-0 items-start gap-3 border-b px-3 py-2 text-left transition last:border-b-0 hover:bg-white/[0.025]"
                    style={{ background: selected ? 'var(--hover-tint)' : 'transparent', borderColor: 'rgba(255,255,255,0.08)' }}
                  >
                    <Avatar member={m} />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <p className="truncate text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>
                          {m.name}
                          {m.id === user?.id && <span className="ml-1 text-[11px] font-normal" style={{ color: 'var(--muted)' }}>(you)</span>}
                        </p>
                        <Pill tone={tone}>{tone.label}</Pill>
                        {m.kind === 'agent' && <Pill><Bot size={11} className="mr-1" />Agent</Pill>}
                      </div>
                      <p className="mt-0.5 truncate text-[12px]" style={{ color: 'var(--muted)' }}>
                        {m.title || m.email || 'No role title yet'}
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        <Pill>{roleLabel(m.role)}</Pill>
                        <Pill>{m.stats.assigned_tasks_open} open tasks</Pill>
                        <Pill className="hidden sm:inline-flex">{m.stats.spaces} spaces</Pill>
                        {m.agent?.unhealthy && <Pill tone={{ color: 'var(--error)', bg: 'rgba(147,0,10,0.2)' }}>Unhealthy</Pill>}
                      </div>
                    </div>
                    <ChevronDown size={14} className="-rotate-90 opacity-40" />
                  </button>
                );
              })}
            </div>

            {isAdmin && pendingInvites.length > 0 && (
              <div className="border-t p-3" style={{ borderColor: 'var(--border)' }}>
                <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
                  <MailPlus size={13} />
                  Pending invites
                </div>
                <div className="space-y-2">
                  {pendingInvites.map((invite) => (
                    <div key={invite.id} className="grid gap-2 rounded-md p-3 md:grid-cols-[minmax(0,1fr)_auto]" style={{ background: 'var(--surface)' }}>
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>{invite.email}</p>
                        <p className="mt-0.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                          {roleLabel(invite.role)} - {formatExpiry(invite.expires_at)} - invited by {invite.inviter_name || 'Unknown'}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleReissueInvite(invite)}
                          disabled={workingInviteId === invite.id}
                          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[11px] font-semibold disabled:opacity-50"
                          style={{ color: 'var(--foreground)', border: '1px solid var(--border)' }}
                        >
                          <RefreshCw size={12} />
                          Reissue
                        </button>
                        <button
                          onClick={() => handleRevokeInvite(invite)}
                          disabled={workingInviteId === invite.id}
                          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[11px] font-semibold disabled:opacity-50"
                          style={{ color: 'var(--error)', border: '1px solid var(--border)' }}
                        >
                          <Trash2 size={12} />
                          Revoke
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          <aside className="min-w-0 rounded-lg p-4 xl:sticky xl:top-4 xl:self-start" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
            {detailLoading ? (
              <div className="py-8 text-center text-[13px]" style={{ color: 'var(--muted)' }}>Loading member detail...</div>
            ) : !detail ? (
              <div className="py-8 text-center text-[13px]" style={{ color: 'var(--muted)' }}>Select a person to inspect access and work context.</div>
            ) : (
              <div className="space-y-4">
                <div className="flex min-w-0 items-start gap-3">
                  <Avatar member={detail.member} size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-[18px] font-semibold" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>
                        {detail.member.name}
                      </h3>
                      <Pill tone={lifecycleTone(detail.member.lifecycle_status)}>{lifecycleTone(detail.member.lifecycle_status).label}</Pill>
                    </div>
                    <p className="mt-1 truncate text-[12px]" style={{ color: 'var(--muted)' }}>{detail.member.email || 'Agent employee'}</p>
                    <p className="mt-1 text-[13px]" style={{ color: 'var(--foreground-secondary)' }}>{detail.member.title || 'No title set'}</p>
                  </div>
                </div>

                {detail.member.profile_summary && (
                  <p className="rounded-md p-3 text-[12px] leading-relaxed" style={{ background: 'var(--surface)', color: 'var(--foreground-secondary)' }}>
                    {detail.member.profile_summary}
                  </p>
                )}

                <div className="flex flex-wrap gap-1.5">
                  {detail.member.expertise_tags.map((tag) => <Pill key={tag}>{tag}</Pill>)}
                  {detail.member.timezone && <Pill>{detail.member.timezone}</Pill>}
                  {detail.member.status_text && <Pill>{detail.member.status_emoji} {detail.member.status_text}</Pill>}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <StatCard icon={Briefcase} label="Open tasks" value={detail.member.stats.assigned_tasks_open} />
                  <StatCard icon={Users} label="Spaces" value={detail.member.stats.spaces} />
                  <StatCard icon={Activity} label="Wiki pages" value={detail.member.stats.wiki_pages} />
                  <StatCard icon={PlugZap} label="AI access" value={detail.member.stats.active_mcp_tokens + detail.member.stats.active_oauth_grants} />
                </div>

                <div className="rounded-md p-3" style={{ background: 'var(--surface)' }}>
                  <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold" style={{ color: 'var(--foreground)' }}>
                    <Clock size={13} />
                    Presence
                  </div>
                  <div className="space-y-1 text-[12px]" style={{ color: 'var(--muted)' }}>
                    <p>Joined {relativeTime(detail.member.joined_at)}</p>
                    <p>Last seen {relativeTime(detail.member.last_seen_at)}</p>
                    <p>Email {detail.member.email_verified ? 'verified' : 'not verified'}</p>
                  </div>
                </div>

                {detail.member.agent && (
                  <div className="rounded-md p-3" style={{ background: 'var(--surface)' }}>
                    <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold" style={{ color: 'var(--foreground)' }}>
                      <Bot size={13} />
                      Agent employee
                    </div>
                    <div className="space-y-1 text-[12px]" style={{ color: 'var(--muted)' }}>
                      <p>{detail.member.agent.runtime_kind || 'custom'} - {detail.member.agent.trust_level || 'standard'} trust</p>
                      <p>{detail.member.agent.unhealthy ? 'Unhealthy' : 'Healthy'} - {detail.member.agent.certification_status || 'uncertified'}</p>
                      <p>Last MCP call {relativeTime(detail.member.agent.last_mcp_call_at)}</p>
                      <p>Last heartbeat {relativeTime(detail.member.agent.last_heartbeat_at)}</p>
                    </div>
                  </div>
                )}

                {isAdmin && (
                  <div className="rounded-md p-3" style={{ background: 'var(--surface)' }}>
                    <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold" style={{ color: 'var(--foreground)' }}>
                      <Shield size={13} />
                      Admin actions
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {detail.member.id !== user?.id && (
                        <button
                          onClick={() => handleRecoveryLink(detail.member)}
                          disabled={recoveringId === detail.member.id}
                          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold disabled:opacity-50"
                          style={{ color: 'var(--foreground)', border: '1px solid var(--border)' }}
                        >
                          <KeyRound size={12} />
                          Recovery link
                        </button>
                      )}

                      {detail.member.role !== 'owner' && detail.member.id !== user?.id && detail.member.is_active && (
                        <div className="relative">
                          <button
                            onClick={() => setRoleDropdown(roleDropdown === detail.member.id ? null : detail.member.id)}
                            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold"
                            style={{ color: 'var(--foreground)', border: '1px solid var(--border)' }}
                          >
                            {roleLabel(detail.member.role)}
                            <ChevronDown size={11} />
                          </button>
                          {roleDropdown === detail.member.id && (
                            <>
                              <div className="fixed inset-0 z-10" onClick={() => setRoleDropdown(null)} />
                              <div className="absolute left-0 top-full z-20 mt-1 w-32 rounded-lg py-1" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}>
                                {ROLE_OPTIONS.map((r) => (
                                  <button
                                    key={r}
                                    onClick={() => handleRoleChange(detail.member.id, r)}
                                    className="w-full px-3 py-1.5 text-left text-[12px]"
                                    style={{ color: detail.member.role === r ? 'var(--accent)' : 'var(--foreground)' }}
                                  >
                                    {roleLabel(r)}
                                  </button>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      )}

                      {detail.member.role !== 'owner' && detail.member.id !== user?.id && detail.member.is_active && (
                        confirmRemove === detail.member.id ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleRemove(detail.member.id)}
                              className="h-8 rounded-md px-2 text-[11px] font-semibold"
                              style={{ background: 'var(--error)', color: 'white' }}
                            >
                              Confirm remove
                            </button>
                            <button onClick={() => setConfirmRemove(null)} style={{ color: 'var(--muted)' }}>
                              <X size={14} />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmRemove(detail.member.id)}
                            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold"
                            style={{ color: 'var(--error)', border: '1px solid var(--border)' }}
                          >
                            <Trash2 size={12} />
                            Remove
                          </button>
                        )
                      )}
                    </div>
                  </div>
                )}

                <div className="rounded-md p-3" style={{ background: 'var(--surface)' }}>
                  <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold" style={{ color: 'var(--foreground)' }}>
                    <UserRound size={13} />
                    Work context
                  </div>
                  <div className="space-y-3">
                    <div>
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Spaces</p>
                      <div className="flex flex-wrap gap-1.5">
                        {detail.spaces.length ? detail.spaces.map((space) => <Pill key={space.id}>#{space.name}</Pill>) : <span className="text-[12px]" style={{ color: 'var(--muted)' }}>No spaces</span>}
                      </div>
                    </div>
                    <div>
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Open tasks</p>
                      <div className="space-y-1">
                        {detail.open_tasks.length ? detail.open_tasks.slice(0, 4).map((task) => (
                          <div key={task.id} className="rounded px-2 py-1.5 text-[12px]" style={{ background: 'var(--card-bg)', color: 'var(--foreground-secondary)' }}>
                            {task.title}
                          </div>
                        )) : <span className="text-[12px]" style={{ color: 'var(--muted)' }}>No open assigned tasks</span>}
                      </div>
                    </div>
                    {detail.mcp_tokens.length > 0 && (
                      <div>
                        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>MCP tokens</p>
                        <div className="space-y-1">
                          {detail.mcp_tokens.map((token) => (
                            <div key={token.id} className="rounded px-2 py-1.5 text-[12px]" style={{ background: 'var(--card-bg)', color: 'var(--foreground-secondary)' }}>
                              {token.name} - {token.token_prefix} - used {relativeTime(token.last_used_at)}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {detail.oauth_grants.length > 0 && (
                      <div>
                        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Connected AI apps</p>
                        <div className="space-y-1">
                          {detail.oauth_grants.map((grant) => (
                            <div key={grant.id} className="rounded px-2 py-1.5 text-[12px]" style={{ background: 'var(--card-bg)', color: 'var(--foreground-secondary)' }}>
                              {grant.app_name} - {grant.connector_profile}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
