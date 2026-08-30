export type SettingsRole = 'owner' | 'admin' | 'member' | 'guest';

export type SettingsNavItem = {
  name: string;
  href: string;
  description: string;
  roles?: SettingsRole[];
};

export type SettingsNavGroup = {
  label: string;
  description: string;
  advanced?: boolean;
  items: SettingsNavItem[];
};

const ADMIN_ROLES: SettingsRole[] = ['owner', 'admin'];

export const settingsNavGroups: SettingsNavGroup[] = [
  {
    label: 'Account',
    description: 'Your workspace preferences and identity.',
    items: [
      { name: 'General', href: '/settings', description: 'Theme and settings overview.' },
      { name: 'Profile', href: '/settings/profile', description: 'Identity, status, notifications, and security.' },
      { name: 'License & source', href: '/license', description: 'View Deft\'s AGPL license and Corresponding Source.' },
    ],
  },
  {
    label: 'Workspace',
    description: 'People, teams, and shared time.',
    items: [
      { name: 'People', href: '/settings/members', description: 'Invite people and manage workspace access.', roles: ADMIN_ROLES },
      { name: 'Teams', href: '/settings/teams', description: 'Organize people around ownership and linked work.', roles: ADMIN_ROLES },
      ...(APPS_ENABLED ? [{ name: 'Apps', href: '/settings/apps', description: 'Install and govern workspace Apps.', roles: ADMIN_ROLES }] : []),
      { name: 'Modules', href: '/settings/modules', description: 'Install and govern workspace modules.', roles: ADMIN_ROLES },
      { name: 'Calendar', href: '/settings/calendar', description: 'Connect calendars with self-hostable ICS feeds.' },
    ],
  },
  {
    label: 'AI & Connections',
    description: 'Shared agents and personal AI apps.',
    items: [
      { name: 'Agent employees', href: '/settings/agent-employees', description: 'Manage agents that work alongside the team.', roles: ADMIN_ROLES },
      { name: 'Connections', href: '/settings/mcp-access', description: 'Connect Codex, Claude, ChatGPT, or another MCP client.' },
    ],
  },
  {
    label: 'Advanced',
    description: 'Specialist workspace, automation, AI, and developer controls.',
    advanced: true,
    items: [
      { name: 'Mention groups', href: '/settings/groups', description: 'Reusable @mention lists for chat.', roles: ADMIN_ROLES },
      { name: 'Tags', href: '/settings/tags', description: 'Review workspace labels and usage counts.', roles: ADMIN_ROLES },
      { name: 'Task templates', href: '/settings/library', description: 'Reusable task templates and work packs.', roles: ADMIN_ROLES },
      { name: 'Automations', href: '/settings/workflows', description: 'Task status-change rules.', roles: ADMIN_ROLES },
      { name: 'Project recovery', href: '/settings/projects', description: 'Restore recently deleted projects.', roles: ADMIN_ROLES },
      { name: 'Agent tool servers', href: '/settings/integrations', description: 'External MCP tools available to agents.', roles: ADMIN_ROLES },
      { name: 'AI providers', href: '/settings/ai', description: 'Model providers and local endpoints.', roles: ADMIN_ROLES },
      { name: 'Agent governance', href: '/settings/agent', description: 'Workspace trust defaults, activity, and audit.', roles: ADMIN_ROLES },
      { name: 'API access', href: '/settings/api-access', description: 'Service keys for scripts and runtimes.', roles: ADMIN_ROLES },
    ],
  },
];

export function getSettingsNavGroups(role?: SettingsRole | null): SettingsNavGroup[] {
  return settingsNavGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.roles || !role || item.roles.includes(role)),
    }))
    .filter((group) => group.items.length > 0);
}

export const settingsNavItems = settingsNavGroups.flatMap((group) => group.items);

export function isSettingsItemActive(pathname: string, href: string) {
  if (href === '/settings') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
import { APPS_ENABLED } from './feature-flags';
