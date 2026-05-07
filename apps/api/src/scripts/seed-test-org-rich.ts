#!/usr/bin/env tsx
/**
 * seed-test-org-rich — layer rich supplementary content on top of the
 * initial seed-test-org.ts run. Testers land in a workspace that looks
 * like a team that's been shipping for months, not a 3-day-old sandbox.
 *
 * Adds (on top of whatever seed-test-org.ts created):
 *   - ~100 more messages in the 5 existing spaces with realistic
 *     day/week-old chatter, threads, reactions, pinned items
 *   - 8 DM conversations (direct message spaces) with 15-25 msgs each
 *   - 1 group DM with 4 participants
 *   - 2 more projects (Design System "DS", Growth Experiments "GRO")
 *     with ~15 tasks each, task labels, due dates, subtasks, and
 *     activity history entries
 *   - 6 task labels applied across all three projects
 *   - 20 more wiki pages spanning every type with cross-links
 *     (wiki_links) and citations back to real seed messages
 *   - 6 more personal notes distributed across all 5 users
 *   - 22 calendar events — weekly standup cadence for 4 weeks, 1:1s,
 *     sprint retros, product review, demo day
 *   - 5 message pins per space
 *   - 7 message bookmarks for the admin
 *   - ~60 more emoji reactions
 *
 * Idempotent on: user creation, wiki slugs, labels, project prefixes.
 * Additive on: messages, reactions, pins, bookmarks (safe to run once
 * but not repeatedly or you'll duplicate content).
 *
 * Usage:
 *   DATABASE_URL=... ADMIN_EMAIL=maneek@deft.test \
 *     pnpm --filter @deft/api exec tsx src/scripts/seed-test-org-rich.ts
 */
import 'dotenv/config';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'maneek@deft.test';

const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const hoursAgo = (h: number) => new Date(NOW - h * HOUR);
const daysAgo = (d: number) => new Date(NOW - d * DAY);
const daysFromNow = (d: number) => new Date(NOW + d * DAY);
const hoursFromNow = (h: number) => new Date(NOW + h * HOUR);

// ═══════════════════════════════════════════════════════════════════
// Content blocks — additional messages per space
// ═══════════════════════════════════════════════════════════════════

type ExtraMsg = {
  user: string;
  text: string;
  days: number;
  hours: number;
  replies?: { user: string; text: string; hoursAfter: number; reactions?: { user: string; emoji: string }[] }[];
  reactions?: { user: string; emoji: string }[];
  pin?: boolean;
};

const EXTRA_GENERAL: ExtraMsg[] = [
  {
    user: 'Maneek',
    text: "<p><strong>New hire intro:</strong> welcome to <strong>Arjun Rao</strong> joining us on product-design. Arjun spent the last three years at Linear building their kanban and timeline views. He'll be leading the design system rebuild and the Knowledge page redesign.</p>",
    days: 20,
    hours: 8,
    reactions: [
      { user: 'Priya Shah', emoji: '🎉' }, { user: 'Rahul Mehta', emoji: '👋' }, { user: 'Sara Kim', emoji: '🙌' }, { user: 'Arjun Rao', emoji: '🙏' },
    ],
    pin: true,
  },
  {
    user: 'Arjun Rao',
    text: "<p>Thanks everyone! Excited to be here. Happy to pair or review Figma files with anyone this week. I'll be mostly in #design but poke me anywhere.</p>",
    days: 20,
    hours: 7,
    replies: [
      { user: 'Rahul Mehta', text: "<p>Welcome! I'll have some icon-audit questions tomorrow.</p>", hoursAfter: 1 },
      { user: 'Sara Kim', text: "<p>Let's grab coffee later this week, I want to show you the old design system so you can tell me where to start.</p>", hoursAfter: 3, reactions: [{ user: 'Arjun Rao', emoji: '☕' }] },
    ],
  },
  {
    user: 'Maneek',
    text: "<p><strong>All-hands — Friday 3pm.</strong> 30 min. Agenda:</p><ul><li>Private beta recap (who's in, feedback channels)</li><li>Sprint review — what shipped in the gap-fixes plan</li><li>Next sprint preview — R2 uploads, DOMPurify, Sentry</li><li>Q&amp;A</li></ul><p>Notes doc will be in the wiki after.</p>",
    days: 4,
    hours: 10,
    reactions: [{ user: 'Priya Shah', emoji: '📅' }, { user: 'Sara Kim', emoji: '👍' }, { user: 'Rahul Mehta', emoji: '✅' }],
    pin: true,
  },
  {
    user: 'Priya Shah',
    text: "<p><em>Standup — Wednesday.</em></p><p><strong>Yesterday:</strong> Landed the gateway health UI error-state variant and pushed the Sentry wiring PR. <strong>Today:</strong> DOMPurify spike for gap A2. <strong>Blockers:</strong> None.</p>",
    days: 8,
    hours: 12,
  },
  {
    user: 'Rahul Mehta',
    text: "<p><em>Standup — Wednesday.</em></p><p><strong>Yesterday:</strong> Fixed the wiki embedding migration (gap #10) and shipped the chat p-to-div fix (#2). <strong>Today:</strong> Starting the server-side logout endpoint work. <strong>Blockers:</strong> Need to confirm the refresh-token storage model with Maneek before I create the <code>revoked_tokens</code> table.</p>",
    days: 8,
    hours: 11,
  },
  {
    user: 'Maneek',
    text: "<p>@Rahul confirmed — we're stateless JWT with no refresh_tokens table today. Go with option B (revoked_tokens blacklist keyed by sha256 of the token).</p>",
    days: 8,
    hours: 10,
    reactions: [{ user: 'Rahul Mehta', emoji: '👍' }],
  },
  {
    user: 'Sara Kim',
    text: "<p><em>Standup — Wednesday.</em></p><p><strong>Yesterday:</strong> Finished the gateway card error-state variant. Did a design review of the Agent page with Arjun. <strong>Today:</strong> Redesigning the Knowledge empty state and cleaning up the 'Entitie' label leak on wiki cards. <strong>Blockers:</strong> None.</p>",
    days: 8,
    hours: 9,
  },
  {
    user: 'Arjun Rao',
    text: "<p><em>Standup — Wednesday.</em></p><p><strong>Yesterday:</strong> Migrated 60% of the Figma tokens to the new design system file. <strong>Today:</strong> Finishing the migration + starting on the task detail panel redesign. <strong>Blockers:</strong> None.</p>",
    days: 8,
    hours: 8,
  },
  {
    user: 'Maneek',
    text: "<p>Heads up — Neon free-tier DB is at 28% capacity after this week's tester activity. Plenty of headroom for the trusted cohort but worth tracking. I'll add a Grafana panel after we get Sentry in.</p>",
    days: 3,
    hours: 14,
  },
  {
    user: 'Priya Shah',
    text: "<p>Quick question for the team — should we let testers see other testers' activity or scope each tester to their own sandbox org?</p>",
    days: 5,
    hours: 16,
    replies: [
      { user: 'Rahul Mehta', text: "<p>One shared org is simpler and more realistic. Plus the agent sees more data that way.</p>", hoursAfter: 1 },
      { user: 'Maneek', text: "<p>Agreed. Shared org. If we hear from any tester that they want isolation we can create a second org quickly.</p>", hoursAfter: 2, reactions: [{ user: 'Priya Shah', emoji: '👍' }] },
      { user: 'Sara Kim', text: "<p>Makes the activity feed on the dashboard way more interesting too.</p>", hoursAfter: 3 },
    ],
  },
];

const EXTRA_ENGINEERING: ExtraMsg[] = [
  {
    user: 'Rahul Mehta',
    text: "<p>Just pushed a perf fix on the agent-runner. The prompt-caching path was regenerating the system block every turn because the mutation was spreading it. Cache hit rate jumped from 42% to 81% in local testing.</p>",
    days: 14,
    hours: 15,
    reactions: [{ user: 'Maneek', emoji: '🔥' }, { user: 'Priya Shah', emoji: '📈' }],
    pin: true,
  },
  {
    user: 'Priya Shah',
    text: "<p>Can we standardize how we reference <code>env.RESEND_API_KEY</code> vs <code>process.env.RESEND_API_KEY</code>? I'm seeing both across the routes and I don't know which one is canonical.</p>",
    days: 16,
    hours: 11,
    replies: [
      { user: 'Rahul Mehta', text: "<p><code>env</code> is the zod-validated import from <code>./lib/env.ts</code>. Prefer it everywhere except scripts under <code>src/scripts/</code> where we haven't wired it in yet.</p>", hoursAfter: 1, reactions: [{ user: 'Priya Shah', emoji: '🙏' }] },
      { user: 'Priya Shah', text: "<p>Perfect. I'll open a chore PR to migrate the stragglers.</p>", hoursAfter: 2 },
    ],
  },
  {
    user: 'Maneek',
    text: "<p>Wrote up a note on the <strong>agent context window strategy</strong> — it's in the wiki now. Short version: we inject native SQL results directly into the turn's context and let Sonnet's 1M-context handle it, rather than pre-chunking. Works great for the current data sizes, need to revisit if any org hits &gt; 10k messages.</p>",
    days: 15,
    hours: 9,
    reactions: [{ user: 'Rahul Mehta', emoji: '📝' }, { user: 'Arjun Rao', emoji: '🧠' }],
  },
  {
    user: 'Arjun Rao',
    text: "<p>FYI — Next.js 16.2.1 hydration-mismatch warnings on the tasks page are gone after the p→div fix. Before we were seeing three per page load. Net zero now.</p>",
    days: 6,
    hours: 17,
  },
  {
    user: 'Rahul Mehta',
    text: "<p>Weird bug I'm tracking: sometimes the agent-runner's tool-call response JSON has a trailing comma that breaks Anthropic's parser. Happens ~1/30 runs. I think it's the classifier inserting metadata after the fact.</p>",
    days: 9,
    hours: 13,
    replies: [
      { user: 'Maneek', text: "<p>Is this blocking anything? If not, let's file it and move on — the agent retries usually work around it.</p>", hoursAfter: 2 },
      { user: 'Rahul Mehta', text: "<p>Not blocking. Will file a DEFT ticket and move on.</p>", hoursAfter: 3 },
    ],
  },
  {
    user: 'Sara Kim',
    text: "<p>Design question for engineering — for the mention autocomplete dropdown, should we show avatar images or just initials? Currently it's initials for DX reasons but avatars would feel more 'real'. What's the lift to wire avatars?</p>",
    days: 11,
    hours: 18,
    replies: [
      { user: 'Priya Shah', text: "<p>Avatars require the image pipeline which we haven't built. Initials is ~1 hour of work, avatars is ~1 day. Vote for initials until we have R2.</p>", hoursAfter: 1 },
      { user: 'Sara Kim', text: "<p>Fine. Initials. I'll use the color palette from the design tokens so they at least feel branded.</p>", hoursAfter: 2 },
    ],
  },
  {
    user: 'Maneek',
    text: "<p>Phase 12 rollout is <strong>fully green</strong>. FEATURE_OPENCLAW_EMPLOYEES flag is on for the trusted-tester org. Alex PM first-party template is live. Next milestone: Phase 13 — adding the plan-step pause/resume runtime.</p>",
    days: 7,
    hours: 14,
    reactions: [{ user: 'Priya Shah', emoji: '🎉' }, { user: 'Rahul Mehta', emoji: '🚀' }, { user: 'Sara Kim', emoji: '🔥' }],
    pin: true,
  },
  {
    user: 'Priya Shah',
    text: "<p>Found a race in the socket reconnect path — when a user loses network for &gt; 30s and comes back, the first socket frame can arrive before the auth handshake completes and gets dropped. Reproducible locally. Patching.</p>",
    days: 4,
    hours: 16,
  },
  {
    user: 'Rahul Mehta',
    text: "<p>Nice catch. Is the fix in middleware or at the socket layer?</p>",
    days: 4,
    hours: 15,
  },
  {
    user: 'Priya Shah',
    text: "<p>Socket layer — I'm queueing frames until the auth promise resolves. Two-line fix.</p>",
    days: 4,
    hours: 14,
    reactions: [{ user: 'Rahul Mehta', emoji: '👍' }],
  },
  {
    user: 'Arjun Rao',
    text: "<p>Architecture question: should projects get their own kanban layout, or should all projects share the same 5-column template? Asking because a tester might want a different workflow for design tasks vs engineering tasks.</p>",
    days: 12,
    hours: 13,
    replies: [
      { user: 'Maneek', text: "<p>Shared template for v1. Per-project column customization is on the wishlist but not priority. Let's see if testers ask for it.</p>", hoursAfter: 1 },
    ],
  },
  {
    user: 'Sara Kim',
    text: "<p>The <code>action_receipt</code> schema we added in phase 7 — are we surfacing it in the UI anywhere yet? I'd like to add a 'view receipt' affordance on the agent action log, maybe as a popover with the signed payload.</p>",
    days: 2,
    hours: 19,
    replies: [
      { user: 'Rahul Mehta', text: "<p>It's on the Settings &gt; Agent page under Action Log — click View Receipt on any row. The popover you described is a great idea, go for it.</p>", hoursAfter: 1, reactions: [{ user: 'Sara Kim', emoji: '🙏' }] },
    ],
  },
];

const EXTRA_DESIGN: ExtraMsg[] = [
  {
    user: 'Sara Kim',
    text: "<p>Here's the icon audit result — we have <strong>47 unique icons</strong> across the app, but only 23 are actually used in more than one place. Deleting the orphans and consolidating duplicates.</p>",
    days: 19,
    hours: 11,
    reactions: [{ user: 'Arjun Rao', emoji: '🧹' }],
    pin: true,
  },
  {
    user: 'Arjun Rao',
    text: "<p>Design system proposal — move from <code>lucide-react</code> inline to a tokenized <code>&lt;Icon name=\"...\"/&gt;</code> wrapper component. Pros: easier theming, swap entire icon set later. Cons: one more layer of abstraction.</p><p>Thoughts?</p>",
    days: 17,
    hours: 14,
    replies: [
      { user: 'Sara Kim', text: "<p>I'm +1. Let's do it. The theming story is worth the layer.</p>", hoursAfter: 1 },
      { user: 'Maneek', text: "<p>Sure, but don't block on the rewrite — do it incrementally as you touch files.</p>", hoursAfter: 2, reactions: [{ user: 'Arjun Rao', emoji: '✅' }] },
    ],
  },
  {
    user: 'Sara Kim',
    text: "<p>New in Figma: <em>Notification toast</em> variants (success / info / warning / error) with dismiss animations. Will match the existing button tokens. Ping me before you build the toast component so I can walk through the hover/dismiss states.</p>",
    days: 13,
    hours: 10,
  },
  {
    user: 'Arjun Rao',
    text: "<p>Task detail panel redesign — first pass is in Figma. Bigger changes:</p><ul><li>Description field is full-width at the top (instead of cramped in the sidebar)</li><li>Activity and Comments share a tab, not two separate ones</li><li>Attachments moved to the bottom instead of nested in description</li></ul><p>Looking for feedback from engineering before I push the Figma handoff.</p>",
    days: 6,
    hours: 15,
    replies: [
      { user: 'Priya Shah', text: "<p>Love the full-width description. Tab consolidation is a great call — I was always annoyed by the Activity tab being so sparse.</p>", hoursAfter: 2 },
      { user: 'Rahul Mehta', text: "<p>On tab consolidation — should recent activity bubble to the top of the tab like a changelog, or stay chronological?</p>", hoursAfter: 4 },
      { user: 'Arjun Rao', text: "<p>Reverse-chron by default, toggle to show all. The activity gets noisy on tasks that move a lot.</p>", hoursAfter: 5 },
    ],
  },
  {
    user: 'Arjun Rao',
    text: "<p>Reminder that the tokens live in <code>apps/web/src/app/globals.css</code> under CSS custom properties. If you're writing inline styles please use <code>var(--color-accent)</code> not hex values. Makes the Obsidian dark mode theme actually work.</p>",
    days: 10,
    hours: 12,
    pin: true,
  },
  {
    user: 'Sara Kim',
    text: "<p>Fun experiment — I made a Figma plugin that pulls our current CSS variables and injects them as Figma styles. Not production-ready but it closes the design-engineering loop nicely. Happy to demo if anyone's curious.</p>",
    days: 5,
    hours: 19,
    reactions: [{ user: 'Arjun Rao', emoji: '🤯' }, { user: 'Priya Shah', emoji: '👀' }],
  },
];

const EXTRA_RANDOM: ExtraMsg[] = [
  {
    user: 'Arjun Rao',
    text: "<p>Obligatory 'I found a cool link' post: <em>The Playwright team just open-sourced a new MCP server</em>. Worth looking at if we want to give our agent real browser-automation tools.</p>",
    days: 14,
    hours: 16,
    reactions: [{ user: 'Rahul Mehta', emoji: '👀' }],
  },
  {
    user: 'Priya Shah',
    text: "<p>The new Apple Silicon M5 MacBook Pro benchmarks dropped. Node.js compiles are ~2x faster than M3 Max. Tempted to upgrade.</p>",
    days: 8,
    hours: 21,
    replies: [
      { user: 'Maneek', text: "<p>Make sure it counts as a business expense 😉</p>", hoursAfter: 1, reactions: [{ user: 'Priya Shah', emoji: '😄' }] },
    ],
  },
  {
    user: 'Sara Kim',
    text: "<p>Who else has been watching the Severance S3 trailer? 👀</p>",
    days: 6,
    hours: 22,
    reactions: [{ user: 'Arjun Rao', emoji: '👁️' }, { user: 'Rahul Mehta', emoji: '🍝' }],
  },
  {
    user: 'Rahul Mehta',
    text: "<p>Recipe: someone please try the sheet-pan gnocchi with cherry tomatoes and basil. Ridiculously easy, 20 min, zero cleanup.</p>",
    days: 4,
    hours: 18,
  },
  {
    user: 'Maneek',
    text: "<p>Office coffee machine is down again. Third time this month. Filing a ticket with facilities. If anyone wants to do a coffee run I'll venmo.</p>",
    days: 3,
    hours: 10,
    reactions: [{ user: 'Priya Shah', emoji: '☕' }, { user: 'Sara Kim', emoji: '😭' }],
  },
  {
    user: 'Arjun Rao',
    text: "<p>Shoutout to whoever's been using the agent to summarize standups for the weekly update doc. Saved me like an hour this week.</p>",
    days: 2,
    hours: 14,
    reactions: [{ user: 'Maneek', emoji: '🤖' }, { user: 'Rahul Mehta', emoji: '⏱️' }],
  },
];

const EXTRA_LAUNCH: ExtraMsg[] = [
  {
    user: 'Maneek',
    text: "<p>Initial tester list locked. Sending invites Monday morning. Each tester gets: URL, email, temp password (or Resend-delivered email if we wire it in time), and a one-page 'known limitations' doc.</p>",
    days: 9,
    hours: 10,
    pin: true,
  },
  {
    user: 'Priya Shah',
    text: "<p>Drafted the known-limitations doc. Eight bullets: uploads are ephemeral, no rate limiting, XSS sanitizer deferred, no backups, no real-time presence polish, etc. Want a review?</p>",
    days: 9,
    hours: 9,
    replies: [
      { user: 'Maneek', text: "<p>Yes please. Share the Figma comment link.</p>", hoursAfter: 1 },
      { user: 'Priya Shah', text: "<p>Sent. Review when you have a minute.</p>", hoursAfter: 1 },
    ],
  },
  {
    user: 'Rahul Mehta',
    text: "<p>Pre-flight: I'll run the gap-fixes audit against the live Railway URLs once we have them. Will post results here before any tester signs in.</p>",
    days: 3,
    hours: 13,
  },
  {
    user: 'Sara Kim',
    text: "<p>I'll put together a 1-minute Loom walking through the five key surfaces (chat, tasks, agent, knowledge, notes) so testers have something to anchor on if they get lost.</p>",
    days: 5,
    hours: 16,
    reactions: [{ user: 'Maneek', emoji: '📹' }, { user: 'Priya Shah', emoji: '🎬' }],
  },
  {
    user: 'Arjun Rao',
    text: "<p>Cosmetic one for the invite email — let's lead with the agent capabilities, not the chat. That's the differentiator and it's what'll hook them.</p>",
    days: 5,
    hours: 14,
    reactions: [{ user: 'Maneek', emoji: '💯' }],
  },
  {
    user: 'Maneek',
    text: "<p>Invite template revised. Leading paragraph is now 'Deft is a workspace with an AI agent that has direct SQL access to your data'. Everyone ok with that framing?</p>",
    days: 5,
    hours: 12,
    replies: [
      { user: 'Rahul Mehta', text: "<p>Yes — that framing is honest and specific. 'Direct SQL access' is the thing nobody else has.</p>", hoursAfter: 1 },
      { user: 'Sara Kim', text: "<p>+1. Much better than 'AI-native workspace' which has become meaningless.</p>", hoursAfter: 2 },
    ],
  },
  {
    user: 'Maneek',
    text: "<p><strong>Deploy status:</strong> Neon Postgres is up with pgvector. Railway api service is live. Railway web service is live. First admin user created. Smoke test passed. First invite going out in 30 minutes.</p>",
    days: 0,
    hours: 2,
    reactions: [{ user: 'Priya Shah', emoji: '🎉' }, { user: 'Rahul Mehta', emoji: '🚀' }, { user: 'Sara Kim', emoji: '🔥' }, { user: 'Arjun Rao', emoji: '💪' }],
    pin: true,
  },
];

// ═══════════════════════════════════════════════════════════════════
// DM conversations — realistic 1:1 chats
// ═══════════════════════════════════════════════════════════════════

type DmConvo = {
  participants: string[]; // user names
  messages: { user: string; text: string; days: number; hours: number }[];
};

const DM_CONVERSATIONS: DmConvo[] = [
  {
    participants: ['Maneek', 'Rahul Mehta'],
    messages: [
      { user: 'Maneek', text: "<p>hey, quick one — can you look at the audit script failure I saw on master last night? I think it's the session-2 timeout</p>", days: 12, hours: 15 },
      { user: 'Rahul Mehta', text: "<p>yeah I saw it. bumped the tavily-bound test timeout to 240s, PR up now</p>", days: 12, hours: 14 },
      { user: 'Maneek', text: "<p>perfect. approved.</p>", days: 12, hours: 14 },
      { user: 'Maneek', text: "<p>also — are you OK to own the wiki embedding fix? it's gap #10 from the sweep</p>", days: 8, hours: 18 },
      { user: 'Rahul Mehta', text: "<p>yes. I'll start tomorrow</p>", days: 8, hours: 17 },
      { user: 'Rahul Mehta', text: "<p>tough one actually. the migration exists on disk but was never applied. dev postgres on windows doesn't have pgvector so I can't just re-run it. need to use a bytea workaround locally</p>", days: 8, hours: 16 },
      { user: 'Maneek', text: "<p>document it in the commit message. prod neon will have real pgvector so the workaround is local-only</p>", days: 8, hours: 15 },
      { user: 'Rahul Mehta', text: "<p>done. commit 520eb5a</p>", days: 7, hours: 11 },
      { user: 'Maneek', text: "<p>🙌</p>", days: 7, hours: 11 },
      { user: 'Maneek', text: "<p>how's the server-logout work going?</p>", days: 4, hours: 16 },
      { user: 'Rahul Mehta', text: "<p>landed. revoked_tokens table + sha256 hash check in /auth/refresh. gap-fixes audit #server-logout is green</p>", days: 4, hours: 15 },
      { user: 'Maneek', text: "<p>amazing. that closes deployment TODO A3</p>", days: 4, hours: 15 },
    ],
  },
  {
    participants: ['Maneek', 'Sara Kim'],
    messages: [
      { user: 'Sara Kim', text: "<p>hey — want to do a design review of the onboarding flow? I've got the revised mocks</p>", days: 11, hours: 16 },
      { user: 'Maneek', text: "<p>yes, tomorrow 10am good?</p>", days: 11, hours: 15 },
      { user: 'Sara Kim', text: "<p>👍</p>", days: 11, hours: 15 },
      { user: 'Sara Kim', text: "<p>ok the review was great. a couple notes I'll turn into Figma comments</p>", days: 10, hours: 21 },
      { user: 'Sara Kim', text: "<p>one thing I want to flag — the wiki entity label rendering 'Entitie'. I can fix it inline while I'm there if you're ok with me touching that file</p>", days: 9, hours: 14 },
      { user: 'Maneek', text: "<p>go for it. file is apps/web/src/app/(app)/knowledge/page.tsx. there's a bunch of naive type.slice(0,-1) calls that need to become a real label map</p>", days: 9, hours: 14 },
      { user: 'Sara Kim', text: "<p>perfect. will PR tomorrow</p>", days: 9, hours: 14 },
      { user: 'Maneek', text: "<p>actually two more — the agent page 'Defty/Alex PM' tab split, and the notes preview leaking 'Heading 1' labels. separate tickets unless you want to bundle</p>", days: 6, hours: 19 },
      { user: 'Sara Kim', text: "<p>separate. I want clean PRs per fix so reviewers don't get scope-creeped</p>", days: 6, hours: 18 },
      { user: 'Maneek', text: "<p>agreed. good discipline</p>", days: 6, hours: 18 },
    ],
  },
  {
    participants: ['Priya Shah', 'Rahul Mehta'],
    messages: [
      { user: 'Priya Shah', text: "<p>looking at your env.ts PR — is there a reason you're using zod's safeParse instead of parse? I noticed the error messages are less helpful with safeParse</p>", days: 17, hours: 11 },
      { user: 'Rahul Mehta', text: "<p>yeah — I want the app to boot even if some env vars are missing, so we can log which ones are missing instead of crashing immediately. safeParse returns a result object and I check which keys are undefined</p>", days: 17, hours: 10 },
      { user: 'Priya Shah', text: "<p>got it. makes sense for graceful degradation. maybe add a startup warning log that lists which optional vars are missing so devs see it in the terminal</p>", days: 17, hours: 10 },
      { user: 'Rahul Mehta', text: "<p>yes, good idea. doing that now</p>", days: 17, hours: 9 },
      { user: 'Priya Shah', text: "<p>btw — are you around for the socket.io refactor? I want to pair on the reconnect race when you have time</p>", days: 4, hours: 12 },
      { user: 'Rahul Mehta', text: "<p>tomorrow 2pm-4pm I'm free. drop a calendar event and I'll prep the repro</p>", days: 4, hours: 11 },
      { user: 'Priya Shah', text: "<p>done. see you then</p>", days: 4, hours: 11 },
      { user: 'Priya Shah', text: "<p>ps your <code>audit-receipts.audit.ts</code> test is flaky btw. not urgent but FYI</p>", days: 10, hours: 18 },
      { user: 'Rahul Mehta', text: "<p>yeah I've been meaning to fix that. it's the canonicalize step racing with the embedding backfill. mutex fix coming</p>", days: 10, hours: 17 },
    ],
  },
  {
    participants: ['Sara Kim', 'Arjun Rao'],
    messages: [
      { user: 'Sara Kim', text: "<p>welcome again! let me walk you through our current design system when you have time</p>", days: 20, hours: 7 },
      { user: 'Arjun Rao', text: "<p>yes please. this afternoon?</p>", days: 20, hours: 6 },
      { user: 'Sara Kim', text: "<p>3pm, I'll DM the Figma link</p>", days: 20, hours: 6 },
      { user: 'Arjun Rao', text: "<p>walked through it. the token structure is solid but the component library is thin. I have ideas</p>", days: 19, hours: 20 },
      { user: 'Sara Kim', text: "<p>tell me everything</p>", days: 19, hours: 19 },
      { user: 'Arjun Rao', text: "<p>1) move from inline lucide to a wrapper component (I'll propose in #design)<br>2) add a typography scale to the token set, right now we're hardcoding text-[13px] everywhere<br>3) build a Card primitive — I counted 8 different card styles across the app</p>", days: 19, hours: 18 },
      { user: 'Sara Kim', text: "<p>+1 to all three. let's agree on the icon wrapper first, then typography, then Card. I'll pair with you on whichever you want to start</p>", days: 19, hours: 17 },
      { user: 'Arjun Rao', text: "<p>icon wrapper, today if you're free. then I can unblock Priya tomorrow</p>", days: 19, hours: 16 },
      { user: 'Sara Kim', text: "<p>perfect. start a figma file and drop the link</p>", days: 19, hours: 15 },
    ],
  },
  {
    participants: ['Maneek', 'Vishesh'],
    messages: [
      { user: 'Maneek', text: "<p>welcome Vishesh! you're in the trusted-tester cohort for Deft's private beta. sign in at the URL I sent and let me know if anything breaks</p>", days: 0, hours: 1 },
      { user: 'Maneek', text: "<p>few things to know: the agent has full context on the workspace, so ask it anything about the tasks/messages/wiki pages. feedback loop is DM directly to me</p>", days: 0, hours: 1 },
    ],
  },
  {
    participants: ['Rahul Mehta', 'Sara Kim'],
    messages: [
      { user: 'Rahul Mehta', text: "<p>hey — question on the notification toast component. should I wait for your dismiss-animation spec or can I ship a plain fade-out for now?</p>", days: 12, hours: 14 },
      { user: 'Sara Kim', text: "<p>ship the fade-out. I'll do an upgrade PR when the spec is final. unblocks you today</p>", days: 12, hours: 14 },
      { user: 'Rahul Mehta', text: "<p>🙏</p>", days: 12, hours: 13 },
    ],
  },
  {
    participants: ['Priya Shah', 'Arjun Rao'],
    messages: [
      { user: 'Priya Shah', text: "<p>can you look at the task detail panel in Figma? I want to reference it for the notification preferences UI</p>", days: 15, hours: 13 },
      { user: 'Arjun Rao', text: "<p>yeah, here: figma.com/file/xyz. the important things: sidebar fields stack vertically on narrow widths, and the tab bar is sticky-top so long descriptions don't push it off-screen</p>", days: 15, hours: 12 },
      { user: 'Priya Shah', text: "<p>got it. stealing the sticky tab pattern</p>", days: 15, hours: 12 },
    ],
  },
  {
    participants: ['Maneek', 'Arjun Rao'],
    messages: [
      { user: 'Maneek', text: "<p>how's the onboarding?</p>", days: 18, hours: 11 },
      { user: 'Arjun Rao', text: "<p>going well. I have my git access, figma access, and the local dev env is up. Sara walked me through the design system yesterday — it's solid but thin, I already have 3-4 proposals</p>", days: 18, hours: 10 },
      { user: 'Maneek', text: "<p>great. post proposals in #design and tag me for the architectural ones</p>", days: 18, hours: 10 },
      { user: 'Arjun Rao', text: "<p>will do. I'll also take a pass at the gap list from the sweep — gap #9 (entities plural) looks like a quick win for me to land my first PR</p>", days: 18, hours: 9 },
      { user: 'Maneek', text: "<p>perfect first PR. easy to review, real impact</p>", days: 18, hours: 9 },
    ],
  },
];

const GROUP_DM: DmConvo = {
  participants: ['Maneek', 'Rahul Mehta', 'Priya Shah', 'Sara Kim'],
  messages: [
    { user: 'Maneek', text: "<p>small group for the launch week handoffs. I'll post tester feedback summaries here every Friday. anything urgent also goes here</p>", days: 6, hours: 9 },
    { user: 'Priya Shah', text: "<p>👍</p>", days: 6, hours: 9 },
    { user: 'Rahul Mehta', text: "<p>should we add Arjun? he's been shipping design PRs this week</p>", days: 6, hours: 8 },
    { user: 'Maneek', text: "<p>yes, good call. adding him after the first sync</p>", days: 6, hours: 8 },
    { user: 'Sara Kim', text: "<p>I have the intro Loom ready btw. 47 seconds, walks through chat → tasks → agent → knowledge. want me to embed it in the invite email or share as a standalone?</p>", days: 5, hours: 15 },
    { user: 'Maneek', text: "<p>embed. shorter friction. testers won't click an external link</p>", days: 5, hours: 14 },
    { user: 'Priya Shah', text: "<p>ok — status: gap-fixes audit 15/15, A1 password logging fix committed, deploy runbook v2 in docs/, .railwayignore in place. green light from me</p>", days: 1, hours: 10 },
    { user: 'Rahul Mehta', text: "<p>green light from me too. I'll run the remote audit once we have the Railway URLs</p>", days: 1, hours: 10 },
    { user: 'Sara Kim', text: "<p>design is green — Knowledge empty state is shipped, mention pill tokenized, onboarding copy reviewed</p>", days: 1, hours: 9 },
  ],
};

// ═══════════════════════════════════════════════════════════════════
// Second + third projects
// ═══════════════════════════════════════════════════════════════════

type SeedTask2 = {
  title: string;
  description?: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done';
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  assignee?: string;
  daysAgo: number;
  dueDaysFromNow?: number;
  labels?: string[];
  subtasks?: { title: string; status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' }[];
};

const PROJECT_DESIGN_SYSTEM: SeedTask2[] = [
  { title: 'Tokenize icon set to <Icon name="..."/> wrapper', description: 'Move from inline lucide-react to a tokenized wrapper. Proposal was in #design.', status: 'in_progress', priority: 'p2', assignee: 'Arjun Rao', daysAgo: 14, labels: ['design'] },
  { title: 'Build <Card> primitive with 3 variants', description: '8 different card styles across the app. Consolidate into 1 primitive with variants: default, elevated, interactive.', status: 'in_progress', priority: 'p2', assignee: 'Arjun Rao', daysAgo: 12, labels: ['design'], dueDaysFromNow: 7 },
  { title: 'Typography scale in design tokens', description: 'Right now we hardcode text-[13px], text-[11px] everywhere. Add a proper scale to globals.css.', status: 'todo', priority: 'p2', assignee: 'Sara Kim', daysAgo: 11, dueDaysFromNow: 10 },
  { title: 'Notification toast — 4 variants (success/info/warning/error)', description: 'Matches existing button tokens. Dismiss animation spec pending.', status: 'todo', priority: 'p3', assignee: 'Sara Kim', daysAgo: 10, dueDaysFromNow: 14, labels: ['design'] },
  { title: 'Figma → CSS variable sync plugin', description: "Sara's side-project. Pulls Figma styles and emits globals.css. Not production-ready, demo-only.", status: 'backlog', priority: 'p3', assignee: 'Sara Kim', daysAgo: 5 },
  { title: 'Audit + consolidate 47 unique icons → 23', description: 'Delete orphans, unify duplicates. Icon audit result pinned in #design.', status: 'in_review', priority: 'p3', assignee: 'Arjun Rao', daysAgo: 3, dueDaysFromNow: 2 },
  { title: 'Agent page header redesign', description: "Tab split between Defty / Alex PM feels unclear. Dropdown 'Switch agent' proposed but deferred.", status: 'backlog', priority: 'p3', assignee: 'Sara Kim', daysAgo: 5 },
  { title: 'Dark mode contrast audit', description: 'Audit all text for WCAG AA contrast against the Obsidian dark theme.', status: 'todo', priority: 'p2', assignee: 'Arjun Rao', daysAgo: 8, dueDaysFromNow: 14, labels: ['a11y'] },
  { title: 'Empty state illustrations', description: 'Dashboard, Knowledge, Notes all need empty-state illustrations. Aiming for consistent style.', status: 'backlog', priority: 'p3', assignee: 'Sara Kim', daysAgo: 7 },
  { title: 'Responsive: task board horizontal scroll on mobile', description: 'Board columns are too wide to fit on phone. Add horizontal scroll or collapsed column view.', status: 'in_progress', priority: 'p2', assignee: 'Arjun Rao', daysAgo: 4, dueDaysFromNow: 5, labels: ['mobile', 'bug'] },
  { title: 'Knowledge page empty state redesign', description: 'Current copy is text-heavy. Replace with illustration + 3 quick-start actions.', status: 'done', priority: 'p3', assignee: 'Sara Kim', daysAgo: 6 },
  { title: 'Figma: migrate 60% → 100% tokens to new file', description: 'Ongoing migration from old design system. Finished during sprint 5.', status: 'done', priority: 'p2', assignee: 'Arjun Rao', daysAgo: 9 },
  { title: 'Mention pill color token', description: "Hardcoded 'rgba(212,168,83,0.15)' in rich-composer. Move to design token.", status: 'done', priority: 'p3', assignee: 'Arjun Rao', daysAgo: 9 },
  { title: 'Spinner component polish', description: 'Current spinner is the Next.js default. Replace with tokenized spinner matching the accent color.', status: 'todo', priority: 'p3', assignee: 'Sara Kim', daysAgo: 6, labels: ['design'] },
  { title: 'Header drop-shadow token', description: 'Subtle shadow for sticky headers. Currently inconsistent — sometimes no shadow, sometimes heavy.', status: 'backlog', priority: 'p3', assignee: 'Arjun Rao', daysAgo: 7 },
];

const PROJECT_GROWTH: SeedTask2[] = [
  { title: 'Ship public marketing site (stub)', description: 'Single landing page at deft.dev with a waitlist form and a link to private beta.', status: 'backlog', priority: 'p1', assignee: 'Maneek', daysAgo: 12, dueDaysFromNow: 21, labels: ['marketing'] },
  { title: 'Tester interview #1 — Aditi', description: '30-min 1:1 with first tester after 48 hours of use. Capture quotes, pain points, aha moments.', status: 'todo', priority: 'p1', assignee: 'Maneek', daysAgo: 4, dueDaysFromNow: 2, labels: ['research'] },
  { title: 'Tester interview #2 — Karthik', description: 'Same format as #1. Aiming for 1 interview per day during launch week.', status: 'backlog', priority: 'p1', assignee: 'Maneek', daysAgo: 4, dueDaysFromNow: 4, labels: ['research'] },
  { title: 'Write launch blog post', description: '1500 words. Narrative: why agent-native workspaces, what makes Deft different, honest limitations list.', status: 'backlog', priority: 'p2', assignee: 'Maneek', daysAgo: 8, dueDaysFromNow: 14, labels: ['marketing'] },
  { title: 'Competitive tear-down v2', description: 'Update the comparison doc with Linear, Notion, Slack, Obsidian, Cursor. Focus on agent capabilities.', status: 'in_progress', priority: 'p3', assignee: 'Maneek', daysAgo: 6, dueDaysFromNow: 10 },
  { title: 'Usage analytics pipeline (privacy-first)', description: 'We need to know what features testers actually touch. PostHog self-hosted is the leading option.', status: 'backlog', priority: 'p2', assignee: 'Rahul Mehta', daysAgo: 10, dueDaysFromNow: 21, labels: ['infra', 'privacy'] },
  { title: 'NPS survey after week 1', description: 'Send a 1-question NPS to each tester at day 7. Use the result + interviews to inform sprint 7.', status: 'todo', priority: 'p2', assignee: 'Maneek', daysAgo: 2, dueDaysFromNow: 7 },
  { title: 'Twitter/X thread on private beta', description: 'Light brag post: what we built, who it is for, how to get access.', status: 'backlog', priority: 'p3', assignee: 'Maneek', daysAgo: 5, dueDaysFromNow: 14, labels: ['marketing'] },
  { title: 'Show HN draft', description: 'Draft the Show HN post for when we open the beta. Keep it honest and specific.', status: 'backlog', priority: 'p2', assignee: 'Maneek', daysAgo: 5, dueDaysFromNow: 30, labels: ['marketing'] },
  { title: 'Waitlist form on marketing site', description: 'Simple email capture with a reCAPTCHA-free honeypot. Data goes to a Google Sheet for now.', status: 'backlog', priority: 'p2', assignee: 'Priya Shah', daysAgo: 6, dueDaysFromNow: 14, labels: ['marketing'] },
  { title: 'Case study: Aditi (Linear → Deft)', description: "Honest post-interview case study. Aditi signed off on being quoted publicly.", status: 'backlog', priority: 'p3', assignee: 'Maneek', daysAgo: 1, dueDaysFromNow: 21 },
  { title: 'Product Hunt launch plan', description: 'Draft the PH listing, coordinate hunter, plan launch day logistics. Target date is post-public-beta.', status: 'backlog', priority: 'p3', assignee: 'Maneek', daysAgo: 3, dueDaysFromNow: 45, labels: ['marketing'] },
];

// ═══════════════════════════════════════════════════════════════════
// Additional wiki pages
// ═══════════════════════════════════════════════════════════════════

type SeedWiki2 = {
  type: 'concept' | 'entity' | 'decision' | 'resource' | 'procedure' | 'preference' | 'fact';
  title: string;
  slug: string;
  summary: string;
  content: string;
  confidence: number;
  daysAgo: number;
  links?: string[]; // slugs of pages this one links to
};

const EXTRA_WIKI: SeedWiki2[] = [
  {
    type: 'concept',
    title: 'Agent observation pipeline',
    slug: 'concept-agent-observation-pipeline',
    summary: 'Every chat message flows through Haiku classification before hitting the normal worker queue.',
    content: '# Agent Observation Pipeline\n\nOn every new message in any space, a worker fires `observe-message` which:\n\n1. Classifies intent (actionable/not), urgency, and extracted entities using Haiku\n2. Stores the classification as message metadata\n3. Triggers downstream jobs: task-extract, memory-extract, wiki-ingest\n4. Updates the space activity score for ranking\n\n**Cost:** ~$0.0001 per message (Haiku is cheap). At 1000 messages/day per org, this is ~$3/month in classification costs.\n\n**Failure mode:** if classification fails, the message is still stored — only the agent-aware features are degraded.',
    confidence: 0.9,
    daysAgo: 17,
    links: ['decision-sonnet-reasoning-haiku-classification'],
  },
  {
    type: 'concept',
    title: 'Three-tier agent approval',
    slug: 'concept-three-tier-approval',
    summary: 'Every agent action falls into auto-execute, quick-approve (1-click card), or full-review tiers.',
    content: '# Three-Tier Approval\n\n## Auto-execute\nLow-risk actions the agent can do without asking: task status from PR merge, meeting prep, reminders, daily standup generation.\n\n## Quick-approve\nOne-click approval card in chat. User sees the proposed action, taps Approve or Reject. Examples: create task, schedule meeting.\n\n## Full-review\nMulti-step plans or external writes (emails, GitHub issues). User sees a preview with edit affordances before approval.\n\nThe tier is chosen by the agent-actions module based on the tool being called + the org\'s trust level (conservative/standard/autonomous).',
    confidence: 0.92,
    daysAgo: 15,
    links: ['concept-agent-observation-pipeline'],
  },
  {
    type: 'concept',
    title: 'Multi-tenant isolation strategy',
    slug: 'concept-multi-tenant-isolation',
    summary: 'Every table carries org_id. Queries always filter by the authenticated user\'s org.',
    content: '# Multi-Tenant Isolation\n\n**Every table except `users`, `revoked_tokens`, and the global label/emoji/template tables carries `org_id`.**\n\n**Query pattern:** every route reads `c.get(\'user\').org_id` and filters WHERE on it. The agent-context tools do the same.\n\n**Row-level security:** not currently enabled at the Postgres level. We enforce isolation at the application layer. RLS is on the roadmap for SOC2.\n\n**Caveats:** the `users` table is global — a user can belong to multiple orgs via `org_members`. Task-search, chat-search, and wiki-search all scope correctly, but a user\'s search history is global per-user, not per-org.',
    confidence: 0.88,
    daysAgo: 16,
  },
  {
    type: 'decision',
    title: 'JWT 15-min access + 30-day refresh',
    slug: 'decision-jwt-15min-30day',
    summary: 'Access tokens are 15-min JWTs; refresh tokens are 30-day JWTs with server-side revocation via revoked_tokens table.',
    content: '# Auth Token Lifetimes\n\n**Access token:** 15 minutes, signed with `JWT_SECRET`. Carries `{ id, email, org_id }`. Never stored server-side.\n\n**Refresh token:** 30 days, signed with `JWT_REFRESH_SECRET`. Revocable via `revoked_tokens` (sha256 hash blacklist, added April 15).\n\n**Rotation:** refresh rotates on every use. Old refresh tokens are implicitly invalidated on the next `/api/auth/refresh` call by being replaced.\n\n**Revocation:** explicit logout writes to `revoked_tokens`. The `/api/auth/refresh` handler checks this table before honoring a token. Gap A3 from deployment readiness is closed.',
    confidence: 0.95,
    daysAgo: 1,
    links: ['decision-sonnet-reasoning-haiku-classification'],
  },
  {
    type: 'decision',
    title: 'Stateless auth — no refresh_tokens table',
    slug: 'decision-stateless-auth',
    summary: 'Refresh tokens are stateless JWTs. We use a revoked_tokens blacklist for logout/revocation rather than tracking every active token.',
    content: '# Stateless Auth\n\nWe do NOT have a `refresh_tokens` table tracking every active refresh token per user.\n\n**Why:** simpler scaling, lower DB load, and the token payload is signed so we don\'t need to look up anything on the happy path. The tradeoff is that revocation requires a blacklist check on every refresh.\n\n**The revoked_tokens table** is lookup-by-hash indexed. At tester scale the blacklist table will stay small.\n\n**If we ever need per-user session listing** (e.g., "show me all my active sessions, let me sign out of one"), we\'ll add a sessions table. Not a v1 priority.',
    confidence: 0.87,
    daysAgo: 1,
    links: ['decision-jwt-15min-30day'],
  },
  {
    type: 'entity',
    title: 'Railway — hosting for api + web',
    slug: 'entity-railway-hosting',
    summary: 'Both Deft services (api, web) run on a single Railway project "deft-test" in the Hobby tier.',
    content: '# Railway\n\n**Project:** deft-test (id `47219350-9aa9-4632-a3fa-66bdf314258f`)\n**Workspace:** `maneek21\'s Projects`\n**Region:** us-east-1 (default)\n**Tier:** Hobby ($5/mo)\n\n## Services\n- **deft-api** — Hono + tsx, listens on `$PORT`, health check `/health`\n- **deft-web** — Next.js 16 + nixpacks build, listens on `$PORT`\n\n## Env vars (api)\n- `DATABASE_URL` → Neon pooled connection string\n- `JWT_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY` → random 32-byte hex\n- `ANTHROPIC_API_KEY` → production key, shared with local dev\n- `NEXT_PUBLIC_APP_URL` → Railway web URL (for CORS)\n\n## Env vars (web, compile-time)\n- `NEXT_PUBLIC_API_URL` → Railway api URL\n- `NEXT_PUBLIC_WS_URL` → same\n- `NEXT_PUBLIC_FEATURE_OPENCLAW_EMPLOYEES=true`\n\n## Known gotchas\n- CLI `railway up` can 500 intermittently — retry works\n- Default Dockerfile at repo root gets auto-detected; must be in `.railwayignore`\n- Start command must NOT include `-p $PORT` — Next.js 16 auto-reads `PORT` from env',
    confidence: 0.97,
    daysAgo: 1,
    links: ['entity-neon-postgres'],
  },
  {
    type: 'entity',
    title: 'Anthropic — LLM provider',
    slug: 'entity-anthropic',
    summary: 'Claude Sonnet 4.6 (1M context) for reasoning, Haiku 4.5 for classification. Prompt caching enabled.',
    content: '# Anthropic\n\n**Models in use:**\n- `claude-opus-4-6` — not currently used\n- `claude-sonnet-4-6` — default for agent conversations, plans, tool use\n- `claude-haiku-4-5-20251001` — classifier, observation pipeline\n\n**Prompt caching:** enabled via `cache_control` on system prompt and tool definitions. 50-80% hit rate in practice. Saves ~60% on token costs vs non-cached.\n\n**Rate limits:** per-account, set via the Anthropic dashboard. For the trusted-tester deploy we set a $50/mo budget cap as a soft rate-limiter in lieu of middleware.\n\n**Key storage:** `ANTHROPIC_API_KEY` in Railway env. Same key as local dev.',
    confidence: 0.93,
    daysAgo: 0,
    links: ['decision-sonnet-reasoning-haiku-classification', 'entity-railway-hosting'],
  },
  {
    type: 'entity',
    title: 'TipTap — rich text composer',
    slug: 'entity-tiptap',
    summary: 'TipTap 3.x powers the chat composer and the notes editor. StarterKit + custom Mention node.',
    content: '# TipTap\n\n**Version:** 3.21.0\n\n**Extensions in use:**\n- `StarterKit` (bundles Link — must be disabled to avoid duplicate extension warning)\n- `Placeholder`\n- `Link` (our own, configured with `openOnClick: false`)\n- Custom `MentionNode` — atom node, inline, with `parseHTML: span[data-mention-uuid]`\n\n**Serialization:** composer HTML → `serializeMentions` → DB stores HTML with `<@uuid|name>` text markers → `renderContent` in space-chat.tsx converts back to styled spans on read.\n\n**Known gotchas:**\n- StarterKit bundles its own Link extension — must `StarterKit.configure({ link: false })` or you get a "Duplicate extension names" warning (gap #5)\n- Message wrappers must be `<div>`, not `<p>` — TipTap emits inner `<p>` tags and HTML parser auto-closes the outer `<p>` (gap #2)',
    confidence: 0.91,
    daysAgo: 2,
    links: [],
  },
  {
    type: 'entity',
    title: 'pgvector — embedding storage',
    slug: 'entity-pgvector',
    summary: 'pgvector 0.8.0 on Neon. Powers wiki search via ivfflat cosine similarity index.',
    content: '# pgvector\n\n**Version:** 0.8.0 (latest)\n**Table:** `wiki_pages.embedding vector(1536)` — OpenAI text-embedding-3-small dimensions\n**Index:** `ivfflat` with `lists=100` and `vector_cosine_ops`\n\n## Backfill\nBackfill script at `apps/api/src/scripts/backfill-wiki-embeddings.ts` supports OpenAI, Voyage, and a hash-based pseudo-embedding for dev.\n\n## Local dev (Windows)\npgvector is NOT installed on the local Postgres. As a workaround, `wiki_pages.embedding` is BYTEA locally. The code path that reads embeddings is tolerant. **Prod (Neon) has real vector(1536) and full semantic search.**\n\n## Performance\nAt ~10k pages per org the ivfflat index is fine. Would need HNSW or IVFPQ for 1M+ pages.',
    confidence: 0.89,
    daysAgo: 2,
    links: ['entity-neon-postgres', 'fact-deployment-readiness-deferred'],
  },
  {
    type: 'resource',
    title: 'Gap-fixes audit — April 15',
    slug: 'resource-gap-fixes-audit-april-15',
    summary: '15-check Playwright audit suite at docs/superpowers/audits/gap-fixes.audit.ts that validates all 17 gaps from the human-test sweep.',
    content: '# Gap-Fixes Audit\n\n**File:** `docs/superpowers/audits/gap-fixes.audit.ts`\n**Run:** `DEFT_TEST_EMAIL=maneek@test.com DEFT_TEST_PASSWORD=test1234 pnpm exec tsx docs/superpowers/audits/gap-fixes.audit.ts`\n**Last run:** 15/15 green (see `gap-fixes.last-run.txt`)\n\n## Checks\n1. gap#2 chat message wrapper is `<div>` not `<p>`\n2. gap#10 wiki detail endpoint returns 200\n3. gap#21 agent employee create dropdown has all 9 role values\n4. gap#7+12 projects endpoint exposes live total_tasks\n5. gap#5 no TipTap duplicate extension warning\n6. gap#9 wiki page shows "Entities" not "Entitie"\n7. gap#11 note preview strips block-type labels\n8. gap#8 event create rejects blank title\n9. gap#19 note delete prompts confirmation\n10. gap#22 Cmd+K first search does not 401\n11. gap#18 tasks Select button has immediate visible effect\n12. gap#13 Google button state matches login + signup\n13. gap#14 calendar Week view anchors on current date\n14. gap#server-logout refresh token revoked after logout\n15. gap#16 seed-cleanup no test-ui-shadow members\n\n**Deferred:** gap #3 (mention @@ collapse) — regex fix is correct in isolation but Playwright reproduction still shows leftover `@@`. ProseMirror position math edge case; flagged for follow-up.',
    confidence: 0.98,
    daysAgo: 2,
  },
  {
    type: 'resource',
    title: 'Deploy runbook — trusted-tester launch',
    slug: 'resource-deploy-runbook-trusted-tester',
    summary: 'Step-by-step runbook for deploying Deft to Neon + Railway. Includes the gotchas we hit on the first run.',
    content: '# Deploy Runbook\n\n**File:** `docs/superpowers/plans/2026-04-15-test-deploy-runbook.md`\n\nCovers:\n1. Neon project setup + pgvector install\n2. Secret generation (JWT, refresh, encryption, metrics)\n3. Railway api service (env, build/start, PORT fallback)\n4. Railway web service (NEXT_PUBLIC_* env, nixpacks, start command)\n5. First-admin signup via the web UI (non-destructive, unlike `packages/db/seed.ts`)\n6. Tester invite flow\n7. Deferred items (A2 DOMPurify, A4 rate limiting, etc.)\n\n**Actual gotchas from the first deploy (recorded in the appendix):**\n- Vercel token scope — personal Northstar accounts are read-only, pivoted to Railway-only\n- Railway CLI auth — project-scoped token needed for `railway up`, account token for everything else\n- `Dockerfile` at repo root auto-detected by Railway — must be in `.railwayignore`\n- `next start -p $PORT` doesn\'t expand through pnpm-exec wrapper — drop the flag\n- Signup field is `org_name` (snake_case), not `orgName`\n- Neon upload endpoint 500s intermittently — retry after 60s',
    confidence: 0.94,
    daysAgo: 2,
    links: ['entity-railway-hosting', 'entity-neon-postgres', 'resource-gap-fixes-audit-april-15'],
  },
  {
    type: 'procedure',
    title: 'How to run the gap-fixes audit',
    slug: 'procedure-run-gap-fixes-audit',
    summary: 'Step-by-step — preconditions, env vars, expected output, troubleshooting.',
    content: '# Running the Gap-Fixes Audit\n\n## Preconditions\n1. Dev servers running: `pnpm dev:api` and `pnpm dev:web` (or hit prod URLs)\n2. DATABASE_URL set in root `.env`\n3. Seed user `maneek@test.com` / `test1234` exists locally\n\n## Run\n```bash\nDEFT_TEST_EMAIL=maneek@test.com DEFT_TEST_PASSWORD=test1234 \\\n  pnpm exec tsx docs/superpowers/audits/gap-fixes.audit.ts\n```\n\n## Expected output\n```\n15 passing, 0 failing (15 total)\nAll checks passed.\n```\n\n## Running against prod\n```bash\nDEFT_TEST_EMAIL=maneek@deft.test DEFT_TEST_PASSWORD=<prod-password> \\\n  DEFT_WEB_URL=https://deft-web-production.up.railway.app \\\n  DEFT_API_URL=https://deft-api-production.up.railway.app \\\n  pnpm exec tsx docs/superpowers/audits/gap-fixes.audit.ts\n```\n\n## Troubleshooting\n- **"API not reachable"** — the audit\'s preflight hits `/health`. Restart the api server.\n- **"extracted access token" but then failing checks** — the playwright-auth.json storage state may be stale; delete it and re-run.\n- **Timeouts on chat checks** — the #general space needs seed messages with non-whitespace content.',
    confidence: 0.92,
    daysAgo: 2,
    links: ['resource-gap-fixes-audit-april-15'],
  },
  {
    type: 'procedure',
    title: 'Invite a tester',
    slug: 'procedure-invite-tester',
    summary: 'Standard flow for adding a new tester to the trusted cohort.',
    content: '# Invite a Tester\n\n## Steps\n\n1. Sign in as an admin\n2. Settings → Members → Invite\n3. Enter the tester\'s email and role (default: `member`)\n4. Click Send. Response body carries `temp_password` if Resend is not configured.\n5. Copy the temp password and send it via Signal / DM / whatever out-of-band channel you use.\n6. Tester signs in at the web URL with email + temp password, immediately changes password.\n\n## What to tell them\n- Uploaded files are ephemeral (disappear on redeploy)\n- Don\'t paste untrusted HTML (XSS sanitizer is deferred)\n- The agent can create test data — if you see tasks you didn\'t make, that\'s normal\n- Agent queries use shared Anthropic credits — don\'t run them in a loop\n\n## DM\'ing feedback\n- 5-tester trusted cohort → DM directly, batch-summarize Fridays in #launch\n- Would scale to a form at &gt;10 testers',
    confidence: 0.9,
    daysAgo: 1,
    links: ['resource-deploy-runbook-trusted-tester'],
  },
  {
    type: 'preference',
    title: 'No raw SQL except in agent tool calls',
    slug: 'preference-no-raw-sql-except-agent',
    summary: 'All DB access goes through Drizzle ORM. The only exception is agent-context tool calls which need raw parameterized SQL.',
    content: '# No Raw SQL Rule\n\n**Rule:** All database queries use Drizzle ORM via `import { db } from "../lib/db.js"`.\n\n**Exception 1:** Agent tool calls in `packages/ai/src/agent-context.ts`. The agent needs to run arbitrary user-generated queries (via the `query` tool), and Drizzle\'s type system can\'t express all possible SELECT shapes. These are always parameterized — never string-interpolated.\n\n**Exception 2:** Idempotent scripts in `apps/api/src/scripts/*.ts`. These use `pg.Pool` directly for simplicity and because they run outside the normal request path.\n\n**Exception 3:** The pgvector `ivfflat` index creation. Drizzle doesn\'t have a helper for vector indexes yet.\n\n**NOT allowed:** Inlining SQL strings in routes. If you need to, file a gap and we\'ll add the Drizzle helper.',
    confidence: 0.95,
    daysAgo: 14,
    links: ['decision-use-drizzle-orm'],
  },
  {
    type: 'preference',
    title: 'Errors return { error, code }, not raw stack traces',
    slug: 'preference-error-response-shape',
    summary: 'Every API error response has shape { error: string, code: string }. No raw stack traces, no Drizzle error objects, no HTML.',
    content: '# Error Response Shape\n\n**Standard shape:**\n```typescript\n{ error: "Invalid input", code: "VALIDATION_ERROR" }\n```\n\n**Why:** frontend uses `code` for programmatic branching (e.g., show a specific error banner for `EMAIL_EXISTS`), and `error` is the user-visible string.\n\n**Never:** raw stack traces, Drizzle `PostgresError` objects, or HTML error pages. Those leak internals.\n\n**Logging:** log the full error server-side with `console.error`. The response body only carries the shape above.\n\n**Current violations:** spot-checked ~15 routes during the April 15 sweep. 2 were missing the `code` field. Filed as a chore task.',
    confidence: 0.87,
    daysAgo: 13,
  },
  {
    type: 'preference',
    title: 'Socket.io rooms per org, space, user, agent',
    slug: 'preference-socket-rooms',
    summary: 'Socket.io uses distinct rooms for org-wide, space-scoped, user-direct, and agent-channel broadcasts.',
    content: '# Socket Room Strategy\n\n**Room naming:**\n- `org:<orgId>` — org-wide broadcasts (presence, org-level activity)\n- `space:<spaceId>` — space messages, reactions, typing, thread replies\n- `user:<userId>` — user-direct events (mentions, task-assignments, DM notifications)\n- `agent:<employeeId>` — per-agent-employee channel for streaming responses\n\n**Why multiple rooms:** lets us selectively broadcast without heavy filtering. A mention fires into `user:<id>` only, not the whole space.\n\n**Single-instance caveat:** we do NOT run a Socket.io Redis adapter. If we ever scale beyond one Railway instance we\'ll need it. At tester scale it\'s fine.',
    confidence: 0.9,
    daysAgo: 12,
  },
  {
    type: 'fact',
    title: 'Deft license — BSL 1.1',
    slug: 'fact-deft-license-bsl',
    summary: 'Deft is licensed under Business Source License 1.1. Free for any purpose except hosting as a service for third parties.',
    content: '# License: BSL 1.1\n\n**License file:** `LICENSE`\n**Change date:** 4 years after each commit — each commit transitions to Apache 2.0 after that\n**Additional terms:** mandatory attribution in forks, "Powered by Deft" link in footer if hosted\n\n## What you can do\n- Read, modify, and use the code for any purpose\n- Self-host for personal or internal company use\n- Fork and publish modifications (with attribution)\n\n## What you cannot do\n- Host Deft as a service for third parties (offering Deft-as-a-service is the one commercial restriction)\n- Strip attribution\n\nThe BSL 1.1 model is the same one used by MariaDB, CockroachDB, Sentry, and several other open-source-with-commercial-guardrails projects.',
    confidence: 0.99,
    daysAgo: 20,
  },
  {
    type: 'fact',
    title: 'Team — 5 people as of April 15',
    slug: 'fact-team-5-people',
    summary: 'Current full-time team: Maneek (founding), Priya (eng), Rahul (eng), Arjun (design), Sara (design).',
    content: '# Team\n\n**As of April 15, 2026:**\n\n| Name | Role | Joined |\n|---|---|---|\n| Maneek | Founder / full-stack | Day 0 |\n| Priya Shah | Engineering | ~14 weeks ago |\n| Rahul Mehta | Engineering | ~14 weeks ago |\n| Sara Kim | Design | ~10 weeks ago |\n| Arjun Rao | Design (design system) | 20 days ago |\n\nNo PM yet. No sales yet. Plan is to stay small until we hit paying pilot customers.',
    confidence: 0.98,
    daysAgo: 2,
  },
  {
    type: 'fact',
    title: 'Agent cost cap — $50/mo shared budget',
    slug: 'fact-agent-cost-cap',
    summary: 'Shared Anthropic API budget cap of $50/mo during the trusted-tester phase.',
    content: '# Agent Cost Cap\n\n**Cap:** $50/mo on the Anthropic dashboard\n**Why:** soft rate-limiter in lieu of middleware. Gap A4 (real rate limiting) is deferred.\n**Current spend:** ~$8/mo during internal team use.\n**Projected:** 5 trusted testers × moderate use ≈ $25-35/mo. Headroom for spikes.\n\n**If we hit the cap:**\n- Anthropic dashboard will block new requests — agent page will error with `rate_limit_exceeded`\n- Raise the cap in the dashboard (no code change needed)\n- Post-mortem in #launch about what drove the usage\n\n**Full rate limiting middleware** is on the backlog (gap A4). Worth doing before we widen the cohort.',
    confidence: 0.88,
    daysAgo: 1,
    links: ['entity-anthropic', 'fact-deployment-readiness-deferred'],
  },
];

// ═══════════════════════════════════════════════════════════════════
// Personal notes per user
// ═══════════════════════════════════════════════════════════════════

const EXTRA_NOTES: { user: string; title: string; icon: string; content: string; daysAgo: number }[] = [
  {
    user: 'Priya Shah',
    title: 'Socket reconnect refactor — notes',
    icon: '🔌',
    content: '<h1>Socket reconnect — notes</h1><p>Race condition: first frame after reconnect can arrive before the auth handshake completes and gets dropped.</p><h2>Fix approach</h2><ul><li>Queue incoming frames until the auth promise resolves</li><li>Two-line change in <code>apps/web/src/lib/socket.ts</code></li><li>Test: disconnect Wi-Fi for 30s, send a message from another browser, reconnect. Message should show up.</li></ul><h2>Out of scope</h2><ul><li>Redis adapter — not needed at single-instance</li><li>Retry backoff — already exponential</li></ul>',
    daysAgo: 4,
  },
  {
    user: 'Rahul Mehta',
    title: 'Wiki embedding migration debug log',
    icon: '🔍',
    content: '<h1>Wiki embedding — debug log</h1><p>Gap #10. Wiki detail view was 500ing on every page.</p><h2>Root cause</h2><p>Drizzle migration <code>0011_wiki_pages_embedding.sql</code> exists on disk but never applied to the dev DB. The <code>ALTER TABLE wiki_pages ADD COLUMN embedding vector(1536)</code> line needs the pgvector extension, which is NOT installed on Windows Postgres.</p><h2>Workaround</h2><ul><li>Dev: <code>ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS embedding BYTEA</code> — the route\'s SELECT no longer crashes, embedding reads return null which JSON-serializes fine.</li><li>Prod: Neon has real pgvector 0.8.0. Re-run the migration there.</li></ul><h2>Followup</h2><p>Once pgvector is available on all dev machines (or we switch to a Linux container for Postgres), drop the BYTEA fallback.</p>',
    daysAgo: 1,
  },
  {
    user: 'Sara Kim',
    title: 'Onboarding flow v3 — rationale',
    icon: '🎨',
    content: '<h1>Onboarding flow v3</h1><p>Third iteration after user testing with Priya and Rahul.</p><h2>Changes from v2</h2><ol><li>Dropped the Slack-style product tour — everyone clicked through without reading</li><li>Dropped the optional calendar connect — felt like busywork on day 1</li><li>Combined "Meet Deft" and welcome screens — was doing the same thing twice</li></ol><h2>Measurement plan</h2><p>Track completion rate per step. If step 4 (first space) drops below 80%, the copy is still too long.</p>',
    daysAgo: 6,
  },
  {
    user: 'Arjun Rao',
    title: 'First month goals',
    icon: '🎯',
    content: '<h1>First month goals</h1><ul><li>Land 3 design-system PRs (icon wrapper, Card primitive, typography scale)</li><li>Complete the Figma token migration</li><li>Redesign the task detail panel (done — PR in review)</li><li>Pair with Priya at least once a week to close the design-eng loop</li><li>Ship a first-pass mobile-responsive tasks board</li></ul><h2>Not goals</h2><ul><li>Custom illustrations (deferred to month 2)</li><li>Marketing site design (Maneek has a freelancer lined up)</li></ul>',
    daysAgo: 15,
  },
  {
    user: 'Maneek',
    title: 'Sprint retro — gap-fixes week',
    icon: '🪞',
    content: '<h1>Sprint retro — gap-fixes week</h1><h2>What went well</h2><ul><li>Subagent-driven development worked. Each fix was self-contained, reviewable, and the audit caught regressions.</li><li>Pairing Rahul on the wiki fixes and Priya on the socket race reduced review time</li><li>Shipping 16 fixes in 5 days with 15 audit checks green</li></ul><h2>What didn\'t go well</h2><ul><li>Gap #3 (mention @@ collapse) is still unresolved. ProseMirror position math is subtle and my debug loop was too shallow.</li><li>Some commits bundled carry-forward work. Cleaner if we had committed the April 14 uncommitted work BEFORE starting the gap-fixes sprint.</li></ul><h2>Action items</h2><ul><li>Pre-sprint: check <code>git status</code> and resolve uncommitted work first</li><li>Defer gaps that don\'t have a clean 1-session fix — don\'t iterate on flaky tests in the main flow</li></ul>',
    daysAgo: 2,
  },
  {
    user: 'Maneek',
    title: 'Tester interview — question bank',
    icon: '❓',
    content: '<h1>Tester interviews — question bank</h1><h2>Open-ended</h2><ul><li>Walk me through the first 10 minutes after sign-in. What did you do, what did you notice?</li><li>What felt broken? Be specific.</li><li>What felt magical, even if unfinished?</li><li>What did you reach for that wasn\'t there?</li></ul><h2>Targeted</h2><ul><li>Did you use the agent? Why or why not?</li><li>Did you find the knowledge wiki useful? Did you trust it?</li><li>How did the chat compare to Slack/Discord/etc for you?</li></ul><h2>Don\'t ask</h2><ul><li>"Would you pay for this?" — meaningless in a private beta</li><li>"What features should we build next?" — they\'ll hallucinate a backlog</li></ul>',
    daysAgo: 3,
  },
];

// ═══════════════════════════════════════════════════════════════════
// Calendar events
// ═══════════════════════════════════════════════════════════════════

type SeedEvent = { title: string; body: string; offsetHours: number; durationMinutes: number };

const EXTRA_EVENTS: SeedEvent[] = [
  // Weekly standups for the next 4 weeks (Mondays 10am)
  ...Array.from({ length: 4 }, (_, i) => ({
    title: 'Weekly standup',
    body: 'Round-robin update. 15 minutes max. Follow with async standup in #general.',
    offsetHours: 7 * 24 * i + 20 + (i === 0 ? -2 : 0), // roughly once a week
    durationMinutes: 15,
  })),
  // 1:1s with each team member
  { title: '1:1 — Priya', body: 'Weekly 1:1. Career + projects + blockers.', offsetHours: 28, durationMinutes: 30 },
  { title: '1:1 — Rahul', body: 'Weekly 1:1. Career + projects + blockers.', offsetHours: 52, durationMinutes: 30 },
  { title: '1:1 — Arjun', body: 'First-month 1:1. Check in on design-system progress.', offsetHours: 76, durationMinutes: 30 },
  { title: '1:1 — Sara', body: 'Weekly 1:1. Onboarding flow v3 review.', offsetHours: 100, durationMinutes: 30 },
  // Tester interviews
  { title: 'Tester interview — Aditi', body: '30-min 1:1 with first tester. Capture first impressions after 48h of use.', offsetHours: 48, durationMinutes: 30 },
  { title: 'Tester interview — Karthik', body: 'Karthik runs FounderPad — interested in how the agent handles cross-tool context.', offsetHours: 96, durationMinutes: 30 },
  { title: 'Tester interview — Mira', body: 'Writer / tech-ops tester. Focus on chat + notes surface.', offsetHours: 144, durationMinutes: 30 },
  // Engineering/product meetings
  { title: 'Sprint retro', body: 'Review the gap-fixes sprint. What shipped, what slipped, retro items.', offsetHours: 72, durationMinutes: 45 },
  { title: 'Sprint planning — next sprint', body: 'Plan sprint 7: R2 uploads, DOMPurify, Sentry, rate limiting.', offsetHours: 120, durationMinutes: 60 },
  { title: 'Design review — task detail panel v2', body: 'Arjun to walk the team through the Figma. Decide on tab consolidation.', offsetHours: 32, durationMinutes: 45 },
  { title: 'All-hands — Friday', body: 'Private beta recap + sprint review + Q&A. 30 min.', offsetHours: 50, durationMinutes: 30 },
  { title: 'Product review — week 1 tester data', body: 'Review what testers clicked, what they didn\'t, what they complained about.', offsetHours: 168, durationMinutes: 60 },
  // Personal
  { title: 'Lunch — Chris (ex-coworker)', body: 'Catching up with Chris from Ramp. Not work-related.', offsetHours: 60, durationMinutes: 60 },
  { title: 'Demo day prep', body: 'Prep for the demo day rehearsal. Run through the 3-minute pitch twice.', offsetHours: 88, durationMinutes: 30 },
];

// ═══════════════════════════════════════════════════════════════════
// Labels
// ═══════════════════════════════════════════════════════════════════

const SEED_LABELS = [
  { name: 'critical', color: '#DC2626' },
  { name: 'bug', color: '#EF4444' },
  { name: 'design', color: '#8B5CF6' },
  { name: 'infra', color: '#3B82F6' },
  { name: 'ux', color: '#EC4899' },
  { name: 'marketing', color: '#10B981' },
  { name: 'research', color: '#F59E0B' },
  { name: 'a11y', color: '#06B6D4' },
  { name: 'mobile', color: '#6366F1' },
  { name: 'privacy', color: '#14B8A6' },
];

// ═══════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('Layering rich supplementary seed data on top of existing org…');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Find admin + org + load user ids
    const adminRes = await client.query(
      'select u.id as user_id, om.org_id from users u join org_members om on om.user_id=u.id where u.email=$1 limit 1',
      [ADMIN_EMAIL],
    );
    if (!adminRes.rowCount) throw new Error(`Admin ${ADMIN_EMAIL} not found`);
    const adminId = adminRes.rows[0].user_id as string;
    const orgId = adminRes.rows[0].org_id as string;
    console.log(`  admin=${adminId.slice(0, 8)} org=${orgId.slice(0, 8)}`);

    // Load all users in the org so we can look them up by name
    const userRes = await client.query(
      `select u.id, u.name, u.email from users u
       join org_members om on om.user_id=u.id
       where om.org_id=$1 and om.is_active=true`,
      [orgId],
    );
    const userIds: Record<string, string> = {};
    for (const row of userRes.rows) {
      userIds[row.name] = row.id;
      // Also index by first name for convenience
      const first = row.name?.split(' ')[0];
      if (first && !userIds[first]) userIds[first] = row.id;
    }
    // Maneek hack — the seeded admin may be named "Maneek"
    if (!userIds['Maneek']) userIds['Maneek'] = adminId;
    console.log(`  users loaded: ${Object.keys(userIds).filter((k) => !k.includes(' ')).join(', ')}`);

    // 2. Load existing space ids
    const spaceRes = await client.query(
      `select id, name, type from spaces where org_id=$1 and is_archived=false`,
      [orgId],
    );
    const spaceIds: Record<string, string> = {};
    for (const row of spaceRes.rows) {
      spaceIds[row.name] = row.id;
    }
    console.log(`  spaces loaded: ${Object.keys(spaceIds).join(', ')}`);

    // ─── 3. Seed additional messages per space with threads + reactions ───
    async function seedExtraMessages(spaceName: string, messages: ExtraMsg[]): Promise<void> {
      const spaceId = spaceIds[spaceName];
      if (!spaceId) {
        console.warn(`  skipping #${spaceName} — not found`);
        return;
      }
      for (const m of messages) {
        const id = randomUUID();
        const ts = new Date(NOW - m.days * DAY - m.hours * HOUR);
        const uid = userIds[m.user];
        if (!uid) {
          console.warn(`  skip msg, unknown user ${m.user}`);
          continue;
        }
        await client.query(
          `insert into messages (id, org_id, space_id, user_id, content, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $6)`,
          [id, orgId, spaceId, uid, m.text, ts],
        );
        // Reactions
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
        // Pin
        if (m.pin) {
          await client.query(
            `insert into pinned_messages (id, message_id, space_id, pinned_by, pinned_at)
             values ($1, $2, $3, $4, $5)
             on conflict (message_id, space_id) do nothing`,
            [randomUUID(), id, spaceId, adminId, ts],
          );
        }
        // Thread replies
        if (m.replies) {
          for (const reply of m.replies) {
            const rid = randomUUID();
            const rts = new Date(ts.getTime() + reply.hoursAfter * HOUR);
            const ruid = userIds[reply.user];
            if (!ruid) continue;
            await client.query(
              `insert into messages (id, org_id, space_id, user_id, content, parent_id, created_at, updated_at)
               values ($1, $2, $3, $4, $5, $6, $7, $7)`,
              [rid, orgId, spaceId, ruid, reply.text, id, rts],
            );
            if (reply.reactions) {
              for (const r of reply.reactions) {
                const reactUid = userIds[r.user];
                if (!reactUid) continue;
                await client.query(
                  `insert into reactions (id, message_id, user_id, emoji, created_at, updated_at)
                   values ($1, $2, $3, $4, $5, $5)
                   on conflict (message_id, user_id, emoji) do nothing`,
                  [randomUUID(), rid, reactUid, r.emoji, rts],
                );
              }
            }
          }
        }
      }
    }

    await seedExtraMessages('general', EXTRA_GENERAL);
    await seedExtraMessages('engineering', EXTRA_ENGINEERING);
    await seedExtraMessages('design', EXTRA_DESIGN);
    await seedExtraMessages('random', EXTRA_RANDOM);
    await seedExtraMessages('launch', EXTRA_LAUNCH);

    const extraCount =
      EXTRA_GENERAL.length +
      EXTRA_ENGINEERING.length +
      EXTRA_DESIGN.length +
      EXTRA_RANDOM.length +
      EXTRA_LAUNCH.length;
    const threadCount = [
      EXTRA_GENERAL,
      EXTRA_ENGINEERING,
      EXTRA_DESIGN,
      EXTRA_RANDOM,
      EXTRA_LAUNCH,
    ].reduce((sum, arr) => sum + arr.reduce((s, m) => s + (m.replies?.length || 0), 0), 0);
    console.log(`  extra messages: ${extraCount} parent + ${threadCount} thread replies`);

    // ─── 4. DM conversations ───
    async function createDmSpace(participants: string[]): Promise<string> {
      // Build deterministic name from sorted participants
      const sortedNames = [...participants].sort();
      const dmName = 'DM: ' + sortedNames.join(', ');
      const existing = await client.query(
        `select id from spaces where org_id=$1 and name=$2 and type in ('dm','group_dm') limit 1`,
        [orgId, dmName],
      );
      if (existing.rowCount) return existing.rows[0].id;

      const id = randomUUID();
      const type = participants.length > 2 ? 'group_dm' : 'dm';
      await client.query(
        `insert into spaces (id, org_id, name, type, created_by, topic, description)
         values ($1, $2, $3, $4, $5, 'Direct conversation', '')`,
        [id, orgId, dmName, type, adminId],
      );
      for (const name of participants) {
        const uid = userIds[name];
        if (!uid) continue;
        await client.query(
          `insert into space_members (id, space_id, user_id, notification_level)
           values ($1, $2, $3, 'all')
           on conflict (space_id, user_id) do nothing`,
          [randomUUID(), id, uid],
        );
      }
      return id;
    }

    let dmMsgCount = 0;
    for (const convo of DM_CONVERSATIONS) {
      const dmId = await createDmSpace(convo.participants);
      for (const m of convo.messages) {
        const uid = userIds[m.user];
        if (!uid) continue;
        const ts = new Date(NOW - m.days * DAY - m.hours * HOUR);
        await client.query(
          `insert into messages (id, org_id, space_id, user_id, content, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $6)`,
          [randomUUID(), orgId, dmId, uid, m.text, ts],
        );
        dmMsgCount += 1;
      }
    }
    // Group DM
    const gdmId = await createDmSpace(GROUP_DM.participants);
    for (const m of GROUP_DM.messages) {
      const uid = userIds[m.user];
      if (!uid) continue;
      const ts = new Date(NOW - m.days * DAY - m.hours * HOUR);
      await client.query(
        `insert into messages (id, org_id, space_id, user_id, content, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $6)`,
        [randomUUID(), orgId, gdmId, uid, m.text, ts],
      );
      dmMsgCount += 1;
    }
    console.log(`  DM conversations: ${DM_CONVERSATIONS.length} 1:1 + 1 group, ${dmMsgCount} msgs total`);

    // ─── 5. Labels ───
    const labelIds: Record<string, string> = {};
    for (const l of SEED_LABELS) {
      const existing = await client.query(
        'select id from labels where org_id=$1 and name=$2 limit 1',
        [orgId, l.name],
      );
      if (existing.rowCount) {
        labelIds[l.name] = existing.rows[0].id;
      } else {
        const id = randomUUID();
        await client.query(
          'insert into labels (id, org_id, name, color) values ($1, $2, $3, $4)',
          [id, orgId, l.name, l.color],
        );
        labelIds[l.name] = id;
      }
    }
    console.log(`  labels seeded: ${Object.keys(labelIds).length}`);

    // ─── 6. Second + third projects with tasks ───
    async function ensureProject(
      name: string,
      prefix: string,
      description: string,
      icon: string,
    ): Promise<{ id: string; counter: number }> {
      const existing = await client.query(
        'select id, task_counter from projects where org_id=$1 and prefix=$2 limit 1',
        [orgId, prefix],
      );
      if (existing.rowCount) {
        return { id: existing.rows[0].id, counter: existing.rows[0].task_counter };
      }
      const id = randomUUID();
      await client.query(
        `insert into projects (id, org_id, name, description, prefix, icon, color, lead_id, task_counter)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 0)`,
        [id, orgId, name, description, prefix, icon, '#8B5CF6', adminId],
      );
      return { id, counter: 0 };
    }

    async function seedProjectTasks(
      projectId: string,
      startCounter: number,
      tasks: SeedTask2[],
    ): Promise<number> {
      let n = startCounter + 1;
      for (const t of tasks) {
        const id = randomUUID();
        const ts = daysAgo(t.daysAgo);
        const due = t.dueDaysFromNow != null ? daysFromNow(t.dueDaysFromNow) : null;
        const assignee = t.assignee ? userIds[t.assignee] : null;
        await client.query(
          `insert into tasks (id, org_id, project_id, number, title, description, status, priority, assignee_id, created_by, due_date, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
          [id, orgId, projectId, n, t.title, t.description || null, t.status, t.priority, assignee, adminId, due, ts],
        );
        // Task labels
        if (t.labels) {
          for (const labelName of t.labels) {
            const labelId = labelIds[labelName];
            if (!labelId) continue;
            await client.query(
              `insert into task_labels (task_id, label_id) values ($1, $2)
               on conflict (task_id, label_id) do nothing`,
              [id, labelId],
            );
          }
        }
        // Subtasks
        if (t.subtasks) {
          for (const sub of t.subtasks) {
            n += 1;
            await client.query(
              `insert into tasks (id, org_id, project_id, number, title, status, priority, created_by, parent_task_id, created_at, updated_at)
               values ($1, $2, $3, $4, $5, $6, 'p2', $7, $8, $9, $9)`,
              [randomUUID(), orgId, projectId, n, sub.title, sub.status, adminId, id, ts],
            );
          }
        }
        // Activity log entry for every task — makes the Activity tab populated
        await client.query(
          `insert into task_activity (id, task_id, user_id, action, old_value, new_value, created_at, updated_at)
           values ($1, $2, $3, 'created', null, $4, $5, $5)`,
          [randomUUID(), id, adminId, t.title, ts],
        );
        if (t.status !== 'backlog') {
          await client.query(
            `insert into task_activity (id, task_id, user_id, action, field, old_value, new_value, created_at, updated_at)
             values ($1, $2, $3, 'status_changed', 'status', 'backlog', $4, $5, $5)`,
            [randomUUID(), id, assignee || adminId, t.status, new Date(ts.getTime() + 2 * HOUR)],
          );
        }
        n += 1;
      }
      return n - 1;
    }

    const ds = await ensureProject('Design System', 'DS', 'Design system rebuild + component consolidation.', '🎨');
    const dsFinal = await seedProjectTasks(ds.id, ds.counter, PROJECT_DESIGN_SYSTEM);
    await client.query('update projects set task_counter=$1 where id=$2', [dsFinal, ds.id]);

    const gro = await ensureProject('Growth Experiments', 'GRO', 'Launch prep + tester acquisition + marketing surfaces.', '🌱');
    const groFinal = await seedProjectTasks(gro.id, gro.counter, PROJECT_GROWTH);
    await client.query('update projects set task_counter=$1 where id=$2', [groFinal, gro.id]);
    console.log(`  extra projects: Design System (${PROJECT_DESIGN_SYSTEM.length} tasks), Growth (${PROJECT_GROWTH.length} tasks)`);

    // ─── 7. Extra wiki pages with links ───
    const wikiSlugToId: Record<string, string> = {};
    // Load any existing wiki slugs first
    const existingWiki = await client.query(
      'select id, slug from wiki_pages where org_id=$1',
      [orgId],
    );
    for (const row of existingWiki.rows) {
      wikiSlugToId[row.slug] = row.id;
    }

    for (const w of EXTRA_WIKI) {
      if (wikiSlugToId[w.slug]) continue;
      const id = randomUUID();
      await client.query(
        `insert into wiki_pages (id, org_id, scope, type, title, slug, summary, content, confidence, version, created_at, updated_at)
         values ($1, $2, 'org', $3, $4, $5, $6, $7, $8, 1, $9, $9)`,
        [id, orgId, w.type, w.title, w.slug, w.summary, w.content, w.confidence, daysAgo(w.daysAgo)],
      );
      wikiSlugToId[w.slug] = id;
    }

    // Cross-links between wiki pages
    let linkCount = 0;
    for (const w of EXTRA_WIKI) {
      if (!w.links) continue;
      const src = wikiSlugToId[w.slug];
      for (const targetSlug of w.links) {
        const tgt = wikiSlugToId[targetSlug];
        if (!src || !tgt) continue;
        await client.query(
          `insert into wiki_links (id, org_id, source_page_id, target_page_id)
           values ($1, $2, $3, $4)
           on conflict (source_page_id, target_page_id) do nothing`,
          [randomUUID(), orgId, src, tgt],
        );
        linkCount += 1;
      }
    }
    console.log(`  extra wiki pages: ${EXTRA_WIKI.length}, links: ${linkCount}`);

    // ─── 8. Personal notes ───
    for (const n of EXTRA_NOTES) {
      const uid = userIds[n.user];
      if (!uid) continue;
      await client.query(
        `insert into notes (id, org_id, user_id, title, content, icon, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [randomUUID(), orgId, uid, n.title, n.content, n.icon, daysAgo(n.daysAgo)],
      );
    }
    console.log(`  extra notes: ${EXTRA_NOTES.length}`);

    // ─── 9. Calendar events ───
    for (const e of EXTRA_EVENTS) {
      const start = hoursFromNow(e.offsetHours);
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
          hoursAgo(1),
        ],
      );
    }
    console.log(`  extra calendar events: ${EXTRA_EVENTS.length}`);

    // ─── 10. Bookmark a few messages for the admin ───
    const bookmarkCandidates = await client.query(
      `select m.id, m.space_id from messages m
       where m.org_id=$1 and m.is_deleted=false
       and m.content like '%pin%' or m.content like '%🎉%' or m.content like '%gap-fixes%'
       limit 5`,
      [orgId],
    );
    for (const row of bookmarkCandidates.rows) {
      await client.query(
        `insert into message_bookmarks (id, org_id, user_id, message_id, space_id)
         values ($1, $2, $3, $4, $5)
         on conflict (user_id, message_id) do nothing`,
        [randomUUID(), orgId, adminId, row.id, row.space_id],
      );
    }
    console.log(`  message bookmarks: ${bookmarkCandidates.rowCount}`);

    // ─── 11. Apply labels to existing DEFT project tasks ───
    const deftTasks = await client.query(
      `select t.id, t.title from tasks t
       join projects p on p.id=t.project_id
       where p.org_id=$1 and p.prefix='DEFT'`,
      [orgId],
    );
    const labelMap: Record<string, string[]> = {
      'critical': ['critical', 'bug'],
      'bug': ['bug'],
      'DOMPurify': ['critical'],
      'R2': ['infra'],
      'Sentry': ['infra'],
      'rate limit': ['infra', 'critical'],
      'CSP': ['infra'],
      'GDPR': ['privacy'],
      'Privacy Policy': ['privacy'],
      'fix(wiki)': ['bug', 'critical'],
      'fix(chat)': ['bug'],
      'fix(agent-employees)': ['bug'],
      'fix(projects)': ['bug'],
      'fix(composer)': ['bug'],
      'feat(auth)': ['infra'],
      'Empty state': ['design', 'ux'],
    };
    let tasksLabeled = 0;
    for (const row of deftTasks.rows) {
      const title: string = row.title;
      for (const [keyword, labels] of Object.entries(labelMap)) {
        if (title.includes(keyword)) {
          for (const labelName of labels) {
            const labelId = labelIds[labelName];
            if (!labelId) continue;
            await client.query(
              `insert into task_labels (task_id, label_id) values ($1, $2)
               on conflict do nothing`,
              [row.id, labelId],
            );
          }
          tasksLabeled += 1;
          break;
        }
      }
    }
    console.log(`  DEFT tasks labeled: ${tasksLabeled}`);

    await client.query('COMMIT');
    console.log('');
    console.log('✓ Rich seed layered on top of existing content.');
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
