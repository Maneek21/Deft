export type SettingsNavItem = {
  name: string;
  href: string;
  description: string;
};

export type SettingsNavGroup = {
  label: string;
  description: string;
  items: SettingsNavItem[];
};

export const settingsNavGroups: SettingsNavGroup[] = [
  {
    label: 'Personal',
    description: 'Your profile, identity, availability, and display preferences.',
    items: [
      { name: 'General', href: '/settings', description: 'Theme and top-level settings overview.' },
      { name: 'Profile', href: '/settings/profile', description: 'Work identity, avatar, status, notifications, and password.' },
    ],
  },
  {
    label: 'Workspace',
    description: 'People, teams, mention groups, and shared workspace context.',
    items: [
      { name: 'Members', href: '/settings/members', description: 'Invite people, recover accounts, and manage access.' },
      { name: 'Teams', href: '/settings/teams', description: 'Organize people around operating teams and linked work.' },
      { name: 'Groups', href: '/settings/groups', description: 'Lightweight mention lists for chat coordination.' },
      { name: 'Calendar', href: '/settings/calendar', description: 'Connect calendars with self-hostable ICS feeds.' },
      { name: 'Tags', href: '/settings/tags', description: 'Review workspace labels and usage counts.' },
    ],
  },
  {
    label: 'Work System',
    description: 'Reusable work patterns, archived projects, and workflow automation.',
    items: [
      { name: 'Deleted projects', href: '/settings/projects', description: 'Restore recently deleted projects during the recovery window.' },
      { name: 'Workflows', href: '/settings/workflows', description: 'Automate simple task status-change rules.' },
      { name: 'Templates', href: '/settings/library', description: 'Reusable task templates and work packs.' },
      { name: 'Integrations', href: '/settings/integrations', description: 'Connect tool servers and supported workspace feeds.' },
    ],
  },
  {
    label: 'Agents & AI',
    description: 'AI providers, shared agent employees, and personal AI app access.',
    items: [
      { name: 'AI Providers', href: '/settings/ai', description: 'Bring your own model providers or local endpoints.' },
      { name: 'Agent Employees', href: '/settings/agent-employees', description: 'Manage shared agents that act as workspace employees.' },
      { name: 'MCP Access', href: '/settings/mcp-access', description: 'Connect Codex, Claude, ChatGPT, or any MCP client as you.' },
      { name: 'Agent governance', href: '/settings/agent', description: 'Review agent trust level, activity, and pending action history.' },
    ],
  },
  {
    label: 'Developer',
    description: 'Programmatic access for custom tools and internal systems.',
    items: [
      { name: 'API Access', href: '/settings/api-access', description: 'Create API keys for external services and scripts.' },
    ],
  },
];

export const settingsNavItems = settingsNavGroups.flatMap((group) => group.items);

export function isSettingsItemActive(pathname: string, href: string) {
  if (href === '/settings') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
