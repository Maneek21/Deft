import pg from 'pg';

const pool = new pg.Pool({ connectionString: 'postgres://postgres:postgres@localhost:5432/cairn' });

async function seed() {
  const client = await pool.connect();
  try {
    // Get org, users, and spaces
    const { rows: orgs } = await client.query(`SELECT id FROM orgs LIMIT 1`);
    const orgId = orgs[0].id;

    const { rows: userRows } = await client.query(`SELECT id, name FROM users LIMIT 10`);
    const rahul = userRows.find((u: any) => u.name.includes('Rahul'));
    const priya = userRows.find((u: any) => u.name.includes('Priya'));
    const arjun = userRows.find((u: any) => u.name.includes('Arjun'));

    const { rows: spaceRows } = await client.query(`SELECT id, name FROM spaces WHERE type = 'public' LIMIT 10`);
    const engineering = spaceRows.find((s: any) => s.name.toLowerCase().includes('engineer'));
    const design = spaceRows.find((s: any) => s.name.toLowerCase().includes('design'));
    const general = spaceRows.find((s: any) => s.name.toLowerCase().includes('general'));

    if (!rahul || !engineering) {
      console.log('Missing required data. Users:', userRows.map((u: any) => u.name), 'Spaces:', spaceRows.map((s: any) => s.name));
      return;
    }

    // Clear existing knowledge entries
    await client.query(`DELETE FROM space_knowledge WHERE org_id = $1`, [orgId]);

    const entries = [
      // Engineering decisions
      {
        space_id: engineering.id,
        type: 'decision',
        title: 'Use Hono over Express for API server',
        content: 'Express is slow and has poor TypeScript support. Hono is ~3x faster, has built-in TypeScript, and supports edge deployment. We tested both with our WebSocket setup and Hono worked seamlessly with Socket.io.',
        metadata: { status: 'accepted', participants: ['Rahul', 'Maneek'] },
        created_by: rahul.id,
      },
      {
        space_id: engineering.id,
        type: 'decision',
        title: 'Drizzle ORM over Prisma',
        content: 'Prisma generates too much client code and its query engine adds latency. Drizzle gives us type-safe queries with zero overhead — just SQL. Critical for the agent which needs fast direct SQL access.',
        metadata: { status: 'accepted', participants: ['Rahul', 'Priya'] },
        created_by: rahul.id,
      },
      {
        space_id: engineering.id,
        type: 'decision',
        title: 'better-auth for authentication',
        content: 'Evaluated NextAuth, Clerk, and better-auth. Clerk is hosted (dependency risk). NextAuth v5 is unstable. better-auth is self-hosted, supports JWT + refresh tokens + Google OAuth out of the box.',
        metadata: { status: 'accepted', participants: ['Rahul'] },
        created_by: rahul.id,
      },
      {
        space_id: engineering.id,
        type: 'decision',
        title: 'Postgres job queue over BullMQ+Redis',
        content: 'Removed Redis dependency entirely. Using a simple Postgres-based job queue (job_queue table + polling workers). Fewer moving parts for self-hosters. Performance is sufficient for our scale.',
        metadata: { status: 'accepted', participants: ['Rahul', 'Maneek'] },
        created_by: rahul.id,
      },

      // Engineering resources
      {
        space_id: engineering.id,
        type: 'resource',
        title: 'Anthropic Claude API docs',
        content: 'Official documentation for the Claude API. Reference for tool use, streaming, and system prompts.',
        metadata: { url: 'https://docs.anthropic.com/en/docs' },
        created_by: priya?.id || rahul.id,
      },
      {
        space_id: engineering.id,
        type: 'resource',
        title: 'Drizzle ORM documentation',
        content: 'Schema definitions, query builder, migrations. The select/join patterns we use everywhere.',
        metadata: { url: 'https://orm.drizzle.team/docs/overview' },
        created_by: rahul.id,
      },
      {
        space_id: engineering.id,
        type: 'resource',
        title: 'TipTap editor extensions guide',
        content: 'How to build custom extensions for the TipTap editor. Used in chat composer, notes, and canvas.',
        metadata: { url: 'https://tiptap.dev/docs/editor/extensions/custom-extensions' },
        created_by: arjun?.id || rahul.id,
      },

      // Engineering action items
      {
        space_id: engineering.id,
        type: 'action_item',
        title: 'Set up CI/CD pipeline',
        content: 'GitHub Actions for lint, type-check, and test on PR. Deploy to Railway on merge to main.',
        metadata: { status: 'open', assignee_name: 'Rahul' },
        created_by: rahul.id,
      },
      {
        space_id: engineering.id,
        type: 'action_item',
        title: 'Add rate limiting to API endpoints',
        content: 'Use Hono middleware. 100 req/min for regular endpoints, 10 req/min for agent conversations.',
        metadata: { status: 'open', assignee_name: 'Maneek' },
        created_by: rahul.id,
      },

      // Engineering notes
      {
        space_id: engineering.id,
        type: 'note',
        title: 'Agent observation pipeline architecture',
        content: 'Every message goes through: 1) Classifier (Haiku) → intent + entities + urgency, 2) Cross-reference extraction (task mentions), 3) Memory extraction (facts + decisions), 4) Optionally triggers agent action. The classifier is the gatekeeper — if it says "not actionable", the pipeline stops.',
        metadata: {},
        created_by: rahul.id,
      },
    ];

    // Add design space entries if it exists
    if (design && arjun) {
      entries.push(
        {
          space_id: design.id,
          type: 'decision',
          title: 'Tailwind only — no CSS modules or styled-components',
          content: 'Keeps styling consistent and colocated. No build complexity. Design tokens via CSS custom properties (--foreground, --accent, etc).',
          metadata: { status: 'accepted', participants: ['Arjun', 'Rahul'] },
          created_by: arjun.id,
        },
        {
          space_id: design.id,
          type: 'resource',
          title: 'Deft color system reference',
          content: 'Our Material-inspired dark theme color tokens. Surface hierarchy: surface < surface-container < surface-container-high < surface-container-highest.',
          metadata: { url: '' },
          created_by: arjun.id,
        },
        {
          space_id: design.id,
          type: 'note',
          title: 'Typography scale',
          content: 'Headings: Inter (--font-heading). Body: system font stack. Mono: JetBrains Mono. Base size 14px for UI, 13px for dense lists, 12px for metadata, 11px for labels.',
          metadata: {},
          created_by: arjun.id,
        },
      );
    }

    // Add general space entries if it exists
    if (general) {
      entries.push(
        {
          space_id: general.id,
          type: 'decision',
          title: 'BSL 1.1 license for open source',
          content: 'Business Source License allows any use except hosting as a competing service. Protects commercial viability while being source-available. Converts to Apache 2.0 after 4 years.',
          metadata: { status: 'accepted', participants: ['Rahul'] },
          created_by: rahul.id,
        },
        {
          space_id: general.id,
          type: 'note',
          title: 'Product principles',
          content: '1) AI-native, not AI-bolted. The agent has SQL access, not API wrappers. 2) Works without AI — if LLM is down, chat and tasks function normally. 3) Multi-tenant from day 1. 4) Self-hostable. No dependency on hosted services (hence no Supabase, no Clerk).',
          metadata: {},
          created_by: rahul.id,
        },
      );
    }

    for (const entry of entries) {
      await client.query(
        `INSERT INTO space_knowledge (id, org_id, space_id, type, title, content, metadata, created_by, created_at, updated_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, NOW() - interval '${Math.floor(Math.random() * 14) + 1} days', NOW())`,
        [orgId, entry.space_id, entry.type, entry.title, entry.content, JSON.stringify(entry.metadata), entry.created_by]
      );
    }

    console.log(`Seeded ${entries.length} knowledge entries`);
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(console.error);
