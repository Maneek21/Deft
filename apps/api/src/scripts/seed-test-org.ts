#!/usr/bin/env tsx
/**
 * seed-test-org — populate the trusted-tester Deft Test org with realistic
 * data so the workspace feels alive when testers sign in for the first time.
 *
 * What it seeds:
 *   - 4 additional users (Priya, Rahul, Arjun, Sara) all in the admin's org
 *   - 4 spaces beyond #general: #engineering, #design, #random, #launch
 *   - ~80 messages spread across spaces, time-distributed over the last 2 weeks
 *   - A couple of thread replies and reactions
 *   - 1 project "Deft v1" (DEFT prefix) with ~20 tasks across all statuses
 *   - 6 wiki pages (decisions, preferences, entities)
 *   - 3 calendar events
 *   - 2 personal notes for the admin
 *
 * Idempotent-ish: checks for existing seed users by email and skips creating
 * them again, but message / task / wiki seeding always appends. Run once.
 *
 * Usage:
 *   DATABASE_URL=postgres://... ADMIN_EMAIL=maneek@deft.test \
 *     pnpm exec tsx apps/api/src/scripts/seed-test-org.ts
 */
import 'dotenv/config';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@deft.test';
const SEED_PASSWORD = 'DeftTest2026!';

// Anchor "now" to real time; used for deterministic time offsets.
const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function minutesAgo(m: number): Date {
  return new Date(NOW - m * MINUTE);
}
function hoursAgo(h: number): Date {
  return new Date(NOW - h * HOUR);
}
function daysAgo(d: number): Date {
  return new Date(NOW - d * DAY);
}

// ─── Seed users (5 members total including admin) ─────────────────────
const SEED_USERS = [
  { name: 'Priya Shah', email: 'priya@deft.test', avatar_initial: 'P' },
  { name: 'Rahul Mehta', email: 'rahul@deft.test', avatar_initial: 'R' },
  { name: 'Arjun Rao', email: 'arjun@deft.test', avatar_initial: 'A' },
  { name: 'Sara Kim', email: 'sara@deft.test', avatar_initial: 'S' },
];

// ─── Seed spaces ──────────────────────────────────────────────────────
const SEED_SPACES = [
  {
    name: 'engineering',
    topic: 'Build, ship, debug',
    description: 'Code reviews, design docs, incident post-mortems.',
  },
  {
    name: 'design',
    topic: 'Pixels, Figma, design system',
    description: 'UX reviews, icon audits, interaction specs.',
  },
  {
    name: 'random',
    topic: 'Lunch + links + life',
    description: 'Off-topic chatter. Memes welcome.',
  },
  {
    name: 'launch',
    topic: 'Private beta coordination',
    description: 'Tester invites, weekly status, blockers.',
  },
];

// ─── Message seed data ────────────────────────────────────────────────
// Each message has: user (by name), text, daysAgo offset, hoursAgo, optional
// thread_of (links to the immediately preceding message), optional reactions.
type SeedMessage = {
  user: string;
  text: string;
  days: number;
  hours: number;
  thread?: boolean;
  reactions?: { user: string; emoji: string }[];
};

const ENGINEERING_MESSAGES: SeedMessage[] = [
  { user: 'Maneek', text: '<p>Landing the agent-employees UI behind the feature flag today. Anyone want to do a live pairing on the phase 12 rollout checklist?</p>', days: 13, hours: 10 },
  { user: 'Rahul Mehta', text: '<p>I can pair at 3pm. I also want to sanity-check the OTel metrics path from phase 10 — the <code>duration_ms</code> histogram looked off in staging.</p>', days: 13, hours: 9, reactions: [{ user: 'Maneek', emoji: '👍' }] },
  { user: 'Arjun Rao', text: "<p>@Rahul what tool were you using to inspect the histogram buckets? I want to add that to the runbook.</p>", days: 13, hours: 8 },
  { user: 'Rahul Mehta', text: "<p>Prometheus query in Grafana. I'll drop the panel JSON in the launch channel.</p>", days: 13, hours: 7 },
  { user: 'Priya Shah', text: "<p>Merged <strong>feat(agents): phase 11 — gateway connectivity ping + multi-gateway health ui</strong>. Two follow-ups:</p><ul><li>The ping cadence should probably be configurable per gateway</li><li>We should surface the last-error text in the card, not just a red dot</li></ul>", days: 12, hours: 20 },
  { user: 'Sara Kim', text: "<p>+1 on surfacing the error text. Designs for the gateway card are in Figma under <em>agent-employees / gateway-health</em>. I can update with an error-state variant today.</p>", days: 12, hours: 19, reactions: [{ user: 'Priya Shah', emoji: '🙏' }, { user: 'Maneek', emoji: '💯' }] },
  { user: 'Rahul Mehta', text: "<p>Stuck on a weird test flake — <code>audit-receipts.audit.ts</code> fails intermittently when the receipt signer runs in parallel with the embedding backfill. Repro'd 3 out of 10 runs.</p>", days: 11, hours: 14 },
  { user: 'Rahul Mehta', text: "<p>Fixed by serializing the canonicalize step behind a mutex. PR up in a sec.</p>", days: 11, hours: 11, reactions: [{ user: 'Arjun Rao', emoji: '🔥' }] },
  { user: 'Maneek', text: "<p>Reminder: we froze non-critical merges this week because the mobile team is cutting their release branch. Anything that isn't a gap-fix or a security patch, please hold until Friday.</p>", days: 10, hours: 9 },
  { user: 'Arjun Rao', text: "<p>What counts as a gap-fix — the list from the sweep or new bugs from testers too?</p>", days: 10, hours: 8 },
  { user: 'Maneek', text: "<p>Both. Anything user-visible. Internal refactors can wait.</p>", days: 10, hours: 7 },
  { user: 'Priya Shah', text: "<p>The wiki detail 500 is back. Filed gap #10. Looks like the embedding column isn't being created in the migration journal even though 0011 exists on disk.</p>", days: 8, hours: 16 },
  { user: 'Rahul Mehta', text: "<p>On it. I'll take the whole wiki thread — there were a few issues flagged in the April 15 sweep.</p>", days: 8, hours: 15 },
  { user: 'Sara Kim', text: "<p>Thread #7 — 'Entities' type label rendering as 'Entitie' on the knowledge page. Explicit label map is the cleanest fix.</p>", days: 8, hours: 14 },
  { user: 'Maneek', text: "<p>Noted. Gap #9 — let's batch it with the wiki fix PR since it's the same file.</p>", days: 8, hours: 13 },
  { user: 'Rahul Mehta', text: "<p>PR up: <code>fix(chat): wrap message body in div, not p</code>. Simple HTML nesting fix — the outer &lt;p&gt; was auto-closing on nested TipTap paragraphs and splitting messages into sibling blocks.</p>", days: 6, hours: 19 },
  { user: 'Arjun Rao', text: "<p>I hit this one locally too. A11y tree was a mess. Thanks for landing it.</p>", days: 6, hours: 18, reactions: [{ user: 'Rahul Mehta', emoji: '🙏' }] },
  { user: 'Maneek', text: "<p>Just saw the gap-fixes audit go green: 15/15. Ready to ship the trusted-tester deploy.</p>", days: 2, hours: 11, reactions: [{ user: 'Rahul Mehta', emoji: '🎉' }, { user: 'Priya Shah', emoji: '🚀' }, { user: 'Sara Kim', emoji: '💪' }, { user: 'Arjun Rao', emoji: '🔥' }] },
  { user: 'Priya Shah', text: "<p>Amazing work everyone. What's left before the first tester signs in?</p>", days: 2, hours: 10 },
  { user: 'Maneek', text: "<p>Password-logging bug (A1) is the only critical. I'll patch it today and push the deploy runbook along with it.</p>", days: 2, hours: 9 },
];

const DESIGN_MESSAGES: SeedMessage[] = [
  { user: 'Sara Kim', text: "<p>Updated the onboarding flow mock. Four steps instead of six — dropped the optional calendar connect and the generic chat-app tour. Both felt like busy work.</p>", days: 11, hours: 14 },
  { user: 'Arjun Rao', text: "<p>Agree. Step 5 'Meet Deft' is doing too much — could we fold that into the welcome message on step 1?</p>", days: 11, hours: 12 },
  { user: 'Sara Kim', text: "<p>Yeah. Collapsing. Also reworking the empty states for the Knowledge page — they're too text-heavy right now.</p>", days: 11, hours: 11 },
  { user: 'Priya Shah', text: "<p>While you're there — the wiki type filter tabs are rendering 'Entitie' instead of 'Entities'. Known gap #9, but worth fixing the label copy at the same time.</p>", days: 10, hours: 17 },
  { user: 'Sara Kim', text: "<p>On it. Added <em>Concept / Entity / Decision / Resource / Procedure / Preference / Fact</em> as the canonical singular set and plural equivalents.</p>", days: 10, hours: 15, reactions: [{ user: 'Priya Shah', emoji: '✨' }] },
  { user: 'Arjun Rao', text: "<p>Figma request: can we add the <code>deft-mention-pill</code> token to the design system? It's hardcoded inline in <code>rich-composer.tsx</code> right now.</p>", days: 9, hours: 20 },
  { user: 'Sara Kim', text: "<p>Added. Token name is <code>color.accent.mention.bg</code>, value maps to <code>rgba(212,168,83,0.15)</code> which is what the composer ships with.</p>", days: 9, hours: 18 },
  { user: 'Sara Kim', text: "<p>Reviewed the Agent page header today — the <em>Defty / Alex PM</em> tab split feels unclear to first-time users. Considering a dropdown with 'Switch agent' instead.</p>", days: 5, hours: 16 },
  { user: 'Maneek', text: "<p>Leave it for now. Let testers react and see if anyone's confused. We can iterate on the affordance after week 1.</p>", days: 5, hours: 15 },
  { user: 'Sara Kim', text: "<p>Fair. I'll file it as a backlog item.</p>", days: 5, hours: 14, reactions: [{ user: 'Maneek', emoji: '👍' }] },
  { user: 'Priya Shah', text: "<p>Sharing the final version of the Create Agent wizard — all 8 first-party roles are in the dropdown now. Nice unblock, gap #21.</p>", days: 2, hours: 13 },
];

const RANDOM_MESSAGES: SeedMessage[] = [
  { user: 'Rahul Mehta', text: "<p>anyone tried the new coffee place near the office? the single-origin pour-over is unreal</p>", days: 12, hours: 22 },
  { user: 'Arjun Rao', text: "<p>Which one, Blue Tokai or the new place on 2nd?</p>", days: 12, hours: 20 },
  { user: 'Rahul Mehta', text: "<p>The new place. Forgot the name — it's next to the bookstore.</p>", days: 12, hours: 19 },
  { user: 'Priya Shah', text: "<p>Friendly reminder: <strong>pizza Friday</strong> this week 🍕</p>", days: 9, hours: 12, reactions: [{ user: 'Maneek', emoji: '🎉' }, { user: 'Rahul Mehta', emoji: '🍕' }, { user: 'Sara Kim', emoji: '🍕' }, { user: 'Arjun Rao', emoji: '💯' }] },
  { user: 'Sara Kim', text: "<p>I'm out on Monday — taking a day off. DMs will be slow but I'm reachable on phone if anything's urgent.</p>", days: 5, hours: 22 },
  { user: 'Maneek', text: "<p>Enjoy! We'll cover. 🌴</p>", days: 5, hours: 21, reactions: [{ user: 'Sara Kim', emoji: '💛' }] },
  { user: 'Arjun Rao', text: "<p>Saw this article about the TipTap 3.0 migration — might be worth skimming before we touch the composer again. <em>tiptap.dev/blog/tiptap-v3</em></p>", days: 3, hours: 14 },
];

const LAUNCH_MESSAGES: SeedMessage[] = [
  { user: 'Maneek', text: "<p>Tester list for private beta:</p><ol><li>Aditi (ex-Notion, now at Linear)</li><li>Karthik (founder, FounderPad)</li><li>Mira (writer, tech/ops focus)</li><li>Dev (ex-teammate, CTO at Zelestic)</li><li>Chris (PM at Ramp)</li></ol><p>Everyone on this list is someone I've worked with or know well. Low-risk trusted cohort. Invites going out once the deploy is green.</p>", days: 8, hours: 11 },
  { user: 'Priya Shah', text: "<p>What's our feedback loop — direct message, email, or do we give them a form?</p>", days: 8, hours: 10 },
  { user: 'Maneek', text: "<p>DM for now. We're 5 testers; a form is overkill. I'll batch-summarize into this channel every Friday.</p>", days: 8, hours: 9 },
  { user: 'Rahul Mehta', text: "<p>What do we tell them about limitations? File uploads are still ephemeral, XSS sanitizer isn't landed.</p>", days: 7, hours: 18 },
  { user: 'Maneek', text: "<p>Writing the invite email now. I'll list the known limitations upfront — 'don't upload anything you'd cry about losing', 'don't paste untrusted HTML', etc. Trusted cohort should be fine with those caveats.</p>", days: 7, hours: 17, reactions: [{ user: 'Rahul Mehta', emoji: '👍' }] },
  { user: 'Sara Kim', text: "<p>Can I add a 'What's in this build' section with the 17 gap fixes? Makes it feel like a real release, not a hack-together.</p>", days: 6, hours: 15, reactions: [{ user: 'Priya Shah', emoji: '✨' }, { user: 'Maneek', emoji: '👍' }] },
  { user: 'Maneek', text: "<p>Yes. Paste the gap-fixes audit output into the email verbatim.</p>", days: 6, hours: 14 },
  { user: 'Arjun Rao', text: "<p>Do we have a rollback plan if something's on fire during the tester window?</p>", days: 4, hours: 11 },
  { user: 'Maneek', text: "<p>Railway + Neon can both be rolled back in 2 clicks. Worst case, I tell the testers to hold for a few minutes while we revert. But the gap-fixes audit is our safety net — it catches regressions before they hit testers.</p>", days: 4, hours: 10 },
  { user: 'Priya Shah', text: "<p>Deploy runbook draft is in docs/. Everything Railway-specific is called out: the <code>PORT</code> fallback, the <code>.railwayignore</code> pattern, and the start-command trap with <code>next start -p $PORT</code>.</p>", days: 1, hours: 20, reactions: [{ user: 'Maneek', emoji: '🙏' }] },
];

const GENERAL_MESSAGES: SeedMessage[] = [
  { user: 'Maneek', text: "<p>Welcome to Deft! This workspace is our pre-launch playground. <strong>General</strong> is for company-wide announcements. Everything else happens in dedicated spaces: #engineering, #design, #launch, #random.</p>", days: 14, hours: 12 },
  { user: 'Priya Shah', text: "<p>Hey team! Excited to be here 👋</p>", days: 14, hours: 11 },
  { user: 'Rahul Mehta', text: "<p>Same. Already noticed the agent responds faster than our old Claude wrapper — nice work on prompt caching.</p>", days: 14, hours: 10, reactions: [{ user: 'Maneek', emoji: '💯' }] },
  { user: 'Arjun Rao', text: "<p>Joined. Will start on the design-system-sync task tomorrow morning.</p>", days: 14, hours: 9 },
  { user: 'Sara Kim', text: "<p>Here! I've already connected Figma in Settings &gt; Integrations. Let me know if anyone wants me to walk them through the icon audit results.</p>", days: 14, hours: 8 },
  { user: 'Maneek', text: "<p><strong>Standup — Monday.</strong></p><p><em>Me:</em> Agent employees UI polish + phase 12 rollout checklist. Merge freeze after Thursday.</p><p><em>Blockers:</em> None.</p>", days: 7, hours: 12 },
  { user: 'Rahul Mehta', text: "<p><em>Me:</em> Wrapping the wiki embedding migration issue, then moving to session revocation (deployment TODO A3). <em>Blockers:</em> None.</p>", days: 7, hours: 11, reactions: [{ user: 'Maneek', emoji: '🙏' }] },
  { user: 'Priya Shah', text: "<p><em>Me:</em> Gateway health UI polish, then the XSS sanitizer follow-up. <em>Blockers:</em> Waiting on a design review from Sara for the error-state variant.</p>", days: 7, hours: 10 },
  { user: 'Sara Kim', text: "<p>Reviewing this afternoon, Priya. I'll ping you in design.</p>", days: 7, hours: 9 },
  { user: 'Arjun Rao', text: "<p><em>Me:</em> Figma tokens migration, then the Knowledge empty-state redesign. <em>Blockers:</em> None.</p>", days: 7, hours: 8 },
  { user: 'Maneek', text: "<p>Everyone — gap-fixes audit is GREEN 15/15. Deploying to the trusted-tester environment tomorrow. Invite emails go out once we smoke-test the live environment.</p>", days: 1, hours: 18, reactions: [{ user: 'Priya Shah', emoji: '🎉' }, { user: 'Rahul Mehta', emoji: '🚀' }, { user: 'Sara Kim', emoji: '💪' }, { user: 'Arjun Rao', emoji: '🔥' }] },
];

// ─── Tasks ────────────────────────────────────────────────────────────
type SeedTask = {
  title: string;
  description?: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done';
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  assignee?: string;
  daysAgo: number;
  dueDaysFromNow?: number;
};

const SEED_TASKS: SeedTask[] = [
  { title: 'Wire Cloudflare R2 for file uploads', description: 'Testers will lose files on every redeploy. Add R2 support with a presigned-URL upload path.', status: 'backlog', priority: 'p1', assignee: 'Rahul Mehta', daysAgo: 10, dueDaysFromNow: 7 },
  { title: 'Add DOMPurify to 8 dangerouslySetInnerHTML sites', description: 'Gap A2 from the sweep. Needed before we widen the tester cohort beyond trusted.', status: 'backlog', priority: 'p1', assignee: 'Priya Shah', daysAgo: 10, dueDaysFromNow: 14 },
  { title: 'Rate limiting middleware for /api/agent/*', description: 'Gap A4. Budget cap in Anthropic dashboard is the fallback for now.', status: 'backlog', priority: 'p2', assignee: 'Rahul Mehta', daysAgo: 9, dueDaysFromNow: 21 },
  { title: 'CSP + HSTS headers', description: 'Gap A5. Railway sets sensible defaults but we should explicitly own the CSP.', status: 'backlog', priority: 'p2', assignee: 'Priya Shah', daysAgo: 9, dueDaysFromNow: 21 },
  { title: 'GDPR data export endpoint', description: 'Gap B1. Required before any EU tester.', status: 'backlog', priority: 'p2', assignee: 'Maneek', daysAgo: 8, dueDaysFromNow: 28 },
  { title: 'Privacy Policy + ToS pages', description: 'Gap B2. Needs legal review, likely a lawyer external review step.', status: 'backlog', priority: 'p3', assignee: 'Maneek', daysAgo: 8, dueDaysFromNow: 45 },
  { title: 'Wire Sentry error tracking', description: 'Error reports in prod are currently only in Railway logs. 30 min to wire.', status: 'todo', priority: 'p2', assignee: 'Rahul Mehta', daysAgo: 6, dueDaysFromNow: 5 },
  { title: 'Onboarding empty-state redesign', description: 'Testers will land on an empty dashboard. Add a "Get started" card set.', status: 'todo', priority: 'p2', assignee: 'Sara Kim', daysAgo: 5, dueDaysFromNow: 7 },
  { title: 'Gap-fixes audit on hosted environment', description: 'Run the gap-fixes audit against the live Railway URLs to baseline prod.', status: 'in_progress', priority: 'p1', assignee: 'Maneek', daysAgo: 4, dueDaysFromNow: 2 },
  { title: 'Weekly standup auto-generation — quality pass', description: 'Agent-generated standups are working but the prose is clunky. Tune the prompt.', status: 'in_progress', priority: 'p2', assignee: 'Arjun Rao', daysAgo: 5, dueDaysFromNow: 10 },
  { title: 'Remove hardcoded BYTEA fallback in wiki schema', description: 'Dev workaround from the April 15 deploy. Real pgvector is on prod — drop the hack.', status: 'in_progress', priority: 'p3', assignee: 'Rahul Mehta', daysAgo: 3, dueDaysFromNow: 14 },
  { title: 'Mention @@ collapse — revisit ProseMirror position math', description: 'Gap #3 was deferred. Regex fix works in isolation but the positional delete leaves the literal @ in the composer.', status: 'in_progress', priority: 'p3', assignee: 'Priya Shah', daysAgo: 2, dueDaysFromNow: 14 },
  { title: 'Review: feat(auth) — server-side logout', description: 'PR #23c1f50 from the gap-fixes plan. Two-stage review already in, just needs a final sanity check on revoked_tokens index.', status: 'in_review', priority: 'p1', assignee: 'Rahul Mehta', daysAgo: 1, dueDaysFromNow: 2 },
  { title: 'Review: fix(knowledge) — explicit plural labels', description: "PR #4149676. Bundled with some April 14 carry-forward; reviewer should only gate the WIKI_TYPE_LABELS map.", status: 'in_review', priority: 'p2', assignee: 'Sara Kim', daysAgo: 1, dueDaysFromNow: 3 },
  { title: 'fix(wiki): apply missing embedding column migration', description: 'Gap #10. Critical — wiki detail was 500ing for every page before this.', status: 'done', priority: 'p0', assignee: 'Rahul Mehta', daysAgo: 1 },
  { title: 'fix(chat): wrap message body in div, not p', description: 'Gap #2. Every TipTap-rendered message had nested <p> which auto-closed in the browser.', status: 'done', priority: 'p0', assignee: 'Rahul Mehta', daysAgo: 1 },
  { title: 'fix(agent-employees): expose all 8 first-party templates in create UI', description: 'Gap #21. The create wizard was only listing 3 templates when 8 were seeded.', status: 'done', priority: 'p1', assignee: 'Arjun Rao', daysAgo: 1 },
  { title: 'fix(projects): expose live total_tasks from GET /api/projects', description: 'Gaps #7 + #12. Sidebar was rendering the ID counter as a task count.', status: 'done', priority: 'p1', assignee: 'Rahul Mehta', daysAgo: 1 },
  { title: 'fix(composer): disable StarterKit Link to silence dup extension warning', description: 'Gap #5. TipTap console warning on every chat page load.', status: 'done', priority: 'p3', assignee: 'Priya Shah', daysAgo: 1 },
  { title: 'feat(auth): POST /api/auth/logout revokes refresh token', description: 'Deployment readiness item A3. Server-side revocation via hash blacklist.', status: 'done', priority: 'p0', assignee: 'Maneek', daysAgo: 1 },
];

// ─── Wiki pages ───────────────────────────────────────────────────────
type SeedWiki = {
  type: 'decision' | 'preference' | 'entity' | 'fact' | 'concept';
  title: string;
  slug: string;
  summary: string;
  content: string;
  confidence: number;
  daysAgo: number;
};

const SEED_WIKI: SeedWiki[] = [
  {
    type: 'decision',
    title: 'Use Drizzle ORM for all database queries',
    slug: 'decision-use-drizzle-orm',
    summary: 'All database access goes through Drizzle ORM — no raw SQL except in agent-context tool calls.',
    content: '# Decision: Use Drizzle ORM\n\n**Status:** Accepted\n\nAll queries in `apps/api` and `packages/ai` use Drizzle ORM. The only exceptions are agent tool calls (which need raw parameterized SQL for flexibility) and the backfill scripts (which use `pg.Pool` directly for idempotency).\n\n**Rationale:** type safety end-to-end, compile-time schema validation, and a single source of truth for the schema in `packages/db/src/schema.ts`.\n\n**Reviewed:** 2026-03-18',
    confidence: 0.95,
    daysAgo: 13,
  },
  {
    type: 'decision',
    title: 'Anthropic Sonnet for reasoning, Haiku for classification',
    slug: 'decision-sonnet-reasoning-haiku-classification',
    summary: 'Two-model strategy: Sonnet handles plans/tool use, Haiku handles per-message classification.',
    content: '# Model Routing\n\n**Sonnet 4.6** is the default for agent conversations, plan execution, and anything that needs multi-step reasoning.\n\n**Haiku 4.5** runs the observation pipeline — every incoming message gets classified for intent, entities, and urgency. Haiku is ~20x cheaper per token and fast enough to not add noticeable latency on the write path.\n\n**Fallback:** OpenRouter + Ollama are wired but disabled in prod.\n\n**Prompt caching** is enabled on both: 50-80% cache hit rate for agent conversations in practice.',
    confidence: 0.93,
    daysAgo: 11,
  },
  {
    type: 'decision',
    title: 'Postgres job queue instead of Redis',
    slug: 'decision-postgres-job-queue',
    summary: 'Background workers poll a Postgres table instead of Redis/BullMQ for the trusted-tester scale.',
    content: '# Postgres Job Queue\n\n**Status:** Accepted for launch.\n\nBackground workers claim jobs from the Postgres `job_queue` table. Redis and BullMQ are not runtime dependencies. Revisit the queue backend only when measured throughput, ready-job lag, database pressure, or multi-worker features justify a migration.\n\n**Cost:** no separate queue datastore\n**Scheduled jobs:** registered and processed by the API worker runtime',
    confidence: 0.88,
    daysAgo: 10,
  },
  {
    type: 'preference',
    title: 'Kebab-case files, PascalCase components',
    slug: 'preference-kebab-case-files-pascal-components',
    summary: 'All files use kebab-case. React components use PascalCase for the export name only.',
    content: '# Naming\n\n**Files:** `kebab-case` — e.g., `task-board.tsx`, `agent-runner.ts`.\n**Component exports:** `PascalCase` — e.g., `export function TaskBoard(...)`.\n**Types:** `PascalCase`.\n**Variables + functions:** `camelCase`.\n**Constants:** `SCREAMING_SNAKE_CASE` only when truly global.\n\nRationale: file-naming consistency across the whole monorepo (web, api, packages). PascalCase file names trip up case-insensitive filesystems (Windows).',
    confidence: 0.97,
    daysAgo: 12,
  },
  {
    type: 'entity',
    title: 'Neon — managed Postgres for prod',
    slug: 'entity-neon-postgres',
    summary: 'Neon hosts the `deft-test` project with pgvector 0.8.0 and Postgres 17.8.',
    content: "# Neon\n\nManaged Postgres provider. We use the free tier for the trusted-tester environment.\n\n**Project:** `deft-test`\n**Region:** `aws-us-east-1`\n**Postgres:** 17.8\n**pgvector:** 0.8.0 (installed via `CREATE EXTENSION vector`)\n**Branch:** single `main` branch, no point-in-time restore on the free tier\n\n**Connection string:** see `.deploy-tokens` locally or Railway env vars.",
    confidence: 0.99,
    daysAgo: 2,
  },
  {
    type: 'fact',
    title: 'Deployment readiness — deferred items',
    slug: 'fact-deployment-readiness-deferred',
    summary: 'Items from the April 13 deployment readiness TODO that are NOT blocking trusted-tester launch.',
    content: "# Deferred items\n\n**Deferred for trusted-tester launch (safe because cohort is trusted):**\n- A2: DOMPurify for 8 dangerouslySetInnerHTML sites\n- A4: Rate limiting middleware (Anthropic dashboard cap is the fallback)\n- A5: CSP + HSTS headers\n- B1: GDPR data export / deletion\n- B2: Privacy Policy / ToS\n- C1: Sentry error tracking\n- C2: Database backups beyond Neon's default\n- R2 file uploads (testers warned that uploads are ephemeral)\n\n**Must fix before widening the cohort OR making the URL public.**",
    confidence: 0.91,
    daysAgo: 2,
  },
];

// ─── Seed runner ──────────────────────────────────────────────────────

async function main() {
  console.log('Seeding trusted-tester org with vibrant content…');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Find admin + org
    const adminRes = await client.query(
      'select u.id as user_id, om.org_id from users u join org_members om on om.user_id=u.id where u.email=$1 limit 1',
      [ADMIN_EMAIL],
    );
    if (adminRes.rowCount === 0) {
      throw new Error(`Admin user ${ADMIN_EMAIL} not found. Sign up first.`);
    }
    const adminId = adminRes.rows[0].user_id as string;
    const orgId = adminRes.rows[0].org_id as string;
    console.log(`  admin=${adminId.slice(0, 8)} org=${orgId.slice(0, 8)}`);

    // 2. Create 4 additional users (idempotent by email)
    const userIds: Record<string, string> = { Maneek: adminId };
    for (const u of SEED_USERS) {
      const existing = await client.query('select id from users where email=$1 limit 1', [u.email]);
      let id: string;
      if (existing.rowCount && existing.rowCount > 0) {
        id = existing.rows[0].id;
      } else {
        id = randomUUID();
        const hash = await bcrypt.hash(SEED_PASSWORD, 12);
        await client.query(
          'insert into users (id, name, email, password_hash, email_verified) values ($1, $2, $3, $4, true)',
          [id, u.name, u.email, hash],
        );
        await client.query(
          `insert into org_members (id, org_id, user_id, role, is_active)
           values ($1, $2, $3, 'member', true)
           on conflict (org_id, user_id) do update set is_active=true`,
          [randomUUID(), orgId, id],
        );
      }
      userIds[u.name] = id;
    }
    console.log(`  users seeded: ${Object.keys(userIds).join(', ')}`);

    // 3. Ensure spaces exist + every user is a member
    const spaceIds: Record<string, string> = {};
    // include the auto-created #general if it exists
    const gen = await client.query(
      "select id from spaces where org_id=$1 and name in ('general', '#general') limit 1",
      [orgId],
    );
    if (gen.rowCount && gen.rowCount > 0) {
      spaceIds['general'] = gen.rows[0].id;
    } else {
      const id = randomUUID();
      await client.query(
        `insert into spaces (id, org_id, name, topic, description, type, is_default, created_by)
         values ($1, $2, 'general', 'Company-wide', 'Announcements + everyone', 'public', true, $3)`,
        [id, orgId, adminId],
      );
      spaceIds['general'] = id;
    }

    for (const s of SEED_SPACES) {
      const existing = await client.query(
        'select id from spaces where org_id=$1 and name=$2 limit 1',
        [orgId, s.name],
      );
      let id: string;
      if (existing.rowCount && existing.rowCount > 0) {
        id = existing.rows[0].id;
      } else {
        id = randomUUID();
        await client.query(
          `insert into spaces (id, org_id, name, topic, description, type, is_default, created_by)
           values ($1, $2, $3, $4, $5, 'public', false, $6)`,
          [id, orgId, s.name, s.topic, s.description, adminId],
        );
      }
      spaceIds[s.name] = id;
    }

    // Every user in every space
    for (const spaceId of Object.values(spaceIds)) {
      for (const userId of Object.values(userIds)) {
        await client.query(
          `insert into space_members (id, space_id, user_id, notification_level)
           values ($1, $2, $3, 'all')
           on conflict (space_id, user_id) do nothing`,
          [randomUUID(), spaceId, userId],
        );
      }
    }
    console.log(`  spaces seeded: ${Object.keys(spaceIds).join(', ')}`);

    // 4. Seed messages per space
    async function seedMessages(spaceId: string, messages: SeedMessage[]): Promise<void> {
      let lastParentId: string | null = null;
      for (const m of messages) {
        const id = randomUUID();
        const ts = new Date(NOW - m.days * DAY - m.hours * HOUR);
        const parentId = m.thread ? lastParentId : null;
        const uid = userIds[m.user];
        if (!uid) throw new Error(`unknown user ${m.user}`);

        await client.query(
          `insert into messages (id, org_id, space_id, user_id, content, parent_id, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $7)`,
          [id, orgId, spaceId, uid, m.text, parentId, ts],
        );

        if (!m.thread) {
          lastParentId = id;
        }

        // reactions
        if (m.reactions) {
          for (const r of m.reactions) {
            const reactUid = userIds[r.user];
            if (!reactUid) continue;
            await client.query(
              `insert into reactions (id, message_id, user_id, emoji, created_at, updated_at)
               values ($1, $2, $3, $4, $5, $5)
               on conflict (message_id, user_id, emoji) do nothing`,
              [randomUUID(), id, reactUid, r.emoji, ts],
            );
          }
        }
      }
    }

    await seedMessages(spaceIds['general']!, GENERAL_MESSAGES);
    await seedMessages(spaceIds['engineering']!, ENGINEERING_MESSAGES);
    await seedMessages(spaceIds['design']!, DESIGN_MESSAGES);
    await seedMessages(spaceIds['random']!, RANDOM_MESSAGES);
    await seedMessages(spaceIds['launch']!, LAUNCH_MESSAGES);

    const totalMsgs =
      GENERAL_MESSAGES.length +
      ENGINEERING_MESSAGES.length +
      DESIGN_MESSAGES.length +
      RANDOM_MESSAGES.length +
      LAUNCH_MESSAGES.length;
    console.log(`  messages seeded: ${totalMsgs}`);

    // 5. Create project + tasks
    const projectExisting = await client.query(
      "select id, task_counter from projects where org_id=$1 and prefix='DEFT' limit 1",
      [orgId],
    );
    let projectId: string;
    let taskCounter: number;
    if (projectExisting.rowCount && projectExisting.rowCount > 0) {
      projectId = projectExisting.rows[0].id;
      taskCounter = projectExisting.rows[0].task_counter;
    } else {
      projectId = randomUUID();
      taskCounter = 0;
      await client.query(
        `insert into projects (id, org_id, name, description, prefix, icon, color, lead_id, task_counter)
         values ($1, $2, 'Deft v1', 'Launch-blocking work for the private beta', 'DEFT', '🚀', '#D4A853', $3, 0)`,
        [projectId, orgId, adminId],
      );
    }

    // Link project to #engineering
    await client.query(
      `insert into project_spaces (id, project_id, space_id) values ($1, $2, $3)
       on conflict (project_id, space_id) do nothing`,
      [randomUUID(), projectId, spaceIds['engineering']!],
    );

    let nextNumber = taskCounter + 1;
    for (const t of SEED_TASKS) {
      const id = randomUUID();
      const ts = daysAgo(t.daysAgo);
      const due = t.dueDaysFromNow != null ? new Date(NOW + t.dueDaysFromNow * DAY) : null;
      const assignee = t.assignee ? userIds[t.assignee] : null;
      await client.query(
        `insert into tasks (id, org_id, project_id, number, title, description, status, priority, assignee_id, created_by, due_date, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
        [
          id,
          orgId,
          projectId,
          nextNumber,
          t.title,
          t.description || null,
          t.status,
          t.priority,
          assignee,
          adminId,
          due,
          ts,
        ],
      );
      nextNumber += 1;
    }
    await client.query('update projects set task_counter=$1 where id=$2', [
      nextNumber - 1,
      projectId,
    ]);
    console.log(`  tasks seeded: ${SEED_TASKS.length} in project Deft v1`);

    // 6. Wiki pages
    for (const w of SEED_WIKI) {
      const existing = await client.query(
        'select id from wiki_pages where org_id=$1 and slug=$2 limit 1',
        [orgId, w.slug],
      );
      if (existing.rowCount && existing.rowCount > 0) continue;
      await client.query(
        `insert into wiki_pages (id, org_id, scope, type, title, slug, summary, content, confidence, version, created_at, updated_at)
         values ($1, $2, 'org', $3, $4, $5, $6, $7, $8, 1, $9, $9)`,
        [
          randomUUID(),
          orgId,
          w.type,
          w.title,
          w.slug,
          w.summary,
          w.content,
          w.confidence,
          daysAgo(w.daysAgo),
        ],
      );
    }
    console.log(`  wiki pages seeded: ${SEED_WIKI.length}`);

    // 7. Notes (admin-only personal notes)
    const notes = [
      {
        title: 'Week ahead — tester onboarding',
        icon: '📝',
        content:
          '<h1>Week ahead — tester onboarding</h1><p>Invites going out Monday. Priority checklist:</p><ul><li>Change the admin temp password</li><li>Set ANTHROPIC_API_KEY on Railway api</li><li>Rotate the deploy tokens once the stack is live</li><li>Draft the Friday summary template</li></ul>',
      },
      {
        title: 'Private beta — feedback capture',
        icon: '🎯',
        content:
          '<h1>Feedback capture</h1><p>Loop with each tester via DM. Friday summary goes to #launch.</p><h2>Questions to ask</h2><ul><li>What was the first thing that felt broken?</li><li>What felt magical (even if unfinished)?</li><li>What did they reach for that wasn\'t there?</li></ul>',
      },
    ];
    for (const n of notes) {
      await client.query(
        `insert into notes (id, org_id, user_id, title, content, icon, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [randomUUID(), orgId, adminId, n.title, n.content, n.icon, hoursAgo(3)],
      );
    }
    console.log(`  notes seeded: ${notes.length}`);

    // 8. Calendar events (via events table with source='native')
    const upcomingEvents = [
      {
        title: 'Standup',
        body: 'Daily team standup — 15 min max.',
        offsetHours: 18, // tomorrow morning-ish
        durationMinutes: 15,
      },
      {
        title: 'Sprint retro',
        body: 'Review the gap-fixes sprint. What worked, what to change.',
        offsetHours: 72,
        durationMinutes: 45,
      },
      {
        title: 'Tester onboarding — Aditi',
        body: '1:1 with first tester. Walk through the agent page + gather first impressions.',
        offsetHours: 96,
        durationMinutes: 30,
      },
    ];
    for (const e of upcomingEvents) {
      const start = new Date(NOW + e.offsetHours * HOUR);
      const end = new Date(start.getTime() + e.durationMinutes * MINUTE);
      await client.query(
        `insert into events (id, org_id, source, event_type, title, body, timestamp, metadata, user_id, created_at, updated_at)
         values ($1, $2, 'native', 'calendar_event', $3, $4, $5, $6, $7, $8, $8)`,
        [
          randomUUID(),
          orgId,
          e.title,
          e.body,
          start,
          JSON.stringify({ start_at: start.toISOString(), end_at: end.toISOString(), all_day: false }),
          adminId,
          hoursAgo(2),
        ],
      );
    }
    console.log(`  calendar events seeded: ${upcomingEvents.length}`);

    await client.query('COMMIT');
    console.log('✓ Seed complete.');
    console.log('');
    console.log('Test user logins:');
    console.log(`  ${ADMIN_EMAIL}  (admin, your existing password)`);
    for (const u of SEED_USERS) {
      console.log(`  ${u.email}  password: ${SEED_PASSWORD}`);
    }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Seed failed, rolled back:', e);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
