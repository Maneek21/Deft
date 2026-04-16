/**
 * Phase 8 — Capability pack catalog.
 *
 * A capability pack is a named bundle of tools that can be attached to an
 * OpenClaw employee during deployment. Packs fall into three layers per
 * §4.6 of the agentic vision plan:
 *
 *   - Layer 1 (Deft MCP server): `deft-workspace`, `google-calendar`
 *   - Layer 2 (OpenClaw native plugins): `web-browsing`, `shell-exec`
 *   - Layer 3 (External MCP servers): `tavily`, `github`
 *
 * The wizard renders this catalog as a checklist in step 2. Packs marked
 * `user_provides_secret` prompt the user for a credential during the flow;
 * those credentials get baked into the generated `openclaw.json` env vars.
 *
 * Extending: add new packs by appending to `CAPABILITY_PACKS`. The wizard
 * will pick up any new entries on next render.
 */

export type CapabilityPack = {
  slug: string;
  display_name: string;
  description: string;
  /** True = always added to the deployment; checkbox disabled in wizard. */
  is_always_on: boolean;
  /** Which template layer this pack targets. Purely informational. */
  layer: 1 | 2 | 3;
  /** Environment variable name the container expects (if user_provides_secret). */
  provider_env_var?: string;
  /** If true, wizard step 2 asks the user for a credential. */
  user_provides_secret: boolean;
  /** Layer 3 — external MCP server wiring. */
  mcp_server_config?: {
    url: string;
    transport: 'streamable-http' | 'sse' | 'stdio';
    headers_template: Record<string, string>;
  };
  /** Layer 2 — OpenClaw native plugin name (enables it in plugins.entries). */
  openclaw_plugin?: string;
  /** Whether the pack is shipping in v1 or is "Coming Soon" UI-disabled. */
  coming_soon?: boolean;
};

export const CAPABILITY_PACKS: CapabilityPack[] = [
  {
    slug: 'deft-workspace',
    display_name: 'Deft Workspace',
    description:
      "Your org's wiki, tasks, messages, members, and events via Deft's native MCP server. Required for every deployment.",
    is_always_on: true,
    layer: 1,
    user_provides_secret: false,
    mcp_server_config: {
      // Placeholder: overridden at deploy time with NEXT_PUBLIC_API_URL so
      // the wizard can swap http://host.docker.internal:3001 for dev + a
      // real public URL for managed deployments.
      url: 'https://api.deft.io/api/mcp/v1',
      transport: 'streamable-http',
      headers_template: { Authorization: 'Bearer ${DEFT_MCP_TOKEN}' },
    },
  },
  {
    slug: 'web-browsing',
    display_name: 'Web Browsing',
    description:
      "OpenClaw's built-in browser plugin — navigate public URLs, take snapshots, read static HTML.",
    is_always_on: false,
    layer: 2,
    user_provides_secret: false,
    openclaw_plugin: 'browser',
  },
  {
    slug: 'tavily',
    display_name: 'Tavily Search',
    description:
      "Web research via Tavily's managed search API. Complements the built-in browser for semantic queries.",
    is_always_on: false,
    layer: 3,
    user_provides_secret: true,
    provider_env_var: 'TAVILY_API_KEY',
    mcp_server_config: {
      url: 'https://mcp.tavily.com/mcp/',
      transport: 'streamable-http',
      headers_template: { Authorization: 'Bearer ${TAVILY_API_KEY}' },
    },
  },
  {
    slug: 'github',
    display_name: 'GitHub',
    description:
      'Read PRs, issues, commits; optionally create issues. Bring your own GitHub MCP server URL + token.',
    is_always_on: false,
    layer: 3,
    user_provides_secret: true,
    provider_env_var: 'GITHUB_MCP_TOKEN',
    mcp_server_config: {
      url: 'https://api.githubcopilot.com/mcp/',
      transport: 'streamable-http',
      headers_template: { Authorization: 'Bearer ${GITHUB_MCP_TOKEN}' },
    },
  },
  {
    slug: 'google-calendar',
    display_name: 'Google Calendar',
    description:
      "Read your team's meeting schedule via Deft's existing Google Calendar integration. Uses Deft MCP — no separate credential.",
    is_always_on: false,
    layer: 1,
    user_provides_secret: false,
  },
  {
    slug: 'shell-exec',
    display_name: 'Shell Exec (Advanced)',
    description:
      "Power users only. Grants the agent access to OpenClaw's exec plugin for running shell commands on the VPS. Use for DevOps and on-call roles only.",
    is_always_on: false,
    layer: 2,
    user_provides_secret: false,
    openclaw_plugin: 'exec',
  },
  // ─── Coming soon — disabled in wizard UI ─────────────────────────
  {
    slug: 'gmail',
    display_name: 'Gmail',
    description: 'Read and draft emails. Coming in a future release.',
    is_always_on: false,
    layer: 3,
    user_provides_secret: true,
    coming_soon: true,
  },
  {
    slug: 'slack',
    display_name: 'Slack',
    description: 'Post messages, read channels. Coming in a future release.',
    is_always_on: false,
    layer: 3,
    user_provides_secret: true,
    coming_soon: true,
  },
  {
    slug: 'linear',
    display_name: 'Linear',
    description: 'Read issues and cycles. Coming in a future release.',
    is_always_on: false,
    layer: 3,
    user_provides_secret: true,
    coming_soon: true,
  },
  {
    slug: 'notion',
    display_name: 'Notion',
    description: 'Read pages and databases. Coming in a future release.',
    is_always_on: false,
    layer: 3,
    user_provides_secret: true,
    coming_soon: true,
  },
  {
    slug: 'playwright-mcp',
    display_name: 'Playwright MCP',
    description: 'Full browser automation via Playwright. Coming in a future release.',
    is_always_on: false,
    layer: 3,
    user_provides_secret: false,
    coming_soon: true,
  },
  {
    slug: 'pagerduty',
    display_name: 'PagerDuty',
    description: 'Incident triage. Coming in a future release.',
    is_always_on: false,
    layer: 3,
    user_provides_secret: true,
    coming_soon: true,
  },
  {
    slug: 'figma',
    display_name: 'Figma',
    description: 'Design file reads. Coming in a future release.',
    is_always_on: false,
    layer: 3,
    user_provides_secret: true,
    coming_soon: true,
  },
  {
    slug: 'stripe',
    display_name: 'Stripe',
    description: 'Billing reads. Coming in a future release.',
    is_always_on: false,
    layer: 3,
    user_provides_secret: true,
    coming_soon: true,
  },
  {
    slug: 'cloudflare',
    display_name: 'Cloudflare',
    description: 'Workers + DNS. Coming in a future release.',
    is_always_on: false,
    layer: 3,
    user_provides_secret: true,
    coming_soon: true,
  },
];

/**
 * Default capability pack per first-party role template.
 *
 * @deprecated Phase 4 Task 4.4 — canonical home for capability packs is now
 * the `agent_employee_skills` junction (bundled skills seeded by
 * `seed-bundled-skills.ts`). The deploy flow and agent-capability loader
 * read packs via that junction, unioned with the legacy
 * `agent_employees.capability_packs[]` column during the transitional
 * dual-read window. This map survives only as a last-resort fallback for
 * template rows that pre-date migration 0016. Task 4.12 removes both this
 * map and the legacy inline column once every environment is re-seeded.
 *
 * Historical note: Phase 9 (migration 0016) moved the template defaults
 * into `agent_employee_templates.default_capability_packs`. The values
 * here are aligned with the §17 catalog.
 */
export const TEMPLATE_DEFAULT_PACKS: Record<string, string[]> = {
  'alex-pm': ['deft-workspace', 'web-browsing', 'tavily', 'github', 'google-calendar'],
  designer: ['deft-workspace', 'web-browsing', 'tavily'],
  qa: ['deft-workspace', 'web-browsing', 'github'],
  cs: ['deft-workspace', 'web-browsing'],
  community: ['deft-workspace', 'web-browsing', 'tavily'],
  'on-call': ['deft-workspace', 'web-browsing', 'tavily', 'github', 'shell-exec'],
  cfo: ['deft-workspace', 'google-calendar'],
  devops: ['deft-workspace', 'web-browsing', 'github', 'shell-exec'],
};

export function getCapabilityPack(slug: string): CapabilityPack | undefined {
  return CAPABILITY_PACKS.find((p) => p.slug === slug);
}

export function getAvailableCapabilityPacks(): CapabilityPack[] {
  return CAPABILITY_PACKS.filter((p) => !p.coming_soon);
}
