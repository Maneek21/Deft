import 'dotenv/config';
import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft',
});
const uuid = () => crypto.randomUUID();

async function seed() {
  const users = (await pool.query(`
    SELECT u.id, om.org_id FROM users u
    JOIN org_members om ON om.user_id = u.id
    LIMIT 5
  `)).rows;

  const rahul = users.find((u: any) => u.id.startsWith('d3e6d84d')) || users[1]; // Rahul
  const priya = users.find((u: any) => u.id.startsWith('07308d0d')) || users[2]; // Priya
  const orgId = rahul.org_id;

  // Clean
  await pool.query('DELETE FROM notes WHERE org_id = $1', [orgId]);

  console.log('Seeding notes...');

  const noteDefs = [
    // Rahul's notes
    {
      userId: rahul.id,
      title: 'Feature Roadmap — Phase 1',
      icon: '\uD83D\uDDFA\uFE0F',
      pinned: true,
      content: '<h1>Phase 1: Daily Notes + Tags</h1><p>Two anchor features that lay the groundwork for everything else.</p><h2>Daily Notes</h2><ul><li>Per-user notes collection (unlimited, not one-per-day)</li><li>Rich text editor with TipTap</li><li>Card grid collection view</li><li>Search + pin support</li></ul><h2>Tags</h2><ul><li>Cross-entity tags on tasks, messages, clips, notes</li><li>Tag picker component</li><li>Browse page with entity resolution</li><li>Auto-tag via classifier (Phase 2)</li></ul><p><strong>Status:</strong> In progress. Notes collection done, tags browse working.</p>',
      daysAgo: 0,
    },
    {
      userId: rahul.id,
      title: 'Agent Streaming Fix — Root Cause',
      icon: '\uD83D\uDC1B',
      pinned: false,
      content: '<h2>Problem</h2><p>Agent responses weren\'t showing without a page refresh. Multiple layers of bugs:</p><ol><li><strong>Hono stream() vs streamSSE()</strong> — Generic stream() buffers writes with @hono/node-server. streamSSE() flushes each writeSSE() call immediately.</li><li><strong>Frontend timeout</strong> — 30-second SSE timeout fires during long Anthropic API calls because browser never receives data.</li><li><strong>Component remounting</strong> — router.push() during streaming causes parent to re-render, unmounting AgentChat.</li></ol><h2>Fix</h2><ul><li>Switched to streamSSE()</li><li>Added heartbeat keepalives every 10s</li><li>Used window.history.replaceState() instead of router.push()</li><li>Added streamingRef to prevent reload during active streaming</li></ul>',
      daysAgo: 2,
    },
    {
      userId: rahul.id,
      title: 'Sprint Planning Notes — Apr 1',
      icon: '\uD83C\uDFAF',
      pinned: false,
      content: '<h2>Decisions</h2><ul><li>Craft features first, agent memory later</li><li>Phase 1: Notes + Tags (this week)</li><li>Phase 2: Calendar view (next week)</li><li>Arjun takes calendar, Priya takes web clipper</li></ul><h2>Blockers</h2><ul><li>Auth middleware needs refactor — legal flagged session token storage</li><li>Whisper setup for clip transcription still pending</li></ul><h2>Action Items</h2><ul><li>Rahul: finish notes + tags</li><li>Priya: auth refactor + web clipper API</li><li>Arjun: calendar view spec</li></ul>',
      daysAgo: 3,
    },
    {
      userId: rahul.id,
      title: 'Architecture Decision: Agent Token Budget',
      icon: '\u2696\uFE0F',
      pinned: true,
      content: '<h1>Agent Iteration Limit → Token Budget</h1><p>Replaced hard 8-iteration cap with 200K input token budget + 50-iteration safety net.</p><h2>Why</h2><p>Complex queries need 8+ tool calls. The old limit caused the loop to exit with empty finalText — nothing streamed to client.</p><h2>Cost Analysis</h2><p>At 200K input tokens per conversation:</p><ul><li>Claude Sonnet: ~$0.60 per conversation</li><li>Most conversations use 20-50K tokens (well under budget)</li><li>Safety net prevents runaway loops</li></ul><h2>Forced Response</h2><p>When budget exhausted, agent generates a forced final response with whatever context it has — never silently fails.</p>',
      daysAgo: 4,
    },
    {
      userId: rahul.id,
      title: 'Quick Ideas',
      icon: '\uD83D\uDCA1',
      pinned: false,
      content: '<ul><li>Add "share to space" button on notes — post a note summary to a channel</li><li>Note templates: standup, meeting notes, 1:1 prep, weekly review</li><li>Slash commands in notes editor: /task to create inline task, /mention for people</li><li>Note version history (just store snapshots every N saves)</li><li>Collaborative notes — real-time editing like canvas</li></ul>',
      daysAgo: 1,
    },
    {
      userId: rahul.id,
      title: 'Huddles Phase 1 — Build Log',
      icon: '\uD83C\uDFA4',
      pinned: false,
      content: '<h2>What shipped</h2><p>Async voice clips — record in browser, transcribe, AI summarize, post to chat as a card.</p><h2>Stack</h2><ul><li>MediaRecorder API (webm/opus)</li><li>Clip processing pipeline: upload → transcribe → summarize → post</li><li>Transcription provider abstraction (Whisper local/API, Deepgram)</li></ul><h2>What\'s next</h2><ul><li>Phase 2: Video + screen clips</li><li>Phase 3: Live huddles via mediasoup (WebRTC SFU)</li><li>Phase 4: Polish + mobile</li></ul>',
      daysAgo: 5,
    },
    // Priya's notes
    {
      userId: priya.id,
      title: 'Auth Middleware Refactor',
      icon: '\uD83D\uDD10',
      pinned: true,
      content: '<h2>Legal Requirement</h2><p>Session tokens must use httpOnly cookies, not localStorage for refresh tokens.</p><h2>Plan</h2><ol><li>Move refresh token to httpOnly cookie</li><li>Keep access token in memory (short-lived, 15min)</li><li>Add CSRF protection for cookie-based auth</li><li>Update all API calls to include credentials</li></ol><h2>Risk</h2><p>Breaking change for existing sessions — need to handle graceful migration.</p>',
      daysAgo: 0,
    },
    {
      userId: priya.id,
      title: 'Web Clipper — Extension Architecture',
      icon: '\uD83C\uDF10',
      pinned: false,
      content: '<h2>Chrome Manifest V3</h2><ul><li><code>content.js</code> — extracts page content via Mozilla Readability</li><li><code>popup.html</code> — destination picker (space, task, or inbox)</li><li><code>background.js</code> — sends to Deft API with auth token</li></ul><p>~150 lines total. Ship as unlisted Chrome extension first, then Chrome Web Store.</p><h2>API Routes</h2><ul><li>POST /api/web-clips — save</li><li>GET /api/web-clips — list</li><li>GET /api/web-clips/search — full-text search</li></ul>',
      daysAgo: 1,
    },
  ];

  for (const n of noteDefs) {
    const d = new Date();
    d.setDate(d.getDate() - n.daysAgo);
    d.setHours(10 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 60));
    await pool.query(
      `INSERT INTO notes (id, org_id, user_id, title, content, icon, is_pinned, is_deleted, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,$8)`,
      [uuid(), orgId, n.userId, n.title, n.content, n.icon, n.pinned, d.toISOString()]
    );
  }

  const count = (await pool.query('SELECT count(*)::int as c FROM notes WHERE org_id = $1', [orgId])).rows[0].c;
  console.log(`Done! Seeded ${count} notes`);
  await pool.end();
}

seed().catch(e => { console.error(e); process.exit(1); });
