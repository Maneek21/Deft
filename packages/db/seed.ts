import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and, asc } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import * as schema from './src/schema.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn',
});

const db = drizzle(pool, { schema });

async function seed() {
  console.log('Seeding database...');

  // Clean existing data in reverse dependency order
  await db.delete(schema.burnoutAlerts);
  await db.delete(schema.oneonePreps);
  await db.delete(schema.teamHealthSnapshots);
  await db.delete(schema.peopleRelationships);
  await db.delete(schema.peoplePatterns);
  await db.delete(schema.peopleInfluence);
  await db.delete(schema.peopleExpertise);
  await db.delete(schema.peopleInteractions);
  await db.delete(schema.managerSettings);
  await db.delete(schema.decisions);
  await db.delete(schema.meetingBriefs);
  await db.delete(schema.agentNudges);
  await db.delete(schema.auditLog);
  await db.delete(schema.crossReferences);
  await db.delete(schema.agentMemory);
  await db.delete(schema.standups);
  await db.delete(schema.jobQueue);
  await db.delete(schema.workflowRuns);
  await db.delete(schema.workflowRules);
  await db.delete(schema.customEmoji);
  await db.delete(schema.userGroupMembers);
  await db.delete(schema.userGroups);
  await db.delete(schema.messageBookmarks);
  await db.delete(schema.canvases);
  await db.delete(schema.taskActivity);
  await db.delete(schema.taskComments);
  await db.delete(schema.taskLabels);
  await db.delete(schema.taskRelationships);
  await db.delete(schema.tasks);
  await db.delete(schema.projectSpaces);
  await db.delete(schema.projects);
  await db.delete(schema.reactions);
  await db.delete(schema.pinnedMessages);
  await db.delete(schema.scheduledMessages);
  await db.delete(schema.files);
  await db.delete(schema.reminders);
  await db.delete(schema.messages);
  await db.delete(schema.spaceMembers);
  await db.delete(schema.spaces);
  await db.delete(schema.orgMembers);
  await db.delete(schema.onboardingState);
  await db.delete(schema.notifications);
  await db.delete(schema.favorites);
  await db.delete(schema.savedViews);
  await db.delete(schema.invites);
  await db.delete(schema.agentActions);
  // agent_messages and agent_conversations dropped in migration 0065 (Phase 2 unification)
  await db.delete(schema.triggers);
  await db.delete(schema.skills);
  await db.delete(schema.tools);
  await db.delete(schema.reminders);
  await db.delete(schema.labels);
  await db.delete(schema.events);
  await db.delete(schema.connectedAccounts);
  await db.delete(schema.orgs);
  await db.delete(schema.users);

  console.log('Cleaned existing data.');

  // ── Users ──
  const passwordHash = await bcrypt.hash('test1234', 12);

  const [maneek] = await db.insert(schema.users).values({
    name: 'Maneek',
    email: 'maneek@test.com',
    password_hash: passwordHash,
    email_verified: true,
  }).returning();

  const [rahul] = await db.insert(schema.users).values({
    name: 'Rahul',
    email: 'rahul@test.com',
    password_hash: passwordHash,
    email_verified: true,
  }).returning();

  const [priya] = await db.insert(schema.users).values({
    name: 'Priya',
    email: 'priya@test.com',
    password_hash: passwordHash,
    email_verified: true,
  }).returning();

  const [arjun] = await db.insert(schema.users).values({
    name: 'Arjun',
    email: 'arjun@test.com',
    password_hash: passwordHash,
    email_verified: true,
  }).returning();

  const [sara] = await db.insert(schema.users).values({
    name: 'Sara',
    email: 'sara@test.com',
    password_hash: passwordHash,
    email_verified: true,
  }).returning();

  console.log('Created users: Maneek, Rahul, Priya, Arjun, Sara');

  // ── Org ──
  const [org] = await db.insert(schema.orgs).values({
    name: 'Deft Labs',
    slug: 'deft-labs',
    timezone: 'Asia/Kolkata',
    trust_level: 'standard',
  }).returning();

  await db.insert(schema.orgMembers).values([
    { org_id: org!.id, user_id: maneek!.id, role: 'owner' },
    { org_id: org!.id, user_id: rahul!.id, role: 'member' },
    { org_id: org!.id, user_id: priya!.id, role: 'member' },
    { org_id: org!.id, user_id: arjun!.id, role: 'member' },
    { org_id: org!.id, user_id: sara!.id, role: 'member' },
  ]);

  console.log('Created org: Deft Labs');

  // ── Onboarding ──
  await db.insert(schema.onboardingState).values([
    { user_id: maneek!.id, org_created: true, profile_set: true, first_space_created: true, first_message_sent: true, first_task_created: true, completed: true },
    { user_id: rahul!.id, org_created: false, profile_set: true, first_message_sent: true, completed: false },
    { user_id: priya!.id, org_created: false, profile_set: true, first_message_sent: true, completed: false },
    { user_id: arjun!.id, org_created: false, profile_set: true, first_message_sent: false, completed: false },
    { user_id: sara!.id, org_created: false, profile_set: true, first_message_sent: true, completed: false },
  ]);

  // ── Spaces ──
  const [general] = await db.insert(schema.spaces).values({
    org_id: org!.id, name: 'general', description: 'Company-wide announcements and discussion', type: 'public', is_default: true, created_by: maneek!.id,
  }).returning();

  const [engineering] = await db.insert(schema.spaces).values({
    org_id: org!.id, name: 'engineering', description: 'Engineering team discussions', type: 'public', created_by: maneek!.id,
  }).returning();

  const [design] = await db.insert(schema.spaces).values({
    org_id: org!.id, name: 'design', description: 'Design reviews and feedback', type: 'public', created_by: maneek!.id,
  }).returning();

  const [random] = await db.insert(schema.spaces).values({
    org_id: org!.id, name: 'random', description: 'Water cooler', type: 'public', created_by: rahul!.id,
  }).returning();

  const [dm] = await db.insert(schema.spaces).values({
    org_id: org!.id, name: 'Maneek, Rahul', type: 'dm', created_by: maneek!.id,
  }).returning();

  const [dmManeekPriya] = await db.insert(schema.spaces).values({
    org_id: org!.id, name: 'Maneek, Priya', type: 'dm', created_by: maneek!.id,
  }).returning();

  const [dmManeekSara] = await db.insert(schema.spaces).values({
    org_id: org!.id, name: 'Maneek, Sara', type: 'dm', created_by: maneek!.id,
  }).returning();

  // Add Maneek and Rahul to all original spaces
  for (const space of [general!, engineering!, design!, random!, dm!]) {
    await db.insert(schema.spaceMembers).values([
      { space_id: space.id, user_id: maneek!.id },
      { space_id: space.id, user_id: rahul!.id },
    ]);
  }

  // Add new users to spaces
  // All 3 new users to #general and #random
  for (const space of [general!, random!]) {
    await db.insert(schema.spaceMembers).values([
      { space_id: space.id, user_id: priya!.id },
      { space_id: space.id, user_id: arjun!.id },
      { space_id: space.id, user_id: sara!.id },
    ]);
  }
  // Priya, Arjun, Sara to #engineering
  await db.insert(schema.spaceMembers).values([
    { space_id: engineering!.id, user_id: priya!.id },
    { space_id: engineering!.id, user_id: arjun!.id },
    { space_id: engineering!.id, user_id: sara!.id },
  ]);
  // Arjun to #design
  await db.insert(schema.spaceMembers).values([
    { space_id: design!.id, user_id: arjun!.id },
  ]);

  // DM members
  await db.insert(schema.spaceMembers).values([
    { space_id: dmManeekPriya!.id, user_id: maneek!.id },
    { space_id: dmManeekPriya!.id, user_id: priya!.id },
  ]);
  await db.insert(schema.spaceMembers).values([
    { space_id: dmManeekSara!.id, user_id: maneek!.id },
    { space_id: dmManeekSara!.id, user_id: sara!.id },
  ]);

  console.log('Created 7 spaces');

  // ── Helper to create messages with sequential timestamps ──
  const baseTime = new Date('2026-03-28T09:00:00Z');
  let msgOffset = 0;

  function msgTime() {
    msgOffset += 1;
    return new Date(baseTime.getTime() + msgOffset * 90_000); // 1.5 min apart
  }

  async function msg(spaceId: string, userId: string, content: string) {
    const [m] = await db.insert(schema.messages).values({
      org_id: org!.id, space_id: spaceId, user_id: userId, content, created_at: msgTime(),
    }).returning();
    return m!;
  }

  const M = maneek!.id;
  const R = rahul!.id;
  const P = priya!.id;
  const A = arjun!.id;
  const S = sara!.id;

  // ── #general — 10 messages about product launch ──
  await msg(general!.id, M, "Alright team, we're targeting end of next week for the private beta launch. Let's make sure all the critical paths are solid.");
  await msg(general!.id, R, "Sounds good. Auth flow is done, just need to wire up the email verification with Resend. Should be quick.");
  await msg(general!.id, M, "Perfect. The biggest risk right now is the real-time chat — we need to make sure Socket.io reconnects gracefully when people switch between tabs.");
  await msg(general!.id, R, "Yeah I noticed that too. I'll add exponential backoff on the client side. Also need to handle the case where the JWT expires mid-session.");
  await msg(general!.id, M, "Good call. For the token refresh, let's intercept the 401 in the API client and silently refresh before retrying. Users shouldn't notice anything.");
  await msg(general!.id, R, "Already set up that pattern in api.ts actually. It catches 401s, hits /auth/refresh, then replays the original request.");
  await msg(general!.id, M, "Nice. One more thing — I want to get the agent observation pipeline stubbed out before launch. Even if it doesn't do anything yet, I want every message flowing through the classifier.");
  await msg(general!.id, R, "Makes sense. We can use Haiku for classification — it's fast enough to not add noticeable latency. Want me to set up the BullMQ job for it?");
  await msg(general!.id, M, "Yes please. Keep it simple — just queue every new message, classify intent and urgency, store the result in metadata. We'll build the action pipeline in week 2.");
  await msg(general!.id, R, "On it. I'll have a PR up by tomorrow morning.");

  // ── #engineering — 8 messages about API architecture ──
  msgOffset += 5;
  await msg(engineering!.id, R, "Quick question on the API structure — should we keep the message routes mounted under /api/messages/:spaceId or nest them under /api/spaces/:id/messages?");
  await msg(engineering!.id, M, "I'd go with /api/spaces/:id/messages for the REST semantics. Messages belong to a space, the URL should reflect that hierarchy.");
  await msg(engineering!.id, R, "Fair point. I'll refactor the routes. Also, I'm thinking about the cursor-based pagination — right now we're using created_at as the cursor, but if two messages have the same timestamp we could skip one.");
  await msg(engineering!.id, M, "Good catch. Use a composite cursor — created_at + id. Sort by (created_at DESC, id DESC) and filter with (created_at, id) < (cursor_time, cursor_id).");
  await msg(engineering!.id, R, "That's clean. I'll update the query. Also wanted to flag — the database migration for adding pgvector is going to be a bit involved. We need the extension enabled.");
  await msg(engineering!.id, M, "Right, we'll need CREATE EXTENSION vector. Add it as a custom migration, not through Drizzle push. Don't want that running automatically in production.");
  await msg(engineering!.id, R, "Agreed. I'll write a manual migration script. For the embedding column, thinking 1536 dimensions to match OpenAI's ada-002, or should we go with a smaller model?");
  await msg(engineering!.id, M, "Let's use 1024 dims — we'll probably use Voyage or Cohere for embeddings, they're better for search. 1536 is overkill for our use case.");

  // ── #design — 5 messages about dashboard mockups ──
  msgOffset += 3;
  await msg(design!.id, M, "Pushed the first dashboard mockups to Figma. The idea is three sections: Today's briefing (agent-generated), active tasks, and upcoming events from connected calendars.");
  await msg(design!.id, R, "Just looked at them. Love the briefing card at the top. One thought — can we make the task section collapsible by project? When you have 20+ tasks it gets overwhelming.");
  await msg(design!.id, M, "Yeah absolutely. I was thinking accordion-style with the project icon and a count badge. Click to expand and see the tasks grouped by status.");
  await msg(design!.id, R, "That works. Also the dark mode palette is looking really good. The contrast ratios on the sidebar are much better than the last iteration.");
  await msg(design!.id, M, "Thanks, spent way too long tweaking those CSS variables. Going to extract them into a proper theme system so we can support custom brand colors per org down the road.");

  // ── #random — 6 casual messages ──
  msgOffset += 2;
  await msg(random!.id, R, "Has anyone tried that new South Indian place on 12th Main? The filter coffee is unreal.");
  await msg(random!.id, M, "Dosa Corner? Yes! Their ghee roast dosa is incredible. We should do a team lunch there.");
  await msg(random!.id, R, "Let's do Thursday. Also, random thought — should we add emoji reactions to messages before launch? It feels like table stakes for a chat app.");
  await msg(random!.id, M, "Agreed, reactions are essential. The schema already has a reactions table. Should be a quick frontend build — click emoji picker, POST to /api/reactions, broadcast via socket.");
  await msg(random!.id, R, "I'll scope it out. Might use the native emoji picker on Mac/Windows to keep the bundle small. No need for a custom one yet.");
  await msg(random!.id, M, "Smart. Ship the simple version first, we can always add a custom picker later if people want gif reactions or custom emoji.");

  // ── DM between Maneek and Rahul — 4 messages about a client meeting ──
  msgOffset += 2;
  await msg(dm!.id, M, "Hey, just got off a call with the Zephyr team. They want to pilot Deft for their 15-person eng team. Can you put together a quick demo environment by Wednesday?");
  await msg(dm!.id, R, "Oh nice, that's exciting! Yeah I can spin up a demo instance on Railway. Should I pre-populate it with sample data so they can see the chat + tasks in action?");
  await msg(dm!.id, M, "Exactly. Create a realistic workspace — a few spaces, some tasks across statuses, maybe mock a couple of agent suggestions. They specifically asked about the AI features.");
  await msg(dm!.id, R, "Got it. I'll set up the demo with the agent doing a daily standup summary and auto-creating tasks from chat messages. Even if it's semi-hardcoded, it'll show the vision.");

  // ── New messages in #general ──
  msgOffset += 2;
  await msg(general!.id, P, "Hey everyone! Just joined the team. Excited to work on the frontend.");
  await msg(general!.id, A, "Welcome Priya! Let me know if you need the Figma access link.");
  await msg(general!.id, S, "Welcome! I've added you to the sprint board. Let's sync tomorrow about priorities.");
  await msg(general!.id, M, "Great to have the full team now. Let's aim for the beta demo by Friday.");

  // ── New messages in #engineering ──
  msgOffset += 2;
  await msg(engineering!.id, P, "Found a hydration mismatch in the sidebar component. The useEffect for theme detection runs client-side but the server renders with the default theme.");
  await msg(engineering!.id, A, "We had a similar issue with the avatar colors. The hash function gives different results on server vs client because of crypto.randomUUID timing.");
  await msg(engineering!.id, S, "Can we track these in the project board? I want to make sure we don't ship the beta with hydration warnings.");
  await msg(engineering!.id, R, "I'll create tickets for both. The theme one is a quick fix — we just need to suppress hydration warnings on the html element.");

  // ── DM between Maneek and Priya — React hydration bug ──
  msgOffset += 2;
  await msg(dmManeekPriya!.id, M, "Hey Priya, saw your message about the hydration mismatch. Can you share the exact error from the console? I want to see if it's the same one I hit last week.");
  await msg(dmManeekPriya!.id, P, "Sure! It's 'Warning: Text content did not match. Server: \"light\" Client: \"dark\"'. Happens because we read localStorage for the theme in useEffect but the server always renders light.");
  await msg(dmManeekPriya!.id, M, "Yep, classic Next.js issue. The fix is to use suppressHydrationWarning on the html element and wrap the theme provider with a mounted check. I'll send you the pattern we used on a previous project.");

  // ── DM between Maneek and Sara — sprint planning ──
  msgOffset += 2;
  await msg(dmManeekSara!.id, S, "Hey Maneek, wanted to chat about sprint planning for next week. I think we should focus on closing the auth flow and the real-time reconnection before adding new features.");
  await msg(dmManeekSara!.id, M, "Agreed. Let's keep the sprint tight — auth, WebSocket reconnection, and cursor pagination. Everything else goes to backlog. Can you draft the sprint in the project board?");
  await msg(dmManeekSara!.id, S, "On it. I'll also add estimates for each task so we can track velocity. Should have the draft ready by tomorrow morning.");

  // ── #engineering — 50-message dense conversation between Rahul and Arjun ──
  msgOffset += 3;
  await msg(engineering!.id, R, "Arjun, you around? Need to figure out this WebSocket reconnection bug before the demo tomorrow.");
  await msg(engineering!.id, A, "Yeah I'm here. What's happening exactly?");
  await msg(engineering!.id, R, "When a user switches tabs for more than 30 seconds, the socket disconnects. On reconnect, it rejoins the room but misses every message that was sent while they were away.");
  await msg(engineering!.id, A, "So the gap between disconnect and reconnect — those messages just vanish from their view?");
  await msg(engineering!.id, R, "Exactly. They show up if you refresh the page because the initial load fetches from the DB, but the real-time layer drops them silently.");
  await msg(engineering!.id, A, "We need to track the last received message timestamp on the client. When reconnecting, send that timestamp to the server and have it replay anything newer.");
  await msg(engineering!.id, R, "That's what I was thinking. The server already stores everything in Postgres. On reconnect we can do a quick SELECT WHERE created_at > last_seen AND space_id = current_space.");
  await msg(engineering!.id, A, "What about ordering? If two messages come in at the exact same millisecond during the gap, we might deliver them out of order.");
  await msg(engineering!.id, R, "Good point. We should use the composite cursor — created_at + message id. Same pattern Maneek suggested for pagination.");
  await msg(engineering!.id, A, "Makes sense. Want me to handle the server-side replay endpoint while you do the client reconnect logic?");
  await msg(engineering!.id, R, "Yes please. The endpoint should be something like GET /api/spaces/:id/messages/since?after=<cursor>. Return max 200 messages to avoid blowing up the response.");
  await msg(engineering!.id, A, "Got it. I'll add the route now. Also, should we emit them as regular socket events or as a batch?");
  await msg(engineering!.id, R, "Batch. Emit a single 'messages:catchup' event with the array. Client processes them all at once, then resumes normal real-time flow.");
  await msg(engineering!.id, A, "Smart. That avoids 200 individual DOM updates. The client can just concat and re-sort.");
  await msg(engineering!.id, R, "Exactly. Alright, switching topics — did you see the Drizzle migration issue Sara flagged?");
  await msg(engineering!.id, A, "The one where drizzle-kit generate creates a migration that tries to recreate existing indexes?");
  await msg(engineering!.id, R, "Yeah. It's because we have custom SQL migrations alongside Drizzle-managed ones. The snapshot gets out of sync.");
  await msg(engineering!.id, A, "We should probably stop using drizzle push in development and only use generate + migrate. That way the snapshot stays consistent.");
  await msg(engineering!.id, R, "Agreed. I'll update the README. Also need to add the pgvector migration as a manual SQL file that runs before Drizzle migrations.");
  await msg(engineering!.id, A, "I can handle that. CREATE EXTENSION IF NOT EXISTS vector; — simple enough. Where do we put manual migrations?");
  await msg(engineering!.id, R, "Let's create a packages/db/manual/ folder. Number them 000_, 001_ etc. Run them in the seed script before Drizzle migrate.");
  await msg(engineering!.id, A, "Makes sense. Quick question on something else — the file upload flow. Are we doing presigned URLs to R2 or proxying through our API?");
  await msg(engineering!.id, R, "Presigned URLs. The flow is: client requests upload URL from our API, API generates presigned PUT to R2, client uploads directly. Avoids the API being a bottleneck for large files.");
  await msg(engineering!.id, A, "What's the max file size we're allowing?");
  await msg(engineering!.id, R, "50MB for now. We can bump it later. The presigned URL expires after 10 minutes. Once uploaded, client sends the file metadata (name, size, type, R2 key) back to our API to create the file record.");
  await msg(engineering!.id, A, "And for images, are we generating thumbnails?");
  await msg(engineering!.id, R, "Not yet. Phase 2. For now we just store the original and render it with width/height constraints in CSS. The browser handles the scaling.");
  await msg(engineering!.id, A, "Fair enough. Hey, one more thing — the typing indicator is flickering. When someone types fast, it shows and hides rapidly.");
  await msg(engineering!.id, R, "Yeah I noticed that. The issue is we emit 'typing:start' on every keystroke and 'typing:stop' after a 2-second timeout. But the timeout resets on each keystroke, causing the receiving end to see rapid start/stop events.");
  await msg(engineering!.id, A, "We should debounce the start event too. Only emit typing:start if we haven't sent one in the last 3 seconds.");
  await msg(engineering!.id, R, "Exactly. And on the receiving side, treat any 'typing:start' as 'this user is typing for the next 4 seconds'. Reset the timer on each new event. Only hide when the timer expires OR we get a 'typing:stop'.");
  await msg(engineering!.id, A, "That's how Slack does it. I'll refactor the typing indicator component. Should be a quick fix.");
  await msg(engineering!.id, R, "Thanks. Oh, also — have you looked at the notification system yet? Maneek wants it wired up before the demo.");
  await msg(engineering!.id, A, "I started on it. The schema has a notifications table with type, content, read status. The question is — what triggers a notification?");
  await msg(engineering!.id, R, "Three things for now: @mentions in chat, task assignments, and task status changes. DMs should always notify. Regular channel messages should NOT notify unless mentioned.");
  await msg(engineering!.id, A, "That matches Slack's model. I'll hook into the message creation route — check for @mention regex, create notifications for mentioned users.");
  await msg(engineering!.id, R, "For delivery, let's use socket first. Emit 'notification:new' to the user's personal room. We can add push notifications and email later.");
  await msg(engineering!.id, A, "Sounds good. Each user auto-joins a room like user:<userId> on connect, right?");
  await msg(engineering!.id, R, "Yep, that's already set up. The auth middleware on socket connection joins the user to their personal room and their org room.");
  // ── Save this message as Maneek's "last read" anchor in #engineering ──
  const engLastRead = await msg(engineering!.id, A, "Perfect. I'll have the notification flow done by tonight. Anything else blocking the demo?");
  // ── The remaining 10 messages will be "unread" for Maneek ──
  const engUnread1 = await msg(engineering!.id, R, "The task board drag-and-drop is janky. When you drag a card between columns, there's a 500ms delay before the status updates in the DB. Makes it feel laggy.");
  const engUnread2 = await msg(engineering!.id, A, "Optimistic update. Change the UI immediately on drop, fire the PATCH in the background. If it fails, revert.");
  const engUnread3 = await msg(engineering!.id, R, "Yeah, that's the pattern. The issue is dnd-kit fires onDragEnd with the new position, but our state update goes through React state → API call → re-render. We need to split that.");
  await msg(engineering!.id, A, "Update local state in onDragEnd synchronously, then fire the API call. If the API returns an error, revert the state to the previous snapshot.");
  await msg(engineering!.id, R, "I'll store a snapshot of the board state before each drag starts. On error, restore from snapshot. Simple undo.");
  await msg(engineering!.id, A, "Clean. What about the sort order within a column? If I drag a task between two others, we need fractional ordering.");
  await msg(engineering!.id, R, "I'm using integer sort_order right now. When inserting between two tasks, take the average. If the gap gets too small, rebalance the whole column.");
  await msg(engineering!.id, A, "That works for now. At scale we'd want something like LexoRank but let's not over-engineer it for 5 beta users.");
  await msg(engineering!.id, R, "Exactly. Ship it simple, optimize if it becomes a problem. Alright, I think we have a solid plan. Let me push what I have and you can pull and start on the replay endpoint.");
  await msg(engineering!.id, A, "Sounds good. I'll branch off main. One last thing — are we doing PR reviews or just merging to main during this sprint?");
  const engUnreadLast = await msg(engineering!.id, R, "Let's do quick PR reviews. Even a thumbs up is fine. Just want a second pair of eyes on things before they hit main. We can't afford broken builds right before the demo.");
  await msg(engineering!.id, A, "Agreed. I'll have the replay endpoint and notification flow up as PRs by tonight. Ping me when your reconnect logic is ready for review.");

  console.log('Created messages across all spaces');

  // ── Set "last read" positions for Maneek ──
  // Maneek has read #engineering up to the 40th message — last 12 are unread
  await db.update(schema.spaceMembers).set({
    last_read_message_id: engLastRead.id,
    last_read_at: new Date(engLastRead.created_at),
  }).where(
    and(
      eq(schema.spaceMembers.space_id, engineering!.id),
      eq(schema.spaceMembers.user_id, maneek!.id),
    )
  );

  // Maneek has read #general up to the 8th message — last 6 are unread
  const generalMsgs = await db.select({ id: schema.messages.id, created_at: schema.messages.created_at })
    .from(schema.messages)
    .where(eq(schema.messages.space_id, general!.id))
    .orderBy(asc(schema.messages.created_at));

  if (generalMsgs.length > 8) {
    const anchor = generalMsgs[7]!;
    await db.update(schema.spaceMembers).set({
      last_read_message_id: anchor.id,
      last_read_at: new Date(anchor.created_at),
    }).where(
      and(
        eq(schema.spaceMembers.space_id, general!.id),
        eq(schema.spaceMembers.user_id, maneek!.id),
      )
    );
  }

  console.log('Set read positions for Maneek');

  // ── Create notifications for Maneek from unread messages ──
  const unreadNotifs = [
    { from: 'Rahul', content: engUnread1.content, msgId: engUnread1.id, spaceId: engineering!.id, spaceName: 'engineering' },
    { from: 'Arjun', content: engUnread2.content, msgId: engUnread2.id, spaceId: engineering!.id, spaceName: 'engineering' },
    { from: 'Rahul', content: engUnread3.content, msgId: engUnread3.id, spaceId: engineering!.id, spaceName: 'engineering' },
    { from: 'Rahul', content: engUnreadLast.content, msgId: engUnreadLast.id, spaceId: engineering!.id, spaceName: 'engineering' },
  ];

  for (const n of unreadNotifs) {
    await db.insert(schema.notifications).values({
      org_id: org!.id,
      user_id: maneek!.id,
      type: 'message',
      title: `${n.from} in #${n.spaceName}`,
      body: n.content.replace(/<[^>]+>/g, '').slice(0, 200),
      link: `/chat?space=${n.spaceId}&message=${n.msgId}`,
      is_read: false,
    });
  }

  // Also create a couple task notifications
  await db.insert(schema.notifications).values({
    org_id: org!.id,
    user_id: maneek!.id,
    type: 'task_assigned',
    title: 'Sara assigned you DEFT-8',
    body: 'Build task board view',
    link: '/tasks?task=DEFT-8',
    is_read: false,
  });

  await db.insert(schema.notifications).values({
    org_id: org!.id,
    user_id: maneek!.id,
    type: 'task_updated',
    title: 'Rahul moved DEFT-10 to In Review',
    body: 'Auth middleware and JWT refresh',
    link: '/tasks?task=DEFT-10',
    is_read: true,
  });

  console.log('Created notifications for Maneek');

  // ── Project 1: Deft v1 ──
  const [project1] = await db.insert(schema.projects).values({
    org_id: org!.id, name: 'Deft v1', description: 'First release of the Deft workspace', prefix: 'DEFT', color: '#D4A853', lead_id: maneek!.id, task_counter: 15,
  }).returning();

  await db.insert(schema.projectSpaces).values({
    project_id: project1!.id, space_id: engineering!.id,
  });

  // ── Project 2: Design System ──
  const [project2] = await db.insert(schema.projects).values({
    org_id: org!.id, name: 'Design System', description: 'Component library and design tokens', prefix: 'DS', color: '#8B5CF6', lead_id: arjun!.id, task_counter: 8,
  }).returning();

  await db.insert(schema.projectSpaces).values({
    project_id: project2!.id, space_id: design!.id,
  });

  console.log('Created 2 projects');

  // ── Deft v1 Tasks (15 tasks) ──
  const deftTasks: { title: string; desc: string; status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done'; priority: 'p0' | 'p1' | 'p2' | 'p3'; assignee: string | null; num: number; creator?: string }[] = [
    // Backlog (3)
    { num: 1, title: 'Add message search filters', desc: 'Add search bar above the message list that filters messages by content, author, and date range.', status: 'backlog', priority: 'p2', assignee: null },
    { num: 2, title: 'Implement message forwarding', desc: 'Forward a message to another space or DM. Include the original sender and timestamp.', status: 'backlog', priority: 'p3', assignee: null },
    { num: 3, title: 'Add custom emoji support', desc: 'Allow orgs to upload custom emoji. Store in R2, surface in the emoji picker.', status: 'backlog', priority: 'p3', assignee: null },
    // Todo (3)
    { num: 4, title: 'Build notification preferences UI', desc: 'Settings page section where users can configure notification delivery: mentions only, all messages, muted per space.', status: 'todo', priority: 'p1', assignee: priya!.id, creator: sara!.id },
    { num: 5, title: 'Set up CI/CD pipeline', desc: 'GitHub Actions workflow: lint, type-check, build, test. Deploy to Railway on main branch push.', status: 'todo', priority: 'p1', assignee: rahul!.id, creator: maneek!.id },
    { num: 6, title: 'Design onboarding flow', desc: 'Multi-step onboarding for new users: profile setup, org creation or invite, first space, first message.', status: 'todo', priority: 'p2', assignee: arjun!.id, creator: sara!.id },
    // In Progress (3)
    { num: 7, title: 'Implement thread side panel', desc: 'Side panel that opens when clicking reply on a message. Shows parent message, thread replies, and a composer.', status: 'in_progress', priority: 'p0', assignee: rahul!.id },
    { num: 8, title: 'Build task board view', desc: 'Kanban board with drag-and-drop. Columns: Backlog, Todo, In Progress, In Review, Done. Use dnd-kit.', status: 'in_progress', priority: 'p0', assignee: maneek!.id },
    { num: 9, title: 'Design task detail panel', desc: 'Right side panel for task details: title, status, priority, assignee, description, comments, activity log.', status: 'in_progress', priority: 'p1', assignee: arjun!.id, creator: sara!.id },
    // In Review (2)
    { num: 10, title: 'Auth middleware and JWT refresh', desc: 'Hono middleware extracts JWT, validates, attaches user to context. Client-side interceptor auto-refreshes on 401.', status: 'in_review', priority: 'p1', assignee: rahul!.id },
    { num: 11, title: 'Space member management', desc: 'Add/remove members from spaces. Private space member invite flow. Member list with role badges.', status: 'in_review', priority: 'p1', assignee: priya!.id },
    // Done (4)
    { num: 12, title: 'Set up monorepo scaffolding', desc: 'pnpm workspaces with apps/web, apps/api, packages/db, packages/shared, packages/ai. TypeScript strict mode.', status: 'done', priority: 'p1', assignee: maneek!.id },
    { num: 13, title: 'Database schema design', desc: 'Drizzle ORM schema with 30 tables. Multi-tenant with org_id, soft deletes, timestamps, UUIDs.', status: 'done', priority: 'p0', assignee: maneek!.id },
    { num: 14, title: 'Real-time chat messaging', desc: 'Socket.io with JWT auth, room-per-space. Events: message:new, message:edited, typing indicators, presence.', status: 'done', priority: 'p0', assignee: rahul!.id },
    { num: 15, title: 'User signup and login flow', desc: 'Auth pages with email/password, JWT tokens, automatic org and #general space creation on signup.', status: 'done', priority: 'p1', assignee: priya!.id, creator: sara!.id },
  ];

  const createdTasks: Record<number, string> = {};

  for (const t of deftTasks) {
    const [task] = await db.insert(schema.tasks).values({
      org_id: org!.id, project_id: project1!.id, number: t.num, title: t.title,
      description: t.desc, status: t.status, priority: t.priority,
      assignee_id: t.assignee, created_by: t.creator || maneek!.id, sort_order: t.num,
    }).returning();
    createdTasks[t.num] = task!.id;
  }

  // ── Design System Tasks (8 tasks) ──
  const dsTasks: typeof deftTasks = [
    { num: 1, title: 'Icon library selection', desc: 'Evaluate lucide, phosphor, heroicons. Need consistent stroke widths and comprehensive coverage.', status: 'backlog', priority: 'p2', assignee: null, creator: arjun!.id },
    { num: 2, title: 'Animation guidelines', desc: 'Define timing, easing, and which interactions get animation. Max 150ms for micro-interactions.', status: 'backlog', priority: 'p3', assignee: null, creator: arjun!.id },
    { num: 3, title: 'Color palette documentation', desc: 'Document the warm neutral palette with amber accent. Include WCAG contrast ratios for all pairings.', status: 'todo', priority: 'p1', assignee: arjun!.id, creator: arjun!.id },
    { num: 4, title: 'Typography scale', desc: 'Plus Jakarta Sans for headings, DM Sans for body. Document sizes, weights, and letter-spacing.', status: 'todo', priority: 'p1', assignee: arjun!.id, creator: arjun!.id },
    { num: 5, title: 'Component library setup', desc: 'Set up Storybook or similar for documenting reusable React components with their variants.', status: 'in_progress', priority: 'p0', assignee: arjun!.id, creator: arjun!.id },
    { num: 6, title: 'Dark mode tokens', desc: 'CSS custom properties for dark mode. True black background, warm surfaces, correct contrast ratios.', status: 'in_progress', priority: 'p1', assignee: priya!.id, creator: arjun!.id },
    { num: 7, title: 'Design audit of current UI', desc: 'Review all existing pages and components for consistency with the design system.', status: 'done', priority: 'p1', assignee: arjun!.id, creator: sara!.id },
    { num: 8, title: 'Figma setup', desc: 'Create shared Figma project with component library, page templates, and design tokens.', status: 'done', priority: 'p2', assignee: arjun!.id, creator: arjun!.id },
  ];

  const dsTIds: Record<number, string> = {};
  for (const t of dsTasks) {
    const [task] = await db.insert(schema.tasks).values({
      org_id: org!.id, project_id: project2!.id, number: t.num, title: t.title,
      description: t.desc, status: t.status, priority: t.priority,
      assignee_id: t.assignee, created_by: t.creator || arjun!.id, sort_order: t.num,
    }).returning();
    dsTIds[t.num] = task!.id;
  }

  console.log('Created 23 tasks across 2 projects');

  // ── Task Comments ──
  await db.insert(schema.taskComments).values([
    { task_id: createdTasks[7]!, user_id: rahul!.id, content: 'Started on this. The main challenge is handling socket reconnection when the parent message is scrolled out of view. Using IntersectionObserver.' },
    { task_id: createdTasks[7]!, user_id: maneek!.id, content: 'Good approach. Make sure to handle the case where the thread panel is already open when a new reply comes in via socket.' },
    { task_id: createdTasks[8]!, user_id: maneek!.id, content: 'Using @dnd-kit/core for drag-and-drop. The column layout is working, now need to wire up the PATCH /api/tasks/:id call on drop.' },
    { task_id: createdTasks[10]!, user_id: rahul!.id, content: 'Moved to review. The middleware handles both access token validation and automatic refresh via the API client interceptor. Edge case: refresh token expired while tab is in background — redirects to login.' },
    { task_id: createdTasks[12]!, user_id: maneek!.id, content: 'All good. Schema pushed cleanly to local Postgres. 30 tables, all indexes in place.' },
    { task_id: dsTIds[5]!, user_id: arjun!.id, content: 'Set up the initial structure. Using CSS custom properties for all tokens so they can be overridden per-org in the future.' },
  ]);

  // ── Task Activity Log ──
  await db.insert(schema.taskActivity).values([
    { task_id: createdTasks[7]!, user_id: rahul!.id, action: 'status_changed', field: 'status', old_value: 'todo', new_value: 'in_progress' },
    { task_id: createdTasks[8]!, user_id: maneek!.id, action: 'status_changed', field: 'status', old_value: 'todo', new_value: 'in_progress' },
    { task_id: createdTasks[10]!, user_id: rahul!.id, action: 'status_changed', field: 'status', old_value: 'in_progress', new_value: 'in_review' },
    { task_id: createdTasks[11]!, user_id: priya!.id, action: 'status_changed', field: 'status', old_value: 'in_progress', new_value: 'in_review' },
    { task_id: createdTasks[12]!, user_id: maneek!.id, action: 'status_changed', field: 'status', old_value: 'in_progress', new_value: 'done' },
    { task_id: createdTasks[13]!, user_id: maneek!.id, action: 'status_changed', field: 'status', old_value: 'in_review', new_value: 'done' },
    { task_id: createdTasks[14]!, user_id: rahul!.id, action: 'status_changed', field: 'status', old_value: 'in_review', new_value: 'done' },
    { task_id: createdTasks[15]!, user_id: priya!.id, action: 'status_changed', field: 'status', old_value: 'in_review', new_value: 'done' },
    { task_id: createdTasks[7]!, user_id: maneek!.id, action: 'assigned', field: 'assignee_id', old_value: null, new_value: rahul!.id },
    { task_id: dsTIds[5]!, user_id: arjun!.id, action: 'status_changed', field: 'status', old_value: 'todo', new_value: 'in_progress' },
    { task_id: dsTIds[7]!, user_id: arjun!.id, action: 'status_changed', field: 'status', old_value: 'in_review', new_value: 'done' },
  ]);

  // ── Labels ──
  const [bugLabel] = await db.insert(schema.labels).values({ org_id: org!.id, name: 'bug', color: '#ef4444' }).returning();
  const [featureLabel] = await db.insert(schema.labels).values({ org_id: org!.id, name: 'feature', color: '#3b82f6' }).returning();
  const [designLabel] = await db.insert(schema.labels).values({ org_id: org!.id, name: 'design', color: '#8b5cf6' }).returning();

  await db.insert(schema.taskLabels).values([
    { task_id: createdTasks[7]!, label_id: featureLabel!.id },
    { task_id: createdTasks[8]!, label_id: featureLabel!.id },
    { task_id: createdTasks[9]!, label_id: designLabel!.id },
    { task_id: createdTasks[1]!, label_id: featureLabel!.id },
    { task_id: createdTasks[12]!, label_id: featureLabel!.id },
    { task_id: dsTIds[3]!, label_id: designLabel!.id },
    { task_id: dsTIds[4]!, label_id: designLabel!.id },
    { task_id: dsTIds[5]!, label_id: designLabel!.id },
    { task_id: dsTIds[7]!, label_id: designLabel!.id },
  ]);

  console.log('Created task data (comments, activity, labels)');

  // ═══════════════════════════════════════════════════════════════
  // LIFE — Make the workspace feel lived-in
  // ═══════════════════════════════════════════════════════════════

  // ── Reactions on existing messages ──
  const allEngMsgs = await db.select({ id: schema.messages.id, user_id: schema.messages.user_id })
    .from(schema.messages)
    .where(eq(schema.messages.space_id, engineering!.id))
    .orderBy(asc(schema.messages.created_at));

  // Sprinkle reactions across engineering messages
  const reactionPairs: [number, string, string][] = [
    [2, R, '👍'], [2, A, '💯'], [5, M, '🔥'], [5, P, '👀'],
    [8, R, '✅'], [10, A, '🚀'], [14, M, '💡'], [14, S, '💡'],
    [18, R, '👍'], [20, A, '🎯'], [25, M, '💪'], [30, R, '👀'],
    [35, A, '🙌'], [40, M, '🔥'], [40, P, '🔥'], [45, R, '✅'],
    [48, A, '🚀'], [48, M, '🚀'], [50, R, '💯'], [50, A, '🎉'],
  ];
  for (const [idx, userId, emoji] of reactionPairs) {
    if (allEngMsgs[idx]) {
      await db.insert(schema.reactions).values({
        message_id: allEngMsgs[idx]!.id, user_id: userId, emoji,
      }).catch(() => {}); // ignore duplicates
    }
  }

  // Reactions in #general
  const allGenMsgs = await db.select({ id: schema.messages.id })
    .from(schema.messages)
    .where(eq(schema.messages.space_id, general!.id))
    .orderBy(asc(schema.messages.created_at));
  if (allGenMsgs[0]) await db.insert(schema.reactions).values({ message_id: allGenMsgs[0]!.id, user_id: R, emoji: '🚀' }).catch(() => {});
  if (allGenMsgs[0]) await db.insert(schema.reactions).values({ message_id: allGenMsgs[0]!.id, user_id: P, emoji: '🚀' }).catch(() => {});
  if (allGenMsgs[0]) await db.insert(schema.reactions).values({ message_id: allGenMsgs[0]!.id, user_id: A, emoji: '💪' }).catch(() => {});
  if (allGenMsgs[8]) await db.insert(schema.reactions).values({ message_id: allGenMsgs[8]!.id, user_id: M, emoji: '👋' }).catch(() => {});
  if (allGenMsgs[8]) await db.insert(schema.reactions).values({ message_id: allGenMsgs[8]!.id, user_id: R, emoji: '👋' }).catch(() => {});
  if (allGenMsgs[9]) await db.insert(schema.reactions).values({ message_id: allGenMsgs[9]!.id, user_id: M, emoji: '🙏' }).catch(() => {});

  // Reactions in #random
  const allRandMsgs = await db.select({ id: schema.messages.id })
    .from(schema.messages)
    .where(eq(schema.messages.space_id, random!.id))
    .orderBy(asc(schema.messages.created_at));
  if (allRandMsgs[0]) await db.insert(schema.reactions).values({ message_id: allRandMsgs[0]!.id, user_id: M, emoji: '☕' }).catch(() => {});
  if (allRandMsgs[1]) await db.insert(schema.reactions).values({ message_id: allRandMsgs[1]!.id, user_id: R, emoji: '🤤' }).catch(() => {});
  if (allRandMsgs[1]) await db.insert(schema.reactions).values({ message_id: allRandMsgs[1]!.id, user_id: P, emoji: '😋' }).catch(() => {});

  console.log('Added reactions');

  // ── Pin a key message in #engineering ──
  if (allEngMsgs[10]) {
    await db.insert(schema.pinnedMessages).values({
      message_id: allEngMsgs[10]!.id, space_id: engineering!.id, pinned_by: R,
    }).catch(() => {});
  }
  // Pin the launch announcement in #general
  if (allGenMsgs[0]) {
    await db.insert(schema.pinnedMessages).values({
      message_id: allGenMsgs[0]!.id, space_id: general!.id, pinned_by: M,
    }).catch(() => {});
  }

  console.log('Pinned key messages');

  // ── Thread replies — make conversations deeper ──
  // Thread on the WebSocket reconnection message in engineering
  if (allEngMsgs[2]) {
    msgOffset += 1;
    await db.insert(schema.messages).values({
      org_id: org!.id, space_id: engineering!.id, user_id: S,
      content: "I ran into a similar issue at my last company. We ended up using a \"last event ID\" header on reconnect — the server replays everything after that ID. Much cleaner than timestamps.",
      parent_id: allEngMsgs[2]!.id, created_at: msgTime(),
    });
    msgOffset += 1;
    await db.insert(schema.messages).values({
      org_id: org!.id, space_id: engineering!.id, user_id: P,
      content: "That's the Server-Sent Events pattern, right? We could do the same with Socket.io — store a sequence number per space and replay on reconnect.",
      parent_id: allEngMsgs[2]!.id, created_at: msgTime(),
    });
    msgOffset += 1;
    await db.insert(schema.messages).values({
      org_id: org!.id, space_id: engineering!.id, user_id: R,
      content: "Good ideas from both of you. I'll combine the approaches — sequence ID for ordering, timestamp for the initial catch-up window. Should be bulletproof.",
      parent_id: allEngMsgs[2]!.id, created_at: msgTime(),
    });
  }

  // Thread on the Drizzle migration message
  if (allEngMsgs[16]) {
    msgOffset += 1;
    await db.insert(schema.messages).values({
      org_id: org!.id, space_id: engineering!.id, user_id: P,
      content: "I've been bitten by this exact issue before. The trick is to never use `drizzle push` in development — always `generate` + `migrate`. That way the snapshot JSON stays in sync.",
      parent_id: allEngMsgs[16]!.id, created_at: msgTime(),
    });
  }

  // Thread in #general on the beta launch
  if (allGenMsgs[0]) {
    msgOffset += 1;
    await db.insert(schema.messages).values({
      org_id: org!.id, space_id: general!.id, user_id: S,
      content: "I've created a checklist for the beta launch in the project board. 12 items — let's try to close them all by Thursday EOD.",
      parent_id: allGenMsgs[0]!.id, created_at: msgTime(),
    });
    msgOffset += 1;
    await db.insert(schema.messages).values({
      org_id: org!.id, space_id: general!.id, user_id: A,
      content: "Just reviewed the list. I think we can defer the custom emoji and message forwarding — not critical for beta. That leaves 10 items.",
      parent_id: allGenMsgs[0]!.id, created_at: msgTime(),
    });
    msgOffset += 1;
    await db.insert(schema.messages).values({
      org_id: org!.id, space_id: general!.id, user_id: M,
      content: "Agreed. Let's focus on core chat + tasks + agent. Everything else is nice-to-have for beta.",
      parent_id: allGenMsgs[0]!.id, created_at: msgTime(),
    });
  }

  console.log('Added thread replies');

  // ── More #general conversation — team standup style ──
  msgOffset += 5;
  await msg(general!.id, S, "Morning everyone. Quick standup:\n\n**Yesterday:** Set up sprint board with estimates for all 15 Deft v1 tasks. Reviewed Priya's notification preferences PR.\n**Today:** Writing the CI/CD pipeline for GitHub Actions. Should have lint + build + deploy by EOD.\n**Blockers:** None.");
  await msg(general!.id, R, "**Yesterday:** Finished the JWT refresh interceptor. Also started on the thread side panel — got the basic layout rendering.\n**Today:** Thread panel replies + Socket.io broadcast for new replies.\n**Blockers:** None, but I need design input on the thread panel width from Arjun.");
  await msg(general!.id, A, "**Yesterday:** Reviewed the design system tokens and pushed the dark mode CSS variables. Started the task detail panel mockup.\n**Today:** Finishing the task detail panel — status, priority, assignee, description, comments section.\n**Blockers:** Waiting on the Figma components from the icon audit.");
  await msg(general!.id, P, "**Yesterday:** Fixed the hydration mismatch bug (PR #34). Started on the notification preferences UI.\n**Today:** Notification settings page — per-space mute, mention-only mode, DND schedule.\n**Blockers:** Need the notification API schema finalized — Rahul, can we sync on that?");
  await msg(general!.id, M, "Great updates. Rahul + Priya, sync on the notification schema today. Arjun, I'll review your task panel mockup after lunch. Sara, let me know when CI/CD is up so I can test the deploy flow.");

  // ── More #design conversation ──
  msgOffset += 3;
  await msg(design!.id, A, "Pushed updated mockups for the task detail panel. Key changes:\n\n1. Moved comments to a separate tab to keep the main view clean\n2. Added an activity timeline on the right rail\n3. Status badge is now a dropdown, not a separate button\n\nFigma link in the thread.");
  await msg(design!.id, P, "Love the tabbed approach. One suggestion — can we add a \"Linked messages\" tab too? When the agent cross-references a chat message with a task, it would show up there.");
  await msg(design!.id, M, "That's a great idea, Priya. Arjun, can you add that to the mockup? Also, the activity timeline should show who changed what — not just \"status changed\" but \"Rahul moved to In Progress\".");
  await msg(design!.id, A, "On it. I'll also add the linked messages tab. Should have the updated version by tomorrow.");
  await msg(design!.id, S, "The font pairing is really working well. Inter for body + JetBrains Mono for code and metadata — gives it that technical but approachable feel. Nice work.");
  await msg(design!.id, A, "Thanks! The trick was getting the weight right — Inter at 400 for body, 500 for labels, 600 for headings. Anything heavier looks clunky in dark mode.");
  await msg(design!.id, M, "What about the mobile breakpoints? We should at least have the sidebar collapse to a hamburger menu on tablet.");
  await msg(design!.id, A, "Already in the spec — sidebar collapses at 768px to an icon-only rail, and at 640px it becomes a slide-over overlay. The main content area is always full-width on mobile.");

  // ── More #random — team culture ──
  msgOffset += 3;
  await msg(random!.id, P, "Has anyone used Arc browser? I just switched from Chrome and it's incredible. The sidebar tabs are so much better for context switching.");
  await msg(random!.id, A, "I've been on Arc for 6 months. The split view is amazing for frontend work — code on the left, browser on the right. Also the command bar (Cmd+T) is exactly what we're building for Deft's command palette.");
  await msg(random!.id, R, "Still on Firefox. Old habits die hard. But I'll admit the Arc command bar looks nice.");
  await msg(random!.id, M, "I use Arc for personal, Chrome for work (DevTools are still slightly better for debugging WebSocket frames). The spaces feature in Arc is interesting — might inspire our workspace switching UI.");
  await msg(random!.id, S, "Speaking of browsers, reminder that we need to test Deft on Safari before beta. Last time I checked, our CSS backdrop-filter wasn't rendering on iOS Safari.");
  await msg(random!.id, A, "Good call. I'll add it to the QA checklist. Also we should test on Firefox — some of the CSS custom properties might behave differently.");
  await msg(random!.id, P, "I can handle Safari testing — I have a MacBook with the latest Safari. Anyone have a Windows machine for Edge testing?");
  await msg(random!.id, R, "I've got a Windows laptop. I'll test on Edge and Firefox on Windows. Let's aim to have cross-browser testing done by Wednesday.");
  msgOffset += 2;
  await msg(random!.id, M, "Team lunch at Dosa Corner confirmed for Thursday 12:30pm. I made a reservation for 6 (leaving one seat for future hires 😄). Sara, can you make it?");
  await msg(random!.id, S, "Wouldn't miss it! I've heard the masala dosa is life-changing.");
  await msg(random!.id, A, "Order the filter coffee. Trust me.");

  // ── More DM: Maneek ↔ Rahul — deeper conversation ──
  msgOffset += 2;
  await msg(dm!.id, R, "Hey, the Zephyr demo is set up on Railway. URL: https://demo.deft.dev. Pre-populated with a workspace called 'Zephyr Engineering' — 3 spaces, 15 tasks, some fake agent conversations.");
  await msg(dm!.id, M, "Perfect. I just ran through it — looks great. One thing: can you make the agent suggest creating a task when someone types something that sounds actionable? That would really wow them.");
  await msg(dm!.id, R, "Already working on it. The classifier detects 'task_create' intent. When confidence > 0.7, it shows an inline suggestion card. Should be live in the demo by tonight.");
  await msg(dm!.id, M, "That's exactly what I was thinking. Also — they asked about pricing. I'm thinking:\n\n- **Free:** Up to 5 users, 1 project, basic AI (100 queries/month)\n- **Pro:** $8/user/month, unlimited projects, full AI, integrations\n- **Enterprise:** Custom pricing, SSO, audit logs, dedicated support\n\nThoughts?");
  await msg(dm!.id, R, "Pricing feels right. The free tier is generous enough to get teams hooked. Pro at $8 is competitive with Linear ($8) and way cheaper than Slack ($12.50) + Linear combined. The AI angle justifies the price.");
  await msg(dm!.id, M, "Exactly my thinking. The pitch is: \"You're paying $20/user/month for Slack + Linear + AI tools. Deft gives you all three for $8.\" Let's finalize this after the Zephyr demo.");

  // ── More DM: Maneek ↔ Priya ──
  msgOffset += 2;
  await msg(dmManeekPriya!.id, P, "Quick question about the notification preferences. Should we store them per-space or globally? Like, should a user be able to mute #random but get all notifications from #engineering?");
  await msg(dmManeekPriya!.id, M, "Per-space. That's how Slack does it and users expect that level of control. Store it on the space_members table — add a `notification_pref` enum: 'all', 'mentions', 'none'.");
  await msg(dmManeekPriya!.id, P, "Makes sense. I'll add the column and build the UI. Should be a simple dropdown in the channel header.");
  await msg(dmManeekPriya!.id, M, "Perfect. Also, when a user is in DND mode, we should still collect notifications but not deliver them. When DND ends, show a summary: \"You missed 12 messages in 3 channels.\"");
  await msg(dmManeekPriya!.id, P, "Oh that's a nice touch. I'll add that to the spec. The notification panel can have a \"While you were away\" section at the top.");

  // ── More DM: Maneek ↔ Sara ──
  msgOffset += 2;
  await msg(dmManeekSara!.id, M, "Sara, I've been thinking about the CI/CD setup. Can we add a preview deploy for each PR? So when someone opens a PR, a temporary URL gets posted in the PR comment with a running instance of that branch.");
  await msg(dmManeekSara!.id, S, "That's doable with Railway's preview environments. Each PR gets its own deploy with its own Postgres. The only thing we'd need to handle is seeding the preview DB with test data.");
  await msg(dmManeekSara!.id, M, "Let's use the same seed script we use for development. The preview environment just needs to run `npx tsx packages/db/seed.ts` after the deploy.");
  await msg(dmManeekSara!.id, S, "I'll set that up in the GitHub Actions workflow. Also — should we run the test suite in CI? We don't have many tests yet but setting up the pipeline now means we're ready when we write them.");
  await msg(dmManeekSara!.id, M, "Yes. Even if it's just type-checking and lint for now. Having the pipeline green/red on every PR sets the right culture from day one.");

  console.log('Added life to the workspace');

  // ── More task comments — real development discussion ──
  await db.insert(schema.taskComments).values([
    { task_id: createdTasks[4]!, user_id: priya!.id, content: 'Started the notification preferences UI. Using a simple dropdown per channel: All messages / Mentions only / Nothing. Screenshot in the PR.' },
    { task_id: createdTasks[4]!, user_id: sara!.id, content: 'Looks clean. One thought — add a "Same as default" option so users don\'t have to configure every single channel.' },
    { task_id: createdTasks[5]!, user_id: sara!.id, content: 'CI pipeline is live! GitHub Actions workflow: lint → type-check → build. Takes about 2 minutes. Deploy to Railway triggered on push to main.' },
    { task_id: createdTasks[5]!, user_id: rahul!.id, content: 'Nice, just saw it run on my PR. One thing — can we cache the pnpm install step? It\'s taking 45 seconds and the cache should bring it to ~5s.' },
    { task_id: createdTasks[5]!, user_id: sara!.id, content: 'Good call, added `actions/cache@v4` with pnpm store path. Install now takes 4 seconds on cache hit. Total pipeline: 1m 20s.' },
    { task_id: createdTasks[6]!, user_id: arjun!.id, content: 'Onboarding flow wireframes done. 4 steps: 1) Create account 2) Name your org 3) Invite teammates 4) Create your first channel. Each step has a progress bar and skip option.' },
    { task_id: createdTasks[9]!, user_id: arjun!.id, content: 'Task detail panel v2 is up. Added tabbed view (Details / Comments / Activity / Linked). Status is a dropdown now. Priority uses colored dots. Assignee shows avatar + name with click-to-change.' },
    { task_id: createdTasks[9]!, user_id: maneek!.id, content: 'This looks really good. The tabbed approach is much cleaner than the scroll-everything-in-one-view approach. Ship it.' },
    { task_id: createdTasks[11]!, user_id: priya!.id, content: 'Member management is ready for review. Covers: add member by email, remove member, role badges (owner/admin/member/guest), and a "Leave channel" option in the member panel.' },
    { task_id: dsTIds[3]!, user_id: arjun!.id, content: 'Color palette documented with full WCAG contrast ratios. Every text/background pairing passes AA. The accent violet (#9080FA) on dark surface (#201F22) has a 5.8:1 ratio — well above the 4.5:1 minimum.' },
    { task_id: dsTIds[6]!, user_id: priya!.id, content: 'Dark mode tokens are in. 28 CSS custom properties organized by function: surface hierarchy (8), text (5), accent (6), status (5), utility (4). All referenced via var() — zero hardcoded colors in components.' },
  ]);

  // ── Add due dates to some tasks ──
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(17, 0, 0, 0);
  const nextWeek = new Date(); nextWeek.setDate(nextWeek.getDate() + 7); nextWeek.setHours(17, 0, 0, 0);
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(17, 0, 0, 0);
  const twoDaysAgo = new Date(); twoDaysAgo.setDate(twoDaysAgo.getDate() - 2); twoDaysAgo.setHours(17, 0, 0, 0);

  await db.update(schema.tasks).set({ due_date: tomorrow }).where(eq(schema.tasks.id, createdTasks[7]!));
  await db.update(schema.tasks).set({ due_date: tomorrow }).where(eq(schema.tasks.id, createdTasks[5]!));
  await db.update(schema.tasks).set({ due_date: nextWeek }).where(eq(schema.tasks.id, createdTasks[4]!));
  await db.update(schema.tasks).set({ due_date: nextWeek }).where(eq(schema.tasks.id, createdTasks[6]!));
  await db.update(schema.tasks).set({ due_date: yesterday }).where(eq(schema.tasks.id, createdTasks[9]!)); // overdue!
  await db.update(schema.tasks).set({ due_date: twoDaysAgo }).where(eq(schema.tasks.id, createdTasks[10]!)); // overdue!
  await db.update(schema.tasks).set({ due_date: nextWeek }).where(eq(schema.tasks.id, dsTIds[3]!));
  await db.update(schema.tasks).set({ due_date: nextWeek }).where(eq(schema.tasks.id, dsTIds[5]!));

  console.log('Added due dates (including 2 overdue tasks)');

  // ── More labels ──
  const [infraLabel] = await db.insert(schema.labels).values({ org_id: org!.id, name: 'infra', color: '#f59e0b' }).returning();
  const [uxLabel] = await db.insert(schema.labels).values({ org_id: org!.id, name: 'ux', color: '#ec4899' }).returning();
  const [p0Label] = await db.insert(schema.labels).values({ org_id: org!.id, name: 'critical', color: '#dc2626' }).returning();

  await db.insert(schema.taskLabels).values([
    { task_id: createdTasks[5]!, label_id: infraLabel!.id },
    { task_id: createdTasks[10]!, label_id: infraLabel!.id },
    { task_id: createdTasks[4]!, label_id: uxLabel!.id },
    { task_id: createdTasks[6]!, label_id: uxLabel!.id },
    { task_id: createdTasks[7]!, label_id: p0Label!.id },
    { task_id: dsTIds[6]!, label_id: uxLabel!.id },
  ]);

  console.log('Added more labels (infra, ux, critical)');

  // ── User statuses — show people are active ──
  await db.update(schema.users).set({
    status_emoji: '🎯', status_text: 'Heads down — do not disturb',
  }).where(eq(schema.users.id, rahul!.id));

  await db.update(schema.users).set({
    status_emoji: '🏠', status_text: 'Working remotely',
  }).where(eq(schema.users.id, priya!.id));

  await db.update(schema.users).set({
    title: 'Design Lead',
  }).where(eq(schema.users.id, arjun!.id));

  await db.update(schema.users).set({
    title: 'Engineering Manager',
  }).where(eq(schema.users.id, sara!.id));

  await db.update(schema.users).set({
    title: 'Founder & CEO',
  }).where(eq(schema.users.id, maneek!.id));

  console.log('Set user statuses and titles');

  // ── More notifications for Maneek — varied types ──
  await db.insert(schema.notifications).values([
    { org_id: org!.id, user_id: maneek!.id, type: 'mention', title: 'Priya mentioned you in #engineering', body: 'Hey @Maneek can you review the notification preferences PR?', link: `/chat?space=${engineering!.id}`, is_read: false },
    { org_id: org!.id, user_id: maneek!.id, type: 'task_updated', title: 'Sara moved DEFT-5 to In Progress', body: 'Set up CI/CD pipeline', link: '/tasks?task=DEFT-5', is_read: false },
    { org_id: org!.id, user_id: maneek!.id, type: 'message', title: 'Arjun in #design', body: 'Pushed updated mockups for the task detail panel...', link: `/chat?space=${design!.id}`, is_read: false },
    { org_id: org!.id, user_id: maneek!.id, type: 'mention', title: 'Rahul replied to your message', body: 'Good call, added actions/cache@v4 with pnpm store path...', link: `/chat?space=${engineering!.id}`, is_read: true },
    { org_id: org!.id, user_id: maneek!.id, type: 'task_assigned', title: 'You were assigned DEFT-13', body: 'Database schema design', link: '/tasks?task=DEFT-13', is_read: true },
  ]);

  // Notifications for other users too
  await db.insert(schema.notifications).values([
    { org_id: org!.id, user_id: rahul!.id, type: 'mention', title: 'Maneek mentioned you in DM', body: 'Can you put together a quick demo environment...', link: '/chat', is_read: false },
    { org_id: org!.id, user_id: rahul!.id, type: 'task_updated', title: 'Priya moved DEFT-11 to In Review', body: 'Space member management', link: '/tasks?task=DEFT-11', is_read: false },
    { org_id: org!.id, user_id: priya!.id, type: 'task_assigned', title: 'Sara assigned you DEFT-4', body: 'Build notification preferences UI', link: '/tasks?task=DEFT-4', is_read: false },
    { org_id: org!.id, user_id: arjun!.id, type: 'mention', title: 'Maneek in #design', body: 'Arjun, can you add the linked messages tab...', link: `/chat?space=${design!.id}`, is_read: false },
    { org_id: org!.id, user_id: sara!.id, type: 'task_updated', title: 'Rahul completed DEFT-14', body: 'Real-time chat messaging', link: '/tasks?task=DEFT-14', is_read: true },
  ]);

  console.log('Added more notifications for all users');

  // ── More task activity — realistic history ──
  await db.insert(schema.taskActivity).values([
    { task_id: createdTasks[4]!, user_id: sara!.id, action: 'assigned', field: 'assignee_id', old_value: null, new_value: priya!.id },
    { task_id: createdTasks[5]!, user_id: maneek!.id, action: 'assigned', field: 'assignee_id', old_value: null, new_value: rahul!.id },
    { task_id: createdTasks[5]!, user_id: sara!.id, action: 'status_changed', field: 'status', old_value: 'todo', new_value: 'in_progress' },
    { task_id: createdTasks[6]!, user_id: sara!.id, action: 'assigned', field: 'assignee_id', old_value: null, new_value: arjun!.id },
    { task_id: createdTasks[9]!, user_id: maneek!.id, action: 'priority_changed', field: 'priority', old_value: 'p2', new_value: 'p1' },
    { task_id: dsTIds[6]!, user_id: arjun!.id, action: 'assigned', field: 'assignee_id', old_value: null, new_value: priya!.id },
    { task_id: dsTIds[6]!, user_id: priya!.id, action: 'status_changed', field: 'status', old_value: 'todo', new_value: 'in_progress' },
  ]);

  console.log('Added more task activity history');

  // ── Set read positions for other users too ──
  // Rahul has read #general fully but not the latest #engineering messages
  const lastGenMsg = allGenMsgs[allGenMsgs.length - 1];
  if (lastGenMsg) {
    await db.update(schema.spaceMembers).set({
      last_read_message_id: lastGenMsg.id,
      last_read_at: new Date(),
    }).where(and(
      eq(schema.spaceMembers.space_id, general!.id),
      eq(schema.spaceMembers.user_id, rahul!.id),
    ));
  }

  // Rahul has read engineering up to message 45 (5 unread)
  if (allEngMsgs[44]) {
    await db.update(schema.spaceMembers).set({
      last_read_message_id: allEngMsgs[44]!.id,
      last_read_at: new Date(allEngMsgs[44]!.created_at || new Date()),
    }).where(and(
      eq(schema.spaceMembers.space_id, engineering!.id),
      eq(schema.spaceMembers.user_id, rahul!.id),
    ));
  }

  console.log('Set read positions for other users');

  console.log('\nSeed complete!');
  console.log('Login credentials:');
  console.log('  maneek@test.com / test1234 (owner)');
  console.log('  rahul@test.com  / test1234 (member)');
  console.log('  priya@test.com  / test1234 (member)');
  console.log('  arjun@test.com  / test1234 (member)');
  console.log('  sara@test.com   / test1234 (member)');
  console.log('Projects: Deft v1 (DEFT), Design System (DS)');

  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
