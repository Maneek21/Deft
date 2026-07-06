'use client';

import { useState, useEffect, useRef, useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@/lib/auth-context';
import { useChatContext } from '@/lib/chat-context';
import { registerOpenCreateSpace } from '@/lib/quick-actions';
import { useTheme } from './theme-provider';
import { Logo } from './brand/logo';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/time';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  MessageSquare,
  CheckSquare,
  Bot,
  Settings,
  Sun,
  Moon,
  X,
  LogOut,
  Plus,
  Hash,
  User,
  Clock,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  BellOff,
  Bell,
  Bookmark,
  FileText,
  CalendarDays,
  Headphones,
  BookOpen,
  Smile,
  Inbox,
} from 'lucide-react';
import { CreateSpaceModal } from './create-space-modal';
import { CreateDmModal } from './create-dm-modal';
import { SavedMessages } from './saved-messages';
import { CreateProjectModal } from './create-project-modal';
import { useInboxCount } from '@/hooks/use-inbox-count';

type AgentEmployee = {
  id: string;
  user_id: string;
  name: string;
  role: string;
  avatar_url: string | null;
  is_active: boolean;
  unhealthy?: boolean;
  last_heartbeat_at?: string | null;
  last_mcp_call_at?: string | null;
  pending_action_count?: number;
};

type Space = {
  id: string;
  name: string;
  type: string;
  description: string | null;
  is_default: boolean;
  is_muted?: boolean;
  member_ids?: string[];
};

type Project = {
  id: string;
  name: string;
  prefix: string;
  color: string | null;
  task_counter: number;
  total_tasks: number;
  done_tasks: number;
};

const navItems = [
  { name: 'Chat', href: '/chat', icon: MessageSquare },
  { name: 'Tasks', href: '/tasks', icon: CheckSquare },
  { name: 'Knowledge', href: '/knowledge', icon: BookOpen },
  { name: 'Calendar', href: '/calendar', icon: CalendarDays },
  { name: 'Notes', href: '/notes', icon: FileText },
  { name: 'Inbox', href: '/inbox', icon: Inbox },
];

// ── Chat sidebar content (Spaces + DMs) ──────────────────────────────
function ChatSidebarContent({
  spaces,
  activeSpaceId,
  onSpaceClick,
  presence,
  onOpenCreateSpace,
}: {
  spaces: Space[];
  activeSpaceId: string | null;
  onSpaceClick: (id: string) => void;
  presence: Map<string, 'online' | 'idle' | 'offline'>;
  onOpenCreateSpace: () => void;
}) {
  const { user } = useAuth();
  const { unreadCounts, mentionCounts, orgMembers, openDmWith, activeHuddles, joinHuddleBySpace } = useChatContext();
  const pathname = usePathname();
  const router = useRouter();
  const [createDmOpen, setCreateDmOpen] = useState(false);
  const [agentEmployees, setAgentEmployees] = useState<AgentEmployee[]>([]);

  useEffect(() => {
    api.get('/api/agent-employees?expand=stats').then(async (res) => {
      if (res.ok) {
        setAgentEmployees(await res.json());
      }
    });
  }, []);

  const agentStatusColor = (employee: AgentEmployee) => {
    if (!employee.is_active || employee.unhealthy) return 'var(--outline)';
    const lastContact = employee.last_mcp_call_at ?? employee.last_heartbeat_at;
    if (!lastContact) return 'var(--status-amber)';
    const elapsedMinutes = Math.floor((Date.now() - new Date(lastContact).getTime()) / 60000);
    return elapsedMinutes < 15 ? 'var(--status-green)' : 'var(--status-amber)';
  };

  const publicSpaces = spaces.filter((s) => s.type === 'public' || s.type === 'private');
  const dmSpaces = spaces.filter((s) => s.type === 'dm' || s.type === 'group_dm');
  const handleSpaceLinkClick = (event: ReactMouseEvent<HTMLAnchorElement>, id: string) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    onSpaceClick(id);
  };

  return (
    <>
      {/* Spaces */}
      <div className="px-3 pt-5 pb-1">
        <div className="flex items-center justify-between px-2 mb-2">
          <span
            className="text-[0.6875rem] font-semibold uppercase tracking-[0.05em]"
            style={{ color: 'var(--outline)' }}
          >
            Spaces
          </span>
          <button
            onClick={onOpenCreateSpace}
            className="p-0.5 rounded"
            style={{ color: 'var(--outline)' }}
            title="Create space"
          >
            <Plus size={13} strokeWidth={1.5} />
          </button>
        </div>
        {publicSpaces.map((space) => {
          const active = activeSpaceId === space.id && pathname.startsWith('/chat');
          const unread = unreadCounts.get(space.id) || 0;
          const mentions = mentionCounts.get(space.id) || 0;
          const hasUnread = unread > 0;
          const hasMentions = mentions > 0;

          return (
            <div key={space.id} className="relative">
              <Link
                href={`/chat?space=${space.id}`}
                onClick={(event) => handleSpaceLinkClick(event, space.id)}
                className="w-full text-left px-2 flex items-center gap-1.5 relative min-h-[44px] md:min-h-0 md:h-8"
                style={{
                  background: active ? 'var(--bg-active)' : 'transparent',
                  color: active ? 'var(--on-surface)' : hasUnread ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                  fontWeight: active ? 500 : hasUnread ? 600 : 500,
                  fontSize: '0.8125rem',
                  borderRadius: 'var(--radius-lg)',
                  paddingRight: activeHuddles.has(space.id) ? '3rem' : undefined,
                }}
              >
                <Hash
                  size={14}
                  strokeWidth={1.5}
                  className="flex-shrink-0"
                  style={{ opacity: active ? 0.7 : 0.4 }}
                />
                <span className="truncate flex-1">{space.name}</span>
                {space.is_muted && (
                  <BellOff size={10} className="flex-shrink-0" style={{ color: 'var(--outline)', opacity: 0.5 }} />
                )}
                {hasMentions ? (
                  <div
                    className="min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-white px-1 flex-shrink-0"
                    style={{ background: 'var(--primary-container)' }}
                  >
                    {mentions}
                  </div>
                ) : hasUnread ? (
                  <div
                    className="min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-medium text-white px-1 flex-shrink-0"
                    style={{ background: 'var(--outline-variant)' }}
                  >
                    {unread > 99 ? '99+' : unread}
                  </div>
                ) : null}
              </Link>
              {activeHuddles.has(space.id) && (
                <button
                  onClick={(e) => { e.stopPropagation(); joinHuddleBySpace?.(space.id); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 text-[9px] font-medium flex-shrink-0 px-1.5 py-0.5 rounded-full hover:opacity-80"
                  style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}
                  title="Join huddle"
                >
                  <Headphones size={10} />
                  {activeHuddles.get(space.id)!.participants.length}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* DMs */}
      <div className="px-3 pt-5 pb-1">
        <div className="flex items-center justify-between px-2 mb-2">
          <span
            className="text-[0.6875rem] font-semibold uppercase tracking-[0.05em]"
            style={{ color: 'var(--outline)' }}
          >
            Direct Messages
          </span>
          <button
            onClick={() => setCreateDmOpen(true)}
            className="p-0.5 rounded"
            style={{ color: 'var(--outline)' }}
            title="New direct message"
          >
            <Plus size={13} strokeWidth={1.5} />
          </button>
        </div>
        {dmSpaces
          .slice()
          .sort((a, b) => {
            // Pin Defty's 1:1 DM at top
            const aHasDefty = (a.member_ids ?? []).some((id) => orgMembers.find((m) => m.id === id)?.email === 'deft-agent@system.local');
            const bHasDefty = (b.member_ids ?? []).some((id) => orgMembers.find((m) => m.id === id)?.email === 'deft-agent@system.local');
            if (a.type === 'dm' && aHasDefty && !(b.type === 'dm' && bHasDefty)) return -1;
            if (b.type === 'dm' && bHasDefty && !(a.type === 'dm' && aHasDefty)) return 1;
            // Then 1:1 DMs before group DMs
            if (a.type === 'dm' && b.type !== 'dm') return -1;
            if (b.type === 'dm' && a.type !== 'dm') return 1;
            return (a.name || '').localeCompare(b.name || '');
          })
          .map((space) => {
            const otherIds = (space.member_ids ?? []).filter((id) => id !== user?.id);
            const others = otherIds
              .map((id) => orgMembers.find((m) => m.id === id))
              .filter((m): m is NonNullable<typeof m> => Boolean(m));
            const active = activeSpaceId === space.id && pathname.startsWith('/chat');
            const unread = unreadCounts.get(space.id) || 0;
            const mentions = mentionCounts.get(space.id) || 0;
            const hasUnread = unread > 0;
            const hasMentions = mentions > 0;

            const isGroup = space.type === 'group_dm' || others.length > 1;
            const primary = others[0];
            const isAgent = !isGroup && primary && (primary.kind === 'agent' || primary.kind === 'system');
            const memberStatus = primary ? (presence.get(primary.id) || 'offline') : 'offline';

            const label = isGroup
              ? others.map((m) => m.name?.split(/\s+/)[0]).filter(Boolean).join(', ')
              : (primary?.name ?? 'Unknown');

            const initial = primary?.name?.charAt(0).toUpperCase() ?? '?';

            return (
              <Link
                key={space.id}
                href={`/chat?space=${space.id}`}
                onClick={(event) => handleSpaceLinkClick(event, space.id)}
                className="w-full text-left px-2 flex items-center gap-2 min-h-[44px] md:min-h-0 md:h-8"
                style={{
                  background: active ? 'var(--bg-active)' : 'transparent',
                  color: active ? 'var(--on-surface)' : hasUnread ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                  fontWeight: active ? 500 : hasUnread ? 600 : 500,
                  fontSize: '0.8125rem',
                  borderRadius: 'var(--radius-lg)',
                }}
              >
                <div className="relative flex-shrink-0 w-6 h-6">
                  {isGroup ? (
                    <div className="relative w-6 h-6">
                      {others.slice(0, 2).map((m, i) => (
                        m.avatar_url ? (
                          <img
                            key={m.id}
                            src={m.avatar_url}
                            alt=""
                            className="absolute w-[14px] h-[14px] rounded-full object-cover"
                            style={{
                              border: '1.5px solid var(--surface-container-low)',
                              top: i === 0 ? 0 : 'auto',
                              bottom: i === 1 ? 0 : 'auto',
                              left: i === 0 ? 0 : 'auto',
                              right: i === 1 ? 0 : 'auto',
                            }}
                          />
                        ) : (
                          <div
                            key={m.id}
                            className="absolute w-[14px] h-[14px] rounded-full flex items-center justify-center text-[8px] font-medium text-white"
                            style={{
                              background: 'var(--primary-container)',
                              border: '1.5px solid var(--surface-container-low)',
                              top: i === 0 ? 0 : 'auto',
                              bottom: i === 1 ? 0 : 'auto',
                              left: i === 0 ? 0 : 'auto',
                              right: i === 1 ? 0 : 'auto',
                            }}
                          >
                            {m.name?.charAt(0).toUpperCase() ?? '?'}
                          </div>
                        )
                      ))}
                      {others.length > 2 && (
                        <div
                          className="absolute -bottom-0.5 -right-0.5 text-[8px] font-medium"
                          style={{ color: 'var(--outline)' }}
                        >
                          +{others.length - 2}
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      {primary?.avatar_url ? (
                        <img src={primary.avatar_url} alt="" className="w-6 h-6 rounded-full object-cover" />
                      ) : (
                        <div
                          className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium text-white"
                          style={{ background: 'var(--primary-container)' }}
                        >
                          {initial}
                        </div>
                      )}
                      {!isAgent && memberStatus !== 'offline' && (
                        <div
                          className="absolute -bottom-0.5 -right-0.5 w-[10px] h-[10px] rounded-full"
                          style={{
                            background: memberStatus === 'online' ? 'var(--status-green)' : 'var(--status-amber)',
                            border: '2px solid var(--surface-container-low)',
                          }}
                        />
                      )}
                    </>
                  )}
                </div>
                <span className="truncate flex-1">{label}</span>
                {isAgent && !hasMentions && !hasUnread && (
                  <span
                    className="text-[9px] font-semibold px-1 py-0 rounded-full flex-shrink-0 leading-[16px]"
                    style={{ background: 'var(--surface-variant)', color: 'var(--on-surface-variant)' }}
                  >
                    AI
                  </span>
                )}
                {hasMentions ? (
                  <div
                    className="min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-white px-1 flex-shrink-0"
                    style={{ background: 'var(--primary-container)' }}
                  >
                    {mentions}
                  </div>
                ) : hasUnread ? (
                  <div
                    className="min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-medium text-white px-1 flex-shrink-0"
                    style={{ background: 'var(--outline-variant)' }}
                  >
                    {unread > 99 ? '99+' : unread}
                  </div>
                ) : null}
              </Link>
            );
          })}
      </div>

      {/* Agent Employees */}
      {agentEmployees.length > 0 && (
        <div className="px-3 pt-5 pb-1">
          <div className="flex items-center justify-between px-2 mb-2">
            <span
              className="text-[0.6875rem] font-semibold uppercase tracking-[0.05em]"
              style={{ color: 'var(--outline)' }}
            >
              Agent Employees
            </span>
          </div>
          {agentEmployees.map((employee) => {
            const initial = employee.name.charAt(0).toUpperCase();
            return (
              <button
                key={employee.id}
                onClick={() => openDmWith(employee.user_id)}
                className="w-full text-left px-2 flex items-center gap-2 min-h-[44px] md:min-h-0 md:h-8"
                style={{
                  background: 'transparent',
                  color: 'var(--on-surface-variant)',
                  fontWeight: 500,
                  fontSize: '0.8125rem',
                  borderRadius: 'var(--radius-lg)',
                }}
              >
                <div className="relative flex-shrink-0">
                  {employee.avatar_url ? (
                    <img src={employee.avatar_url} alt="" className="w-6 h-6 rounded-full object-cover" />
                  ) : (
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium text-white"
                      style={{ background: 'var(--primary-container)' }}
                    >
                      {initial}
                    </div>
                  )}
                  <div
                    className="absolute -bottom-0.5 -right-0.5 w-[10px] h-[10px] rounded-full"
                    style={{
                      background: agentStatusColor(employee),
                      border: '2px solid var(--surface-container-low)',
                    }}
                  />
                </div>
                <span className="truncate flex-1">{employee.name}</span>
                {(employee.pending_action_count ?? 0) > 0 && (
                  <span
                    className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0"
                    style={{ background: 'var(--surface-variant)', color: 'var(--on-surface-variant)' }}
                  >
                    {employee.pending_action_count}
                  </span>
                )}
                <span
                  className="text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded flex-shrink-0"
                  style={{
                    background: 'var(--accent-subtle, rgba(124,107,79,0.12))',
                    color: 'var(--accent)',
                    borderRadius: '4px',
                  }}
                >
                  AI
                </span>
              </button>
            );
          })}
        </div>
      )}

      {createDmOpen && typeof document !== 'undefined' && createPortal(
        <CreateDmModal onClose={() => setCreateDmOpen(false)} />,
        document.body
      )}
    </>
  );
}

// ── Tasks sidebar content (My Tasks + Projects) ──────────────────────
function TasksSidebarContent({ onNav }: { onNav?: () => void }) {
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);

  const currentView = searchParams.get('view');
  const currentProjectId = searchParams.get('project');

  useEffect(() => {
    if (!user) return;
    async function load() {
      const res = await api.get('/api/projects');
      if (res.ok) setProjects(await res.json());
    }
    load();
  }, [user]);

  const isMyTasksActive = currentView === 'my';
  const activeProjectId = currentProjectId;

  return (
    <>
      {/* My Tasks link */}
      <div className="px-3 pt-3 pb-1">
        <Link
          href="/tasks?view=my"
          onClick={onNav}
          className="w-full text-left px-2 flex items-center gap-2"
          style={{
            height: '36px',
            background: isMyTasksActive ? 'var(--bg-active)' : 'transparent',
            color: isMyTasksActive ? 'var(--on-surface)' : 'var(--on-surface-variant)',
            fontWeight: isMyTasksActive ? 500 : 500,
            fontSize: '0.8125rem',
            borderRadius: 'var(--radius-lg)',
          }}
        >
          <User size={18} strokeWidth={1.5} className="flex-shrink-0" style={{ opacity: isMyTasksActive ? 0.7 : 0.4 }} />
          <span className="truncate flex-1">My Tasks</span>
        </Link>
      </div>

      {/* Projects section */}
      <div className="px-3 pt-4 pb-1">
        <div className="flex items-center justify-between px-2 mb-2">
          <span
            className="text-[0.6875rem] font-semibold uppercase tracking-[0.05em]"
            style={{ color: 'var(--outline)' }}
          >
            Projects
          </span>
          <button
            onClick={() => setCreateProjectOpen(true)}
            className="p-0.5 rounded"
            style={{ color: 'var(--outline)' }}
            title="Create project"
          >
            <Plus size={13} strokeWidth={1.5} />
          </button>
        </div>
        {projects.map((project) => {
          const active = activeProjectId === project.id;
          return (
            <button
              key={project.id}
              onClick={() => { router.push(`/tasks?project=${project.id}`); onNav?.(); }}
              className="w-full text-left px-2 flex items-center gap-2 min-h-[44px] md:min-h-0 md:h-8"
              style={{
                background: active ? 'var(--bg-active)' : 'transparent',
                color: active ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                fontWeight: active ? 500 : 500,
                fontSize: '0.8125rem',
                borderRadius: 'var(--radius-lg)',
              }}
            >
              <div
                className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
                style={{ background: project.color || 'var(--outline)' }}
              >
                {project.prefix.charAt(0)}
              </div>
              <span className="truncate flex-1">{project.name}</span>
              <span className="text-[11px] flex-shrink-0" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
                {project.total_tasks}
              </span>
            </button>
          );
        })}
      </div>

      {createProjectOpen && typeof document !== 'undefined' && createPortal(
        <CreateProjectModal
          onClose={() => setCreateProjectOpen(false)}
          onCreated={(p) => {
            setProjects((prev) => [...prev, p]);
            setCreateProjectOpen(false);
            router.push(`/tasks?project=${p.id}`);
          }}
        />,
        document.body
      )}
    </>
  );
}

// ── Settings sidebar content ─────────────────────────────────────────
function SettingsSidebarContent({ onNav }: { onNav?: () => void }) {
  const pathname = usePathname();

  const sections = [
    { name: 'General', href: '/settings' },
    { name: 'Profile', href: '/settings/profile' },
    { name: 'Members', href: '/settings/members' },
    { name: 'Teams', href: '/settings/teams' },
    { name: 'Groups', href: '/settings/groups' },
    { name: 'Projects', href: '/settings/projects' },
    { name: 'Tags', href: '/settings/tags' },
    { name: 'Integrations', href: '/settings/integrations' },
    { name: 'AI Providers', href: '/settings/ai' },
    { name: 'Agent', href: '/settings/agent' },
    { name: 'Agent Employees', href: '/settings/agent-employees' },
    { name: 'MCP Access', href: '/settings/mcp-access' },
    { name: 'API Access', href: '/settings/api-access' },
  ];

  return (
    <div className="px-3 pt-5 pb-1">
      <div className="flex items-center px-2 mb-2">
        <span
          className="text-[0.6875rem] font-semibold uppercase tracking-[0.05em]"
          style={{ color: 'var(--outline)' }}
        >
          Settings
        </span>
      </div>
      {sections.map((section) => {
        const active = pathname === section.href;
        return (
          <Link
            key={section.href}
            href={section.href}
            onClick={onNav}
            className="w-full text-left px-2 flex items-center gap-2 block"
            style={{
              height: '36px',
              background: active ? 'var(--bg-active)' : 'transparent',
              color: active ? 'var(--on-surface)' : 'var(--on-surface-variant)',
              fontWeight: active ? 500 : 500,
              fontSize: '0.8125rem',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            <span className="truncate">{section.name}</span>
          </Link>
        );
      })}
    </div>
  );
}

// ── Main Sidebar ─────────────────────────────────────────────────────
export function Sidebar({
  spaces,
  activeSpaceId,
  onSelectSpace,
  presence,
  mobileOpen,
  setMobileOpen,
}: {
  spaces: Space[];
  activeSpaceId: string | null;
  onSelectSpace: (id: string) => void;
  presence: Map<string, 'online' | 'idle' | 'offline'>;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
}) {
  const { user, org, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { unreadCounts } = useChatContext();
  const pathname = usePathname();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  // Create-space modal lifted from ChatSidebarContent — the parent Sidebar
  // is always mounted across all routes (chat, tasks, settings…) so the
  // module-level `registerOpenCreateSpace` callback never goes stale when
  // navigating off /chat.
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
  useEffect(() => registerOpenCreateSpace(() => setCreateSpaceOpen(true)), []);
  const [savedOpen, setSavedOpen] = useState(false);
  const [dnd, setDnd] = useState(() => user?.status_text === 'Do Not Disturb');
  const userMenuRef = useRef<HTMLDivElement>(null);
  const userMenuBtnRef = useRef<HTMLButtonElement>(null);

  // Click-outside handler for three-dot menu
  useEffect(() => {
    if (!userMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [userMenuOpen]);

  // Escape-key handler for mobile drawer
  useEffect(() => {
    if (!mobileOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mobileOpen, setMobileOpen]);

  const toggleDnd = async () => {
    const next = !dnd;
    setDnd(next);
    await api.patch('/api/users/dnd', { enabled: next });
  };

  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== 'undefined') return localStorage.getItem('deft-sidebar-collapsed') === 'true';
    return false;
  });

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('deft-sidebar-collapsed', String(next));
      return next;
    });
  };

  // Total unread across all spaces
  const totalUnread = Array.from(unreadCounts.values()).reduce((sum, c) => sum + c, 0);

  // Inbox unread count (mentions, DMs, pending approvals)
  const { count: inboxCount } = useInboxCount();

  const handleSpaceClick = (id: string) => {
    onSelectSpace(id);
    setMobileOpen(false);
  };

  // Close sidebar on mobile when navigating
  const handleNav = () => {
    if (window.innerWidth < 768) setMobileOpen(false);
  };

  // Determine which content section to render
  const renderContent = () => {
    if (pathname.startsWith('/tasks')) {
      return <TasksSidebarContent onNav={handleNav} />;
    }
    if (pathname.startsWith('/notes') || pathname.startsWith('/dashboard')) {
      return null;
    }
    if (pathname.startsWith('/settings')) {
      return <SettingsSidebarContent onNav={handleNav} />;
    }
    return (
      <ChatSidebarContent
        spaces={spaces}
        activeSpaceId={activeSpaceId}
        onSpaceClick={handleSpaceClick}
        presence={presence}
        onOpenCreateSpace={() => setCreateSpaceOpen(true)}
      />
    );
  };

  const sidebarContent = (
    <>
      {/* Logo + org — no border, tonal separation */}
      <div
        className="px-4 flex items-center justify-between flex-shrink-0 safe-top"
        style={{ height: '56px' }}
      >
        <div className="flex items-center gap-2.5">
          <Link href="/dashboard" title="Dashboard" className="hover:opacity-80 transition-opacity">
            <Logo variant="wordmark" className="h-7 w-auto flex-shrink-0" priority />
          </Link>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleCollapsed}
            className="hidden md:flex p-1 rounded-md items-center justify-center"
            style={{ color: 'var(--outline)' }}
            title="Collapse sidebar"
          >
            <PanelLeftClose size={15} strokeWidth={1.5} />
          </button>
          <button
            onClick={() => setMobileOpen(false)}
            className="md:hidden p-1 rounded"
            style={{ color: 'var(--outline)' }}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Nav items — vertical list */}
      <div className="px-3 py-1 flex-shrink-0">
        {navItems.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className="relative flex items-center gap-2.5 px-2"
              style={{
                height: '36px',
                color: active ? 'var(--primary)' : 'var(--on-surface-variant)',
                background: active ? 'var(--bg-active)' : 'transparent',
                borderRadius: 'var(--radius-lg)',
                fontSize: '0.8125rem',
                fontWeight: active ? 500 : 400,
              }}
            >
              <item.icon size={18} strokeWidth={1.5} />
              <span>{item.name}</span>
              {item.name === 'Chat' && totalUnread > 0 && (
                <div
                  className="ml-auto min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-white px-1"
                  style={{ background: 'var(--primary-container)' }}
                >
                  {totalUnread > 99 ? '99+' : totalUnread}
                </div>
              )}
              {item.name === 'Inbox' && inboxCount > 0 && (
                <div
                  className="ml-auto min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-white px-1"
                  style={{ background: 'var(--danger, #ef4444)' }}
                  title={`${inboxCount} unread item${inboxCount === 1 ? '' : 's'}`}
                >
                  {inboxCount > 99 ? '99+' : inboxCount}
                </div>
              )}
            </Link>
          );
        })}
      </div>

      {/* Scrollable content area — contextual based on pathname */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {renderContent()}
      </div>

      {/* Bottom user section — no border, tonal separation */}
      <div
        className="px-3 flex items-center gap-2 flex-shrink-0 pb-[max(env(safe-area-inset-bottom),12px)]"
        style={{
          height: '56px',
          background: 'rgba(0,0,0,0.08)',
        }}
      >
        <div className="relative flex-shrink-0">
          {user?.avatar_url ? (
            <img src={user.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" />
          ) : (
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-medium text-white"
              style={{ background: 'var(--primary-container)' }}
            >
              {user?.name?.charAt(0).toUpperCase()}
            </div>
          )}
          <div
            className="absolute -bottom-0.5 -right-0.5 w-[10px] h-[10px] rounded-full"
            style={{ background: 'var(--status-green)', border: '2px solid var(--surface-container-low)' }}
          />
        </div>
        <button onClick={() => setStatusModalOpen(true)} className="flex-1 min-w-0 text-left">
          <span
            className="text-[0.8125rem] font-medium truncate block"
            style={{ color: 'var(--on-surface)' }}
          >
            {user?.name}
            {user?.status_emoji && (
              <span className="text-[14px] ml-1">{user.status_emoji}</span>
            )}
          </span>
          <span
            className="text-[0.6875rem] block"
            style={{ color: 'var(--status-green)' }}
          >
            Online
          </span>
        </button>

        <div ref={userMenuRef}>
          <button
            ref={userMenuBtnRef}
            className="p-1.5 rounded-md"
            style={{ color: 'var(--outline)' }}
            title="More options"
            onClick={(e) => { e.stopPropagation(); setUserMenuOpen(!userMenuOpen); }}
          >
            <MoreHorizontal size={15} strokeWidth={1.5} />
          </button>
          {userMenuOpen && typeof document !== 'undefined' && createPortal(
            <div
              className="fixed w-48 py-1 rounded-lg z-[100]"
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                background: 'var(--surface-container-highest)',
                boxShadow: 'var(--glass-shadow)',
                bottom: `${window.innerHeight - (userMenuBtnRef.current?.getBoundingClientRect().top ?? 0) + 8}px`,
                left: `${(userMenuBtnRef.current?.getBoundingClientRect().right ?? 0) + 8}px`,
              }}
            >
              {/* Status display / set */}
              {user?.status_emoji ? (
                <div className="px-3 py-1.5 flex items-center gap-2 text-[12px]"
                  style={{ color: 'var(--on-surface-variant)' }}>
                  <span>{user.status_emoji}</span>
                  <span className="flex-1 truncate">{user.status_text || ''}</span>
                  <button onClick={async () => {
                    await api.delete('/api/users/status');
                    setUserMenuOpen(false);
                  }} className="text-[10px] px-1.5 py-0.5 rounded hover:opacity-70"
                    style={{ color: 'var(--text-tertiary)' }}>Clear</button>
                </div>
              ) : null}
              <button onClick={() => { setUserMenuOpen(false); setStatusModalOpen(true); }}
                className="flex items-center gap-2 px-3 py-1.5 text-[12px] w-full text-left rounded-md hover:opacity-80"
                style={{ color: 'var(--on-surface-variant)' }}>
                <Smile size={14} strokeWidth={1.5} /> Set status
              </button>
              <button onClick={() => { setUserMenuOpen(false); setSavedOpen(true); }}
                className="flex items-center gap-2 px-3 py-1.5 text-[12px] w-full text-left rounded-md hover:opacity-80"
                style={{ color: 'var(--on-surface-variant)' }}>
                <Bookmark size={14} strokeWidth={1.5} /> Saved messages
              </button>
              <button onClick={() => { toggleDnd(); setUserMenuOpen(false); }}
                className="flex items-center gap-2 px-3 py-1.5 text-[12px] w-full text-left rounded-md hover:opacity-80"
                style={{ color: dnd ? 'var(--status-amber)' : 'var(--on-surface-variant)' }}>
                {dnd ? <BellOff size={14} strokeWidth={1.5} /> : <Bell size={14} strokeWidth={1.5} />}
                {dnd ? 'Disable Do Not Disturb' : 'Do Not Disturb'}
              </button>
              <button onClick={() => { toggleTheme(); setUserMenuOpen(false); }}
                className="flex items-center gap-2 px-3 py-1.5 text-[12px] w-full text-left rounded-md hover:opacity-80"
                style={{ color: 'var(--on-surface-variant)' }}>
                {theme === 'dark' ? <Sun size={14} strokeWidth={1.5} /> : <Moon size={14} strokeWidth={1.5} />}
                {theme === 'dark' ? 'Light mode' : 'Dark mode'}
              </button>
              <div className="my-1" style={{ borderTop: '1px solid var(--ghost-border)' }} />
              <Link href="/settings" onClick={() => setUserMenuOpen(false)}
                className="flex items-center gap-2 px-3 py-1.5 text-[12px] w-full text-left rounded-md hover:opacity-80"
                style={{ color: 'var(--on-surface-variant)' }}>
                <Settings size={14} strokeWidth={1.5} /> Settings
              </Link>
              <button onClick={() => { setUserMenuOpen(false); logout(); }}
                className="flex items-center gap-2 px-3 py-1.5 text-[12px] w-full text-left rounded-md hover:opacity-80"
                style={{ color: 'var(--status-red)' }}>
                <LogOut size={14} strokeWidth={1.5} /> Log out
              </button>
            </div>,
            document.body
          )}
        </div>
      </div>
      {statusModalOpen && <StatusModal onClose={() => setStatusModalOpen(false)} />}
      {savedOpen && <SavedMessages onClose={() => setSavedOpen(false)} />}
    </>
  );

  const collapsedContent = (
    <div className="flex flex-col h-full items-center py-3 gap-1">
      {/* Logo (collapsed) */}
      <Link href="/dashboard" title="Dashboard" className="hover:opacity-80 transition-opacity">
        <Logo variant="icon" className="w-8 h-8 mb-2 flex-shrink-0" />
      </Link>


      {/* Nav icons */}
      {navItems.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} title={item.name}
            className="w-9 h-9 flex items-center justify-center rounded-lg"
            style={{
              background: active ? 'var(--bg-active)' : 'transparent',
              color: active ? 'var(--primary)' : 'var(--outline)',
            }}>
            <item.icon size={18} strokeWidth={1.5} />
          </Link>
        );
      })}

      <div className="flex-1" />

      {/* Expand button */}
      <button onClick={toggleCollapsed} title="Expand sidebar"
        className="w-9 h-9 flex items-center justify-center rounded-lg"
        style={{ color: 'var(--outline)' }}>
        <PanelLeftOpen size={16} strokeWidth={1.5} />
      </button>

      {/* User avatar */}
      {user?.avatar_url ? (
        <img src={user.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" />
      ) : (
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium text-white"
          style={{ background: 'var(--primary-container)' }}>
          {user?.name?.charAt(0).toUpperCase()}
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar — NO borderRight, tonal layering only */}
      <aside
        role={mobileOpen ? 'dialog' : undefined}
        aria-modal={mobileOpen ? 'true' : undefined}
        aria-label={mobileOpen ? 'Navigation' : undefined}
        className={`
          fixed md:relative z-[70] md:z-auto
          h-full flex flex-col
          md:translate-x-0
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}
        style={{
          width: collapsed ? '48px' : '240px',
          background: 'var(--surface-container-low)',
          transitionProperty: 'transform, width',
          transitionDuration: '200ms',
          transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
          overflow: 'hidden',
          paddingLeft: 'env(safe-area-inset-left)',
        }}
      >
        {collapsed ? collapsedContent : sidebarContent}
      </aside>
      {createSpaceOpen && typeof document !== 'undefined' && createPortal(
        <CreateSpaceModal onClose={() => setCreateSpaceOpen(false)} />,
        document.body
      )}
    </>
  );
}

function StatusModal({ onClose }: { onClose: () => void }) {
  const [emoji, setEmoji] = useState('');
  const [text, setText] = useState('');
  const [expiresIn, setExpiresIn] = useState<number | null>(null);

  const presets = [
    { emoji: '\u{1F3E0}', text: 'Working remotely', expires: null },
    { emoji: '\u{1F37D}\u{FE0F}', text: 'On lunch \u2014 back soon', expires: 30 },
    { emoji: '\u{1F3D6}\u{FE0F}', text: 'On vacation', expires: null },
    { emoji: '\u{1F3AF}', text: 'Heads down \u2014 do not disturb', expires: null },
    { emoji: '\u{1F912}', text: 'Out sick', expires: null },
  ];

  const save = async () => {
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 60000).toISOString() : null;
    await api.patch('/api/users/status', { emoji: emoji || null, text: text || null, expires_at: expiresAt });
    onClose();
  };

  const clear = async () => {
    await api.delete('/api/users/status');
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[calc(100vw-2rem)] max-w-[360px] max-h-[90vh] overflow-y-auto p-5 rounded-xl" style={{ background: 'var(--surface-container)', boxShadow: 'var(--glass-shadow)' }}>
        <h3 className="text-[0.875rem] font-semibold mb-4" style={{ color: 'var(--on-surface)' }}>Set your status</h3>

        <div className="flex gap-2 mb-3">
          <input value={emoji} onChange={e => setEmoji(e.target.value)} placeholder="\u{1F600}" maxLength={2}
            className="w-12 h-10 text-center text-[18px] rounded-lg outline-none"
            style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }} />
          <input value={text} onChange={e => setText(e.target.value)} placeholder="What's your status?"
            className="flex-1 h-10 px-3 text-[0.8125rem] rounded-lg outline-none"
            style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }} />
        </div>

        <div className="space-y-1 mb-4">
          {presets.map(p => (
            <button key={p.text} onClick={() => { setEmoji(p.emoji); setText(p.text); setExpiresIn(p.expires); }}
              className="w-full text-left px-3 py-1.5 rounded-md text-[0.75rem]"
              style={{ color: 'var(--on-surface-variant)' }}>
              {p.emoji} {p.text}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <button onClick={save} className="flex-1 h-9 text-[0.8125rem] font-medium text-white rounded-lg"
            style={{ background: 'var(--primary-container)' }}>Save</button>
          <button onClick={clear} className="px-4 h-9 text-[0.8125rem] rounded-lg"
            style={{ color: 'var(--outline)' }}>Clear</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
