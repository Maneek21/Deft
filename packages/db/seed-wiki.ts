import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const USER_ID = 'd4f985f6-6c37-4102-a7e8-32e22cfbe962'; // Maneek

interface Page {
  slug: string;
  title: string;
  type: string;
  content: string;
  summary: string;
  confidence: number;
  scope: string;
}

const pages: Page[] = [
  // ── CONCEPTS ──
  { slug: 'monorepo-architecture', title: 'Monorepo Architecture', type: 'concept', confidence: 1.0, scope: 'org',
    summary: 'How Deft is structured as a pnpm workspace monorepo',
    content: 'Deft uses a pnpm workspace monorepo with three packages:\n- apps/web — Next.js 14 frontend\n- apps/api — Hono API server\n- packages/db — Drizzle ORM schema + migrations\n- packages/shared — shared types and constants\n\nThis structure allows shared TypeScript types across frontend and backend while keeping deployments independent.' },
  { slug: 'real-time-architecture', title: 'Real-time Architecture', type: 'concept', confidence: 0.95, scope: 'org',
    summary: 'Socket.io based real-time communication layer',
    content: 'Real-time features use Socket.io with a Redis adapter for horizontal scaling.\n\nEvents:\n- message:new, message:edited, message:deleted\n- typing:start, typing:stop\n- task:updated, task:created\n- knowledge:created, knowledge:updated\n\nThe client maintains a persistent WebSocket connection with exponential backoff reconnection. JWT tokens are validated on connection.' },
  { slug: 'multi-tenancy', title: 'Multi-tenancy Design', type: 'concept', confidence: 1.0, scope: 'org',
    summary: 'Row-level isolation with org_id on every table',
    content: 'Deft is multi-tenant from day 1. Every table has an org_id column. All queries filter by org_id.\n\nNo shared data between orgs. No cross-org queries. The auth middleware extracts org_id from the JWT and passes it to all route handlers.\n\nThis is a hard constraint — no exceptions.' },
  { slug: 'agent-observation-pipeline', title: 'Agent Observation Pipeline', type: 'concept', confidence: 0.9, scope: 'org',
    summary: 'How the AI agent observes and processes every message',
    content: 'Every message flows through a classification pipeline:\n1. Message created → classifyMessage job enqueued\n2. Haiku classifies: intent, confidence, memorable_facts, decision, blocked\n3. Based on classification:\n   - Actionable → task-extract job\n   - Blocked → blocker-alert job\n   - Has facts/decisions → memory-extract job → wiki pages\n\nThe agent never sees raw messages — it works from classified, structured data.' },
  { slug: 'knowledge-graph-system', title: 'Knowledge Graph System', type: 'concept', confidence: 0.85, scope: 'org',
    summary: 'LLM Wiki pattern for organizational knowledge management',
    content: 'The wiki implements Karpathy\'s LLM Wiki pattern:\n- Raw Sources: chat messages (immutable)\n- Wiki Layer: structured pages with types, confidence, links\n- Schema Layer: agent tools + lint rules\n\nCascade ingest: one source can update multiple pages.\nContradiction detection: daily lint job compares linked pages.\nConfidence decay: stale pages lose confidence over time.' },

  // ── ENTITIES ──
  { slug: 'anthropic-claude-api', title: 'Anthropic Claude API', type: 'entity', confidence: 1.0, scope: 'org',
    summary: 'Primary AI provider — Sonnet for reasoning, Haiku for classification',
    content: 'Deft uses Anthropic\'s Claude API as its sole AI provider.\n\n- Claude Sonnet: agent reasoning, plan generation, complex queries\n- Claude Haiku: message classification, fact extraction, wiki ingest decisions\n\nAPI key stored in ANTHROPIC_API_KEY env var. All calls go through the llm() utility in lib/llm.ts.' },
  { slug: 'postgresql-database', title: 'PostgreSQL Database', type: 'entity', confidence: 1.0, scope: 'org',
    summary: 'Primary data store with pgvector extension',
    content: 'PostgreSQL serves as the single source of truth. Uses Drizzle ORM for schema management and queries.\n\nExtensions:\n- pgvector (planned): for semantic search embeddings\n- Full-text search: tsvector columns with GIN indexes on wiki_pages\n\nDeployed via Docker using pgvector/pgvector:pg16 image in docker-compose.yml. Local dev uses same containerized approach.' },
  { slug: 'hono-framework', title: 'Hono Framework', type: 'entity', confidence: 1.0, scope: 'org',
    summary: 'Lightweight TypeScript web framework for the API',
    content: 'Hono is used for the API server. Chosen over Express for:\n- Native TypeScript support\n- Better middleware composition\n- Faster routing\n- Smaller bundle size\n\nRuns on Node.js via @hono/node-server. Supports WebSocket upgrade for Socket.io integration.' },
  { slug: 'tiptap-editor', title: 'TipTap Editor', type: 'entity', confidence: 0.9, scope: 'org',
    summary: 'Rich text editor used in chat and notes',
    content: 'TipTap provides the rich text editing experience in chat messages and notes.\n\nExtensions loaded:\n- StarterKit (bold, italic, lists, headings)\n- Link (with auto-detection)\n- Mention (@user references)\n- Code block (with syntax highlighting)\n- Placeholder\n\nImportant: Only import needed extensions to keep bundle size small.' },
  { slug: 'better-auth', title: 'better-auth Library', type: 'entity', confidence: 1.0, scope: 'org',
    summary: 'Authentication handling for email/password login with JWT + refresh tokens',
    content: 'Deft handles authentication with:\n- Email/password login with bcrypt hashing\n- JWT access tokens (15 min expiry)\n- Refresh tokens (7 day expiry)\n- First-user workspace bootstrap\n- Invite-based onboarding for later users\n\nThe auth middleware validates tokens and sets user context on every request.' },

  // ── DECISIONS ──
  { slug: 'decision-no-supabase', title: 'No Supabase', type: 'decision', confidence: 1.0, scope: 'org',
    summary: 'Supabase blocked in India — use self-hosted PostgreSQL instead',
    content: 'Decision: Do not use Supabase.\n\nReason: Supabase is blocked/unreliable in India where the core team is based. Using self-hosted PostgreSQL with Drizzle ORM gives us full control and flexibility.\n\nAlternative considered: Neon (works but adds latency, SaaS dependency). Decided on self-hosted PostgreSQL via Docker.' },
  { slug: 'decision-drizzle-orm', title: 'Use Drizzle ORM', type: 'decision', confidence: 1.0, scope: 'org',
    summary: 'All database queries must use Drizzle ORM',
    content: 'Decision: All database queries use Drizzle ORM. No raw SQL except in agent queries.\n\nReason: Type safety, consistent patterns, easier migrations.\n\nException: Agent SQL queries can use raw SQL for complex joins across native + events data where Drizzle\'s query builder is too limiting.' },
  { slug: 'decision-railway-deploy', title: 'Self-hosted Docker Deployment', type: 'decision', confidence: 1.0, scope: 'org',
    summary: 'Deft runs as self-hosted Docker with docker-compose',
    content: 'Decision: Deploy Deft as self-hosted Docker (not managed hosting).\n\nReason: Users run Deft on their own infrastructure. The API requires persistent connections (Socket.io) and background job processing, which are best managed via docker-compose on user infrastructure.\n\nStack: docker-compose with Hono API, Next.js frontend, PostgreSQL (pgvector:pg16), and Redis (redis:7-alpine) for job queue and Socket.io pub/sub.' },
  { slug: 'decision-bullmq-jobs', title: 'BullMQ for Background Jobs', type: 'decision', confidence: 0.7, scope: 'org',
    summary: 'Switched to Postgres-based job queue — BullMQ being phased out',
    content: 'Original decision: Use BullMQ with Redis for background jobs.\n\nUpdate: Migrating to a Postgres-based job queue to eliminate the Redis dependency. The job_queue table handles scheduling, retries, and dead-letter processing.\n\nBullMQ references in docs may be outdated.' },
  { slug: 'decision-sonnet-haiku-split', title: 'Sonnet for Reasoning, Haiku for Classification', type: 'decision', confidence: 1.0, scope: 'org',
    summary: 'Two-model strategy balancing cost and quality',
    content: 'Decision: Use Claude Sonnet for agent reasoning and Haiku for classification/extraction.\n\nRationale:\n- Haiku is 10x cheaper and fast enough for message classification\n- Sonnet provides the reasoning quality needed for agent plans\n- This split keeps API costs manageable at scale\n\nEstimated cost: ~$0.007 per cascade ingest event using Haiku.' },

  // ── RESOURCES ──
  { slug: 'drizzle-orm-docs', title: 'Drizzle ORM Documentation', type: 'resource', confidence: 0.9, scope: 'org',
    summary: 'Official Drizzle ORM docs for schema and query patterns',
    content: 'Drizzle ORM docs: https://orm.drizzle.team\n\nKey sections:\n- Schema declaration: https://orm.drizzle.team/docs/sql-schema-declaration\n- Select queries: https://orm.drizzle.team/docs/select\n- Migrations: https://orm.drizzle.team/docs/migrations\n\nWe use the PostgreSQL dialect with node-postgres driver.' },
  { slug: 'hono-docs', title: 'Hono Framework Documentation', type: 'resource', confidence: 0.9, scope: 'org',
    summary: 'Official Hono docs for routing and middleware',
    content: 'Hono docs: https://hono.dev\n\nKey patterns we use:\n- Route groups: app.route(\'/api/wiki\', wikiRoutes)\n- Middleware: app.use(\'/api/*\', authMiddleware)\n- Context: c.get(\'user\'), c.req.json(), c.json()\n- Error handling: try/catch with { error, code } responses' },
  { slug: 'anthropic-api-reference', title: 'Anthropic API Reference', type: 'resource', confidence: 0.95, scope: 'org',
    summary: 'Claude API docs for message creation and tool use',
    content: 'Anthropic API: https://docs.anthropic.com/en/api\n\nWe use:\n- Messages API (chat completions)\n- Tool use (agent actions)\n- System prompts (agent personality + context)\n\nSDK: @anthropic-ai/sdk\nModels: claude-sonnet-4-20250514, claude-haiku-4-5-20251001' },
  { slug: 'tailwind-css-docs', title: 'Tailwind CSS Documentation', type: 'resource', confidence: 0.85, scope: 'org',
    summary: 'Utility-first CSS framework used for all styling',
    content: 'Tailwind CSS docs: https://tailwindcss.com/docs\n\nConventions:\n- No CSS modules, no styled-components — Tailwind only\n- Use CSS variables for theme colors (var(--accent), var(--surface-container))\n- Mobile-first responsive: default styles are mobile, add md: for desktop\n- Text sizes: text-[11px] to text-[20px] with explicit pixel values' },
  { slug: 'figma-design-system', title: 'Figma Design System', type: 'resource', confidence: 0.75, scope: 'org',
    summary: 'Design tokens, component specs, and mockups',
    content: 'The Figma design system contains:\n- Color tokens (dark theme primary)\n- Typography scale\n- Component specs (buttons, inputs, cards, modals)\n- Page layouts (chat, tasks, knowledge, dashboard)\n\nArjun maintains the design system. Ask him for Figma access if needed.' },

  // ── PROCEDURES ──
  { slug: 'deployment-process', title: 'Deployment Process', type: 'procedure', confidence: 0.9, scope: 'org',
    summary: 'How to deploy Deft updates to self-hosted instances',
    content: 'Deployment steps:\n1. Merge PR to main branch\n2. CI runs lint + typecheck + build\n3. Build and push Docker images (API, frontend)\n4. Users pull latest images and run: docker-compose up -d\n5. Run migrations if schema changed: docker-compose exec api pnpm db:push\n6. Verify health endpoint: /health\n\nRollback: Pull previous image version and restart containers.' },
  { slug: 'pr-review-process', title: 'PR Review Process', type: 'procedure', confidence: 0.95, scope: 'org',
    summary: 'Code review workflow and approval requirements',
    content: 'PR review process:\n1. Create PR with description and test plan\n2. At least 1 approval required\n3. CI must pass (lint + typecheck)\n4. No direct pushes to main\n5. Squash merge preferred\n\nReviewers: Tag the person most familiar with the area. For cross-cutting changes, tag Maneek.' },
  { slug: 'sprint-process', title: 'Sprint Process', type: 'procedure', confidence: 0.9, scope: 'org',
    summary: 'Two-week sprint cycle with async standups',
    content: 'Sprint process:\n- 2-week sprints starting Monday\n- Planning: Monday morning (async — post priorities in #general)\n- Standups: Daily async posts in #general (Yesterday/Today/Blockers)\n- Demo: Friday of sprint end week\n- Retro: After demo, async in #random\n\nEstimation: T-shirt sizing (S/M/L/XL). S = few hours, XL = full sprint.' },
  { slug: 'onboarding-new-members', title: 'Onboarding New Team Members', type: 'procedure', confidence: 0.8, scope: 'org',
    summary: 'Steps to get a new team member set up and productive',
    content: 'New member onboarding:\n1. Add to GitHub org and Deft workspace\n2. Clone repo, run pnpm install, copy .env.example\n3. Start local dev: pnpm dev\n4. Read CLAUDE.md for architecture overview\n5. Read CONTRIBUTING.md for code conventions\n6. Assign a starter task (labeled "good first issue")\n7. Pair with buddy for first PR\n\nArjun handles Figma access. Sara handles CI/deploy access.' },
  { slug: 'incident-response', title: 'Incident Response', type: 'procedure', confidence: 0.65, scope: 'org',
    summary: 'How to handle production incidents',
    content: 'Incident response (draft):\n1. Identify: Check /health endpoint and docker-compose logs\n2. Communicate: Post in #general with severity\n3. Mitigate: Revert to previous Docker image if regression\n4. Fix: Create hotfix branch, PR, fast-track review\n5. Post-mortem: Document root cause in wiki\n\nSeverity:\n- P0: Service down — all hands\n- P1: Feature broken — owner + backup\n- P2: Bug — next sprint' },

  // ── PREFERENCES ──
  { slug: 'pref-typescript-strict', title: 'TypeScript Strict Mode Everywhere', type: 'preference', confidence: 1.0, scope: 'org',
    summary: 'All packages use TypeScript strict mode',
    content: 'Preference: TypeScript strict mode is enabled in all tsconfig.json files.\n\nThis means:\n- No implicit any\n- Strict null checks\n- No unused locals/parameters (as errors, not warnings)\n\nDo not add // @ts-ignore or any type unless absolutely necessary and documented.' },
  { slug: 'pref-kebab-case-files', title: 'Kebab-case File Names', type: 'preference', confidence: 1.0, scope: 'org',
    summary: 'All files use kebab-case, components use PascalCase',
    content: 'File naming convention:\n- Files: kebab-case (knowledge-panel.tsx, agent-runner.ts)\n- React components: PascalCase (KnowledgePage, CreateModal)\n- Types/interfaces: PascalCase (WikiPage, AuthUser)\n- Variables/functions: camelCase (fetchPages, handleSubmit)\n- Constants: UPPER_SNAKE_CASE (ACTION_TOOLS, TYPE_CONFIG)' },
  { slug: 'pref-server-components', title: 'Prefer Server Components', type: 'preference', confidence: 0.85, scope: 'org',
    summary: 'Use React Server Components where possible, client only when needed',
    content: 'Preference: Default to React Server Components. Only add \'use client\' when the component needs:\n- useState/useEffect\n- Browser APIs\n- Event handlers\n- Third-party client-side libraries\n\nServer components reduce bundle size and improve initial load time.' },
  { slug: 'pref-no-premature-caching', title: 'No Premature Caching', type: 'preference', confidence: 0.9, scope: 'org',
    summary: 'PostgreSQL is fast enough — don\'t cache unless measured',
    content: 'Preference: Don\'t add Redis caching, memoization, or other caching layers unless you\'ve measured a performance problem.\n\nPostgreSQL with proper indexes handles our current scale (< 10k users) without caching. Adding cache introduces invalidation complexity.\n\nExceptions: Socket.io adapter uses Redis for pub/sub (not caching).' },
  { slug: 'pref-async-standups', title: 'Async Standups Over Meetings', type: 'preference', confidence: 0.95, scope: 'org',
    summary: 'Team prefers async standups posted in #general',
    content: 'Preference: Async standups in #general each morning instead of video calls.\n\nFormat:\n**Yesterday:** What you did\n**Today:** What you\'re doing\n**Blockers:** Anything stuck\n\nReason: Team spans IST and UTC timezones. Async respects everyone\'s schedule and creates a searchable record.' },

  // ── FACTS ──
  { slug: 'fact-team-size', title: 'Team Size: 5 Members', type: 'fact', confidence: 1.0, scope: 'org',
    summary: 'Current team: Maneek, Rahul, Priya, Arjun, Sara',
    content: 'Current team (5 members):\n- Maneek: Founder, full-stack, product lead\n- Rahul: Backend engineer, auth + real-time\n- Priya: Frontend engineer, notifications + UI\n- Arjun: Design engineer, design system + components\n- Sara: DevOps/PM, CI/CD + sprint management' },
  { slug: 'fact-launch-date', title: 'Private Beta Target', type: 'fact', confidence: 0.7, scope: 'org',
    summary: 'Targeting end of next week for private beta launch',
    content: 'The private beta launch is targeted for end of next week (discussed in #general on March 28).\n\nCritical paths:\n- Auth flow (Rahul — done)\n- Socket.io reconnection (Rahul — in progress)\n- Agent observation pipeline stub (Rahul — PR pending)\n- CI/CD pipeline (Sara — done)' },
  { slug: 'fact-database-tables', title: 'Database: 40+ Tables', type: 'fact', confidence: 0.9, scope: 'org',
    summary: 'The schema has grown to 40+ tables including wiki system',
    content: 'Current database schema includes 40+ tables:\n- Core: users, orgs, org_members, spaces, space_members\n- Chat: messages, threads, reactions, read_receipts\n- Tasks: tasks, subtasks, task_comments\n- Wiki: wiki_pages, wiki_links, wiki_citations, wiki_ops_log, wiki_page_versions\n- Agent: agent_memory, agent_conversations\n- Jobs: job_queue, scheduled_jobs\n- Connected: events, connections, connection_tokens' },
  { slug: 'fact-api-cost-estimate', title: 'API Cost Estimates', type: 'fact', confidence: 0.85, scope: 'org',
    summary: 'Estimated Anthropic API costs per org size',
    content: 'Estimated monthly Anthropic API costs (cascade ingest only):\n- 5 person org: ~$2/month\n- 10 person org: ~$4/month\n- 25 person org: ~$11/month\n- 50 person org: ~$22/month\n\nThis covers Haiku calls for message classification + wiki cascade ingest. Agent reasoning (Sonnet) costs are additional and usage-dependent.' },
  { slug: 'fact-license-bsl', title: 'License: BSL 1.1', type: 'fact', confidence: 1.0, scope: 'org',
    summary: 'Business Source License — use for any purpose except hosting as a service',
    content: 'Deft is licensed under BSL 1.1 (Business Source License).\n\nPermitted: Any use including commercial, self-hosting, modifications, forks\nRestricted: Hosting Deft as a service for third parties (competing SaaS)\nRequired: Mandatory attribution in forks\n\nThe license converts to Apache 2.0 after 4 years.' },
];

// Link definitions: [source_slug, target_slug]
const links: [string, string][] = [
  ['monorepo-architecture', 'hono-framework'],
  ['monorepo-architecture', 'postgresql-database'],
  ['monorepo-architecture', 'multi-tenancy'],
  ['real-time-architecture', 'hono-framework'],
  ['real-time-architecture', 'better-auth'],
  ['multi-tenancy', 'postgresql-database'],
  ['multi-tenancy', 'decision-no-supabase'],
  ['agent-observation-pipeline', 'anthropic-claude-api'],
  ['agent-observation-pipeline', 'decision-sonnet-haiku-split'],
  ['agent-observation-pipeline', 'knowledge-graph-system'],
  ['knowledge-graph-system', 'postgresql-database'],
  ['knowledge-graph-system', 'agent-observation-pipeline'],
  ['decision-drizzle-orm', 'postgresql-database'],
  ['decision-drizzle-orm', 'drizzle-orm-docs'],
  ['decision-railway-deploy', 'hono-framework'],
  ['decision-railway-deploy', 'real-time-architecture'],
  ['decision-bullmq-jobs', 'postgresql-database'],
  ['decision-sonnet-haiku-split', 'anthropic-claude-api'],
  ['decision-sonnet-haiku-split', 'fact-api-cost-estimate'],
  ['tiptap-editor', 'pref-server-components'],
  ['deployment-process', 'decision-railway-deploy'],
  ['deployment-process', 'pr-review-process'],
  ['sprint-process', 'pref-async-standups'],
  ['onboarding-new-members', 'fact-team-size'],
  ['onboarding-new-members', 'monorepo-architecture'],
  ['incident-response', 'deployment-process'],
  ['pref-typescript-strict', 'decision-drizzle-orm'],
  ['pref-kebab-case-files', 'pref-typescript-strict'],
  ['fact-launch-date', 'fact-team-size'],
  ['fact-database-tables', 'postgresql-database'],
  ['fact-database-tables', 'knowledge-graph-system'],
];

async function seed() {
  console.log('Seeding wiki data...');

  // First, clean existing seeded data (keep manually created pages)
  const slugs = pages.map(p => `'${p.slug}'`).join(',');

  // Insert pages
  const pageIds: Record<string, string> = {};
  for (const p of pages) {
    const result = await pool.query(
      `INSERT INTO wiki_pages (id, org_id, scope, type, title, slug, summary, content, confidence)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (org_id, slug) DO UPDATE SET content = $7, confidence = $8, updated_at = NOW()
       RETURNING id`,
      [ORG_ID, p.scope, p.type, p.title, p.slug, p.summary, p.content, p.confidence]
    );
    pageIds[p.slug] = result.rows[0].id;
    console.log(`  Page: ${p.title} (${p.type})`);
  }

  console.log(`\nCreated ${Object.keys(pageIds).length} pages`);

  // Insert links
  let linkCount = 0;
  for (const [src, tgt] of links) {
    const srcId = pageIds[src];
    const tgtId = pageIds[tgt];
    if (!srcId || !tgtId) {
      console.warn(`  Skipping link ${src} -> ${tgt}: missing page`);
      continue;
    }
    await pool.query(
      `INSERT INTO wiki_links (id, org_id, source_page_id, target_page_id)
       VALUES (gen_random_uuid()::text, $1, $2, $3)
       ON CONFLICT (source_page_id, target_page_id) DO NOTHING`,
      [ORG_ID, srcId, tgtId]
    );
    linkCount++;
  }
  console.log(`Created ${linkCount} links`);

  // Insert ops log entries
  for (const p of pages) {
    await pool.query(
      `INSERT INTO wiki_ops_log (id, org_id, operation, page_id, details, performed_by)
       VALUES (gen_random_uuid()::text, $1, 'create', $2, $3, $4)`,
      [ORG_ID, pageIds[p.slug], JSON.stringify({ title: p.title, type: p.type, scope: p.scope, seeded: true }), USER_ID]
    );
  }
  console.log(`Created ${pages.length} ops log entries`);

  // Update search vectors for new pages
  await pool.query(`
    UPDATE wiki_pages SET search_vector =
      setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
      setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
      setweight(to_tsvector('english', COALESCE(content, '')), 'C')
    WHERE org_id = $1
  `, [ORG_ID]);
  console.log('Updated search vectors');

  // Final counts
  const counts = await pool.query(`
    SELECT
      (SELECT count(*) FROM wiki_pages WHERE org_id = $1 AND is_deleted = false) as pages,
      (SELECT count(*) FROM wiki_links WHERE org_id = $1) as links,
      (SELECT count(*) FROM wiki_ops_log WHERE org_id = $1) as ops
  `, [ORG_ID]);
  console.log(`\nFinal counts: ${counts.rows[0].pages} pages, ${counts.rows[0].links} links, ${counts.rows[0].ops} ops`);

  await pool.end();
  console.log('Done!');
}

seed().catch(err => {
  console.error('Seed failed:', err);
  pool.end();
  process.exit(1);
});
