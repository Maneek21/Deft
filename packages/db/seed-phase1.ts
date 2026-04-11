import 'dotenv/config';
import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn',
});

const uuid = () => crypto.randomUUID();

async function seed() {
  const users = (await pool.query(`
    SELECT u.id, om.org_id FROM users u
    JOIN org_members om ON om.user_id = u.id
    LIMIT 5
  `)).rows;
  const allTasks = (await pool.query('SELECT id, org_id FROM tasks WHERE is_deleted = false ORDER BY created_at LIMIT 20')).rows;
  const allMessages = (await pool.query('SELECT id, org_id FROM messages WHERE is_deleted = false ORDER BY created_at LIMIT 20')).rows;

  const rahul = users[0];
  const priya = users[1];
  const orgId = rahul.org_id;

  console.log('Cleaning existing phase-1 data...');
  await pool.query('DELETE FROM entity_tags WHERE org_id = $1', [orgId]);
  await pool.query('DELETE FROM tags WHERE org_id = $1', [orgId]);
  await pool.query('DELETE FROM daily_notes WHERE org_id = $1', [orgId]);

  // ─── DAILY NOTES ───────────────────────────────────────────
  console.log('Seeding daily notes...');
  const today = new Date();
  const noteIds: string[] = [];

  const rahulNotes = [
    { offset: 0, content: 'Working on daily notes and tags feature for Deft. Need to finish the tag picker component and write seed data. Also reviewing Priya\'s PR for the auth middleware refactor.', mood: 'great' },
    { offset: -1, content: 'Had a productive sprint planning session. Decided to prioritize the Craft-inspired features over the agent memory refactor. Good call — these are daily-use surfaces.\n\nTODO:\n- Finish tag picker UI\n- Seed demo data\n- Fix the agent flashing bug', mood: 'good' },
    { offset: -2, content: 'Debugging the agent streaming issue all day. The SSE stream was buffering because of Hono\'s stream() vs streamSSE(). Finally fixed it. Frustrating but learned a lot about Hono internals.', mood: 'okay' },
    { offset: -3, content: 'Reviewed the feature roadmap with the team. 8 features mapped out, everyone seems aligned. Arjun is taking the calendar view, Priya handles web clipper.\n\nKey decision: Build daily notes + tags first (Phase 1), then calendar (Phase 2).', mood: 'good' },
    { offset: -4, content: 'Started the huddles feature — async clips are working end to end. MediaRecorder API is surprisingly nice to work with. Transcription pipeline needs Whisper setup.', mood: 'great' },
    { offset: -6, content: 'Slow day. Mostly code review and docs. Feeling a bit stuck on the agent memory architecture — too many options, need to simplify.', mood: 'rough' },
  ];

  for (const n of rahulNotes) {
    const d = new Date(today);
    d.setDate(d.getDate() + n.offset);
    const dateStr = d.toISOString().slice(0, 10);
    const noteId = uuid();
    noteIds.push(noteId);
    await pool.query(
      `INSERT INTO daily_notes (id, org_id, user_id, note_date, content, mood, auto_items, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())`,
      [noteId, orgId, rahul.id, dateStr, n.content, n.mood, JSON.stringify({ tasks: [], carried_over: [], events: [], mentions: [] })]
    );
  }

  const priyaNotes = [
    { offset: 0, content: 'Working on the auth middleware refactor. Legal flagged the session token storage — need to use httpOnly cookies instead of localStorage for the refresh token.', mood: 'good' },
    { offset: -1, content: 'Finished the web clipper API routes. Need to build the browser extension next. Taking a day to plan the Manifest V3 structure.', mood: 'okay' },
    { offset: -3, content: 'Team standup went well. Everyone is focused. Shipped the notification panel redesign — much cleaner now.', mood: 'great' },
  ];

  for (const n of priyaNotes) {
    const d = new Date(today);
    d.setDate(d.getDate() + n.offset);
    const dateStr = d.toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO daily_notes (id, org_id, user_id, note_date, content, mood, auto_items, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())`,
      [uuid(), orgId, priya.id, dateStr, n.content, n.mood, JSON.stringify({ tasks: [], carried_over: [], events: [], mentions: [] })]
    );
  }

  // ─── TAGS ──────────────────────────────────────────────────
  console.log('Seeding tags...');
  const tagDefs = [
    { name: 'launch', color: '#6366f1' },
    { name: 'blocked', color: '#ef4444' },
    { name: 'q3-planning', color: '#8b5cf6' },
    { name: 'design', color: '#ec4899' },
    { name: 'infra', color: '#06b6d4' },
    { name: 'ux-review', color: '#f97316' },
    { name: 'auth', color: '#22c55e' },
    { name: 'agent', color: '#3b82f6' },
  ];

  const tagIds: Record<string, string> = {};
  for (const t of tagDefs) {
    const id = uuid();
    tagIds[t.name] = id;
    await pool.query(
      `INSERT INTO tags (id, org_id, name, color, created_at, updated_at) VALUES ($1,$2,$3,$4,NOW(),NOW())`,
      [id, orgId, t.name, t.color]
    );
  }

  // ─── ENTITY_TAGS ───────────────────────────────────────────
  console.log('Applying tags to entities...');

  async function applyTag(tagName: string, entityType: string, entityId: string) {
    if (!tagIds[tagName] || !entityId) return;
    await pool.query(
      `INSERT INTO entity_tags (id, org_id, tag_id, entity_type, entity_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW(),NOW()) ON CONFLICT DO NOTHING`,
      [uuid(), orgId, tagIds[tagName], entityType, entityId]
    );
  }

  // Tags on tasks
  for (let i = 0; i < Math.min(5, allTasks.length); i++) await applyTag('launch', 'task', allTasks[i].id);
  for (let i = 1; i < Math.min(4, allTasks.length); i++) await applyTag('infra', 'task', allTasks[i].id);
  for (let i = 4; i < Math.min(8, allTasks.length); i++) await applyTag('design', 'task', allTasks[i].id);
  if (allTasks[2]) await applyTag('blocked', 'task', allTasks[2].id);
  if (allTasks[5]) await applyTag('blocked', 'task', allTasks[5].id);
  for (let i = 7; i < Math.min(12, allTasks.length); i++) await applyTag('q3-planning', 'task', allTasks[i].id);
  for (let i = 12; i < Math.min(15, allTasks.length); i++) await applyTag('auth', 'task', allTasks[i].id);
  for (let i = 15; i < Math.min(18, allTasks.length); i++) await applyTag('agent', 'task', allTasks[i].id);
  for (let i = 3; i < Math.min(6, allTasks.length); i++) await applyTag('ux-review', 'task', allTasks[i].id);

  // Tags on messages
  for (let i = 0; i < Math.min(3, allMessages.length); i++) await applyTag('launch', 'message', allMessages[i].id);
  for (let i = 3; i < Math.min(5, allMessages.length); i++) await applyTag('design', 'message', allMessages[i].id);
  for (let i = 5; i < Math.min(7, allMessages.length); i++) await applyTag('blocked', 'message', allMessages[i].id);
  for (let i = 7; i < Math.min(10, allMessages.length); i++) await applyTag('agent', 'message', allMessages[i].id);

  // Tags on daily notes
  if (noteIds[0]) await applyTag('launch', 'daily_note', noteIds[0]);
  if (noteIds[2]) await applyTag('agent', 'daily_note', noteIds[2]);
  if (noteIds[3]) await applyTag('q3-planning', 'daily_note', noteIds[3]);

  // Count results
  const tagCount = (await pool.query('SELECT count(*)::int as c FROM tags WHERE org_id = $1', [orgId])).rows[0].c;
  const noteCount = (await pool.query('SELECT count(*)::int as c FROM daily_notes WHERE org_id = $1', [orgId])).rows[0].c;
  const entityTagCount = (await pool.query('SELECT count(*)::int as c FROM entity_tags WHERE org_id = $1', [orgId])).rows[0].c;

  console.log(`\nDone! Seeded:`);
  console.log(`  ${noteCount} daily notes`);
  console.log(`  ${tagCount} tags`);
  console.log(`  ${entityTagCount} entity-tag associations`);

  await pool.end();
}

seed().catch(e => { console.error(e); process.exit(1); });
