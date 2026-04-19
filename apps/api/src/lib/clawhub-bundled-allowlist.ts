/**
 * Static fallback allowlist for the ClawHub browse UI — used when the remote
 * VoltAgent fetch fails (network down, GitHub unreachable) or during cold
 * boot before the daily worker has run. Hand-curated set of well-known
 * safe skills. Keep small; the remote fetcher expands it daily.
 *
 * Block 0.11 of OpenClaw Unlock plan.
 */
export const BUNDLED_ALLOWLIST: ReadonlyArray<{
  slug: string;
  description: string;
  homepage?: string;
}> = [
  { slug: 'firecrawl',            description: 'Web scraping — JS-heavy pages to clean markdown', homepage: 'https://clawhub.ai/skills/firecrawl' },
  { slug: 'gog',                  description: 'Google Workspace unified: Gmail, Calendar, Drive, Docs, Sheets' },
  { slug: 'slack',                description: 'Slack channel + DM messaging via MCP' },
  { slug: 'github',               description: 'GitHub PRs, issues, commits (read + write with token)' },
  { slug: 'linear',               description: 'Linear issues + cycles + projects' },
  { slug: 'notion',               description: 'Notion pages + databases' },
  { slug: 'sentry',               description: 'Sentry error tracking + issue queries' },
  { slug: 'stripe',               description: 'Stripe payments, subscriptions, invoices' },
  { slug: 'tavily',               description: 'Tavily managed web search' },
  { slug: 'playwright-mcp',       description: 'Playwright browser automation via MCP' },
  { slug: 'figma',                description: 'Figma files + components' },
  { slug: 'cloudflare',           description: 'Cloudflare workers, DNS, caching' },
  { slug: 'pagerduty',            description: 'PagerDuty incidents + on-call schedules' },
  { slug: 'self-improving-agent', description: 'Captures user corrections into persistent Markdown memory' },
];
