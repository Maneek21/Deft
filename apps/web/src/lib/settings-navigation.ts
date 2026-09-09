import { APPS_ENABLED } from './feature-flags';

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
    label: 'Your account',
    description: 'Your identity, preferences and personal connections.',
    items: [
      { name: 'Overview', href: '/settings', description: 'Find settings and change your appearance.' },
      { name: 'Profile', href: '/settings/profile', description: 'Identity, status, notifications, and security.' },
      { name: 'Personal AI connections', href: '/settings/mcp-access', description: 'Connect Codex, Claude or another AI client acting as you.' },
      { name: 'Calendar connections', href: '/settings/calendar', description: 'Manage your external calendar subscriptions and personal Deft feed.' },
    ],
  },
  {
    label: 'Workspace',
    description: 'People and tools shared by your workspace.',
    items: [
      { name: 'People', href: '/settings/members', description: 'Invite people and manage workspace access.', roles: ADMIN_ROLES },
      { name: 'Teams', href: '/settings/teams', description: 'Manage team membership and linked work.', roles: ADMIN_ROLES },
      ...(APPS_ENABLED ? [{ name: 'Apps', href: '/settings/apps', description: 'Manage installed Apps and their access.', roles: ADMIN_ROLES }] : []),
      { name: 'Modules', href: '/settings/modules', description: 'Manage standalone Modules and collection agent access.', roles: ADMIN_ROLES },
      { name: 'Mention groups', href: '/settings/groups', description: 'Reusable @mention lists for chat; separate from team access.', roles: ADMIN_ROLES },
    ],
  },
  {
    label: 'Agents & AI',
    description: 'Shared agents, model configuration and workspace policy.',
    items: [
      { name: 'Agent employees', href: '/settings/agent-employees', description: 'Manage shared agents, their access and runtime setup.', roles: ADMIN_ROLES },
      { name: 'AI configuration', href: '/settings/ai', description: 'Configure model providers, search and voice features.', roles: ADMIN_ROLES },
      { name: 'Tool connections', href: '/settings/integrations', description: 'External MCP tool servers used by workspace agents and Apps.', roles: ADMIN_ROLES },
      { name: 'Policies & audit', href: '/settings/agent', description: 'Workspace trust defaults and action receipts.', roles: ADMIN_ROLES },
    ],
  },
  {
    label: 'Work management',
    description: 'Reusable work, task rules and recovery.',
    items: [
      { name: 'Task templates', href: '/settings/library', description: 'Reusable task sets for projects.', roles: ADMIN_ROLES },
      { name: 'Task rules', href: '/settings/workflows', description: 'Rules triggered by task status changes. App schedules live in Apps.', roles: ADMIN_ROLES },
      { name: 'Tags', href: '/settings/tags', description: 'Workspace labels and usage counts.', roles: ADMIN_ROLES },
      { name: 'Project recovery', href: '/settings/projects', description: 'Restore recently deleted projects.', roles: ADMIN_ROLES },
    ],
  },
  {
    label: 'Developer & operator',
    description: 'Service credentials and self-hosted source information.',
    advanced: true,
    items: [
      { name: 'Service API access', href: '/settings/api-access', description: 'API keys for scripts and service runtimes.', roles: ADMIN_ROLES },
      { name: 'License & source', href: '/license', description: 'AGPL license and Corresponding Source.' },
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
