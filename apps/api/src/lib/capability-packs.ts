/**
 * Capability pack catalog.
 *
 * A capability pack is a named bundle of tools that can be attached to a
 * BYOA agent during deployment. Packs fall into two layers:
 *
 *   - Layer 1 (Deft MCP server): `deft-workspace`, `google-calendar`
 *   - Layer 3 (External MCP servers): `tavily`
 *
 * The wizard renders this catalog as a checklist in step 2. Packs marked
 * `user_provides_secret` prompt the user for a credential during the flow;
 * those credentials get baked into the agent's env vars.
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
  layer: 1 | 3;
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
    slug: 'google-calendar',
    display_name: 'Calendar',
    description:
      "Read your team's meeting schedule from Deft's native calendar and imported ICS feeds. Uses Deft MCP with no separate credential.",
    is_always_on: false,
    layer: 1,
    user_provides_secret: false,
  },
  // ─── Coming soon — disabled in wizard UI ─────────────────────────
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

// Task 4.12 — `TEMPLATE_DEFAULT_PACKS` hashmap removed. Per-template
// default capability packs are now the authoritative DB column
// `agent_employee_templates.default_capability_packs` (seeded by
// seed-templates.ts, introduced in migration 0016). Envs with pre-0016
// template rows must run seed-templates.ts before wizard deploy.

export function getCapabilityPack(slug: string): CapabilityPack | undefined {
  return CAPABILITY_PACKS.find((p) => p.slug === slug);
}

export function getAvailableCapabilityPacks(): CapabilityPack[] {
  return CAPABILITY_PACKS.filter((p) => !p.coming_soon);
}
