'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@/lib/auth-context';
import { useChatContext } from '@/lib/chat-context';
import { useTheme } from './theme-provider';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/time';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  LayoutDashboard,
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
  Library,
} from 'lucide-react';
import { CreateSpaceModal } from './create-space-modal';
import { CreateDmModal } from './create-dm-modal';
import { SavedMessages } from './saved-messages';
import { CreateProjectModal } from './create-project-modal';

type AgentEmployee = {
  id: string;
  user_id: string;
  name: string;
  role: string;
  avatar_url: string | null;
  is_active: boolean;
};

type Space = {
  id: string;
  name: string;
  type: string;
  description: string | null;
  is_default: boolean;
  is_muted?: boolean;
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
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Notes', href: '/notes', icon: FileText },
  { name: 'Calendar', href: '/calendar', icon: CalendarDays },
  { name: 'Chat', href: '/chat', icon: MessageSquare },
  { name: 'Tasks', href: '/tasks', icon: CheckSquare },
  { name: 'Knowledge', href: '/knowledge', icon: BookOpen },
  { name: 'Agent', href: '/agent', icon: Bot },
  { name: 'Library', href: '/library', icon: Library },
  { name: 'Settings', href: '/settings', icon: Settings },
];

// ── Chat sidebar content (Spaces + DMs) ──────────────────────────────
function ChatSidebarContent({
  spaces,
  activeSpaceId,
  onSpaceClick,
  presence,
}: {
  spaces: Space[];
  activeSpaceId: string | null;
  onSpaceClick: (id: string) => void;
  presence: Map<string, 'online' | 'idle' | 'offline'>;
}) {
  const { user } = useAuth();
  const { unreadCounts, mentionCounts, orgMembers, openDmWith, activeHuddles, joinHuddleBySpace } = useChatContext();
  const pathname = usePathname();
  const router = useRouter();
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
  const [agentEmployees, setAgentEmployees] = useState<AgentEmployee[]>([]);

  useEffect(() => {
    api.get('/api/agent-employees').then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        setAgentEmployees(data.filter((e: AgentEmployee) => e.is_active));
      }
    });
  }, []);

  const publicSpaces = spaces.filter((s) => s.type === 'public' || s.type === 'private');
  const dmSpaces = spaces.filter((s) => s.type === 'dm' || s.type === 'group_dm');

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
            onClick={() => setCreateSpaceOpen(true)}
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
            <button
              key={space.id}
              onClick={() => onSpaceClick(space.id)}
              className="w-full text-left px-2 flex items-center gap-1.5 relative"
              style={{
                height: '32px',
                background: active ? 'var(--bg-active)' : 'transparent',
                color: active ? 'var(--on-surface)' : hasUnread ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                fontWeight: active ? 500 : hasUnread ? 600 : 500,
                fontSize: '0.8125rem',
                borderRadius: 'var(--radius-lg)',
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
              {activeHuddles.has(space.id) && (
                <button
                  onClick={(e) => { e.stopPropagation(); joinHuddleBySpace?.(space.id); }}
                  className="flex items-center gap-1 text-[9px] font-medium flex-shrink-0 px-1.5 py-0.5 rounded-full hover:opacity-80"
                  style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}
                  title="Join huddle"
                >
                  <Headphones size={10} />
                  {activeHuddles.get(space.id)!.participants.length}
                </button>
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
            </button>
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
        </div>
        {orgMembers
          .filter((m) => m.id !== user?.id)
          .filter((m) => !agentEmployees.some((e) => e.user_id === m.id))
          .map((member) => {
            const dmSpace = dmSpaces.find((s) => {
              const names = s.name.split(',').map((n) => n.trim());
              return names.includes(member.name);
            });
            const active = dmSpace ? activeSpaceId === dmSpace.id && pathname.startsWith('/chat') : false;
            const unread = dmSpace ? unreadCounts.get(dmSpace.id) || 0 : 0;
            const mentions = dmSpace ? mentionCounts.get(dmSpace.id) || 0 : 0;
            const hasUnread = unread > 0;
            const hasMentions = mentions > 0;
            const initial = member.name.charAt(0).toUpperCase();
            const memberStatus = presence.get(member.id) || 'offline';

            const handleClick = () => {
              if (dmSpace) {
                onSpaceClick(dmSpace.id);
              } else {
                openDmWith(member.id);
              }
            };

            return (
              <button
                key={member.id}
                onClick={handleClick}
                className="w-full text-left px-2 flex items-center gap-2"
                style={{
                  height: '32px',
                  background: active ? 'var(--bg-active)' : 'transparent',
                  color: active ? 'var(--on-surface)' : hasUnread ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                  fontWeight: active ? 500 : hasUnread ? 600 : 500,
                  fontSize: '0.8125rem',
                  borderRadius: 'var(--radius-lg)',
                }}
              >
                <div className="relative flex-shrink-0">
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium text-white"
                    style={{ background: 'var(--primary-container)' }}
                  >
                    {initial}
                  </div>
                  {memberStatus !== 'offline' && (
                    <div
                      className="absolute -bottom-0.5 -right-0.5 w-[10px] h-[10px] rounded-full"
                      style={{
                        background: memberStatus === 'online' ? 'var(--status-green)' : 'var(--status-amber)',
                        border: '2px solid var(--surface-container-low)',
                      }}
                    />
                  )}
                </div>
                <span className="truncate flex-1">{member.name}</span>
                {member.status_emoji && (
                  <span className="text-[11px] flex-shrink-0" title={member.status_text || ''}>{member.status_emoji}</span>
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
              </button>
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
                onClick={() => router.push(`/agent?employee=${employee.id}`)}
                className="w-full text-left px-2 flex items-center gap-2"
                style={{
                  height: '32px',
                  background: 'transparent',
                  color: 'var(--on-surface-variant)',
                  fontWeight: 500,
                  fontSize: '0.8125rem',
                  borderRadius: 'var(--radius-lg)',
                }}
              >
                <div className="relative flex-shrink-0">
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium text-white"
                    style={{ background: 'var(--primary-container)' }}
                  >
                    {initial}
                  </div>
                  <div
                    className="absolute -bottom-0.5 -right-0.5 w-[10px] h-[10px] rounded-full"
                    style={{
                      background: 'var(--status-green)',
                      border: '2px solid var(--surface-container-low)',
                    }}
                  />
                </div>
                <span className="truncate flex-1">{employee.name}</span>
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

      {createSpaceOpen && typeof document !== 'undefined' && createPortal(
        <CreateSpaceModal onClose={() => setCreateSpaceOpen(false)} />,
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
              className="w-full text-left px-2 flex items-center gap-2"
              style={{
                height: '32px',
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

// ── Agent sidebar content ────────────────────────────────────────────
function AgentSidebarContent({ onNav }: { onNav?: () => void }) {
  const [conversations, setConversations] = useState<{id:string;title:string|null;updated_at:string;agent_employee_id?:string|null}[]>([]);
  const [agentEmployees, setAgentEmployees] = useState<AgentEmployee[]>([]);
  const [editingConvo, setEditingConvo] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const searchParams = useSearchParams();
  const router = useRouter();
  const activeConvId = searchParams.get('id');
  const activeTab = searchParams.get('employee') || 'defty';

  // relativeTime imported as formatRelative from @/lib/time

  const fetchConversations = useCallback(async () => {
    const url = activeTab === 'defty'
      ? '/api/agent/conversations'
      : `/api/agent/conversations?employee=${activeTab}`;
    const res = await api.get(url);
    if (res.ok) {
      const data = await res.json();
      const filtered = data.filter((c: any) => c.title && c.title !== 'New conversation');
      setConversations(filtered);
    }
  }, [activeTab]);

  useEffect(() => {
    fetchConversations();
    const interval = setInterval(fetchConversations, 10000);
    return () => clearInterval(interval);
  }, [fetchConversations]);

  useEffect(() => {
    const handler = () => fetchConversations();
    window.addEventListener('agent-conversation-created', handler);
    return () => window.removeEventListener('agent-conversation-created', handler);
  }, [fetchConversations]);

  useEffect(() => {
    api.get('/api/agent-employees').then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        setAgentEmployees(data.filter((e: AgentEmployee) => e.is_active));
      }
    });
  }, []);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await api.delete(`/api/agent/conversations/${id}`);
    setConversations(prev => prev.filter(c => c.id !== id));
    if (activeConvId === id) {
      router.push('/agent');
    }
  };

  return (
    <>
      <div className="px-3 pt-3 pb-1">
        <Link href={activeTab === 'defty' ? '/agent' : `/agent?employee=${activeTab}`}
          onClick={onNav}
          className="w-full flex items-center gap-2 px-2 font-medium"
          style={{
            height: '36px',
            background: 'var(--primary-container)',
            color: 'white',
            borderRadius: 'var(--radius-lg)',
            fontSize: '0.8125rem',
          }}>
          <Plus size={14} /> New conversation
        </Link>
      </div>
      <div className="px-3 pt-4 pb-1">
        <div className="flex items-center px-2 mb-2">
          <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.05em]"
            style={{ color: 'var(--outline)' }}>Conversations</span>
        </div>
        {conversations.slice(0, 10).map(conv => {
          const active = activeConvId === conv.id;
          const employee = conv.agent_employee_id
            ? agentEmployees.find(e => e.id === conv.agent_employee_id)
            : null;
          const href = employee
            ? `/agent?id=${conv.id}&employee=${employee.id}`
            : `/agent?id=${conv.id}`;
          return (
            <Link key={conv.id} href={href}
              onClick={onNav}
              className="w-full text-left px-2 flex items-center gap-2 group"
              onDoubleClick={(e) => { e.preventDefault(); setEditingConvo(conv.id); setEditTitle(conv.title || ''); }}
              style={{
                height: '32px',
                background: active ? 'var(--bg-active)' : 'transparent',
                color: active ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                fontWeight: active ? 500 : 500,
                fontSize: '0.8125rem',
                borderRadius: 'var(--radius-lg)',
              }}>
              {employee ? (
                <div
                  className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-semibold text-white flex-shrink-0"
                  style={{ background: 'var(--primary-container)' }}
                  title={employee.name}
                >
                  {employee.name[0].toUpperCase()}
                </div>
              ) : (
                <span
                  className="text-[11px] flex-shrink-0"
                  style={{ color: 'var(--accent)' }}
                  title="Defty"
                >{'\u25C7'}</span>
              )}
              {editingConvo === conv.id ? (
                <input
                  autoFocus
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      await api.patch(`/api/agent/conversations/${conv.id}`, { title: editTitle });
                      setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, title: editTitle } : c));
                      setEditingConvo(null);
                    }
                    if (e.key === 'Escape') setEditingConvo(null);
                  }}
                  onBlur={() => setEditingConvo(null)}
                  onClick={(e) => e.preventDefault()}
                  className="w-full bg-transparent text-[12px] outline-none"
                  style={{ color: 'var(--on-surface)' }}
                />
              ) : (
                <span className="truncate flex-1">{conv.title}</span>
              )}
              {editingConvo !== conv.id && (
                <>
                  <span className="text-[10px] flex-shrink-0 group-hover:hidden" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
                    {formatRelative(conv.updated_at)}
                  </span>
                  <button
                    onClick={(e) => handleDelete(conv.id, e)}
                    className="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                    style={{ color: 'var(--outline)' }}
                    title="Delete conversation">
                    <X size={12} />
                  </button>
                </>
              )}
            </Link>
          );
        })}
        {conversations.length === 0 && (
          <p className="text-[12px] text-center py-6 px-2" style={{ color: 'var(--outline)' }}>
            No conversations yet
          </p>
        )}
      </div>
    </>
  );
}

// ── Settings sidebar content ─────────────────────────────────────────
function SettingsSidebarContent({ onNav }: { onNav?: () => void }) {
  const pathname = usePathname();

  const sections = [
    { name: 'General', href: '/settings' },
    { name: 'Members', href: '/settings/members' },
    { name: 'Groups', href: '/settings/groups' },
    { name: 'Tags', href: '/settings/tags' },
    { name: 'Integrations', href: '/settings/integrations' },
    { name: 'Agent', href: '/settings/agent' },
    { name: 'Agent Employees', href: '/settings/agent-employees' },
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
    if (pathname.startsWith('/agent')) {
      return <AgentSidebarContent onNav={handleNav} />;
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
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: 'var(--primary-container)' }}
          >
            {/* Deft icon — stacked diamond shape */}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M8 1L11 5H5L8 1Z" fill="white" opacity="0.9"/>
              <path d="M8 5L12 9H4L8 5Z" fill="white" opacity="0.7"/>
              <path d="M8 9L13 14H3L8 9Z" fill="white" opacity="0.5"/>
            </svg>
          </div>
          <div>
            <h1
              className="text-[13px] font-semibold leading-tight"
              style={{ color: 'var(--on-surface)', letterSpacing: '-0.02em' }}
            >
              Deft AI
            </h1>
            <p
              className="text-[0.5625rem] font-semibold uppercase leading-tight"
              style={{ color: 'var(--outline)', letterSpacing: '0.05em' }}
            >
              The Quiet Workspace
            </p>
          </div>
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
        className="px-3 flex items-center gap-2 flex-shrink-0"
        style={{
          height: '56px',
          background: 'rgba(0,0,0,0.08)',
        }}
      >
        <div className="relative flex-shrink-0">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-medium text-white"
            style={{ background: 'var(--primary-container)' }}
          >
            {user?.name?.charAt(0).toUpperCase()}
          </div>
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
      {/* Logo */}
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center mb-2 flex-shrink-0"
        style={{ background: 'var(--primary-container)' }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M8 1L11 5H5L8 1Z" fill="white" opacity="0.9"/>
          <path d="M8 5L12 9H4L8 5Z" fill="white" opacity="0.7"/>
          <path d="M8 9L13 14H3L8 9Z" fill="white" opacity="0.5"/>
        </svg>
      </div>

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
      <div className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium text-white"
        style={{ background: 'var(--primary-container)' }}>
        {user?.name?.charAt(0).toUpperCase()}
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar — NO borderRight, tonal layering only */}
      <aside
        className={`
          fixed md:relative z-50 md:z-auto
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
