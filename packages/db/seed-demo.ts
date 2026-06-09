/**
 * Demo seeder — wipes the database and inserts the "Testers Tomatoes" workspace
 * (1 manager + 5 employees, rich chat/task history, notes, a wiki knowledge
 * graph, cross-references, plus an encrypted per-org OpenAI key on orgs.ai_config
 * when SEED_OPENAI_KEY is set).
 *
 * Credentials — password is tomato123 for every user:
 *   diego@testers-tomatoes.com     (owner, Farm Manager)
 *   marigold@testers-tomatoes.com  (admin, Head Grower)
 *   cesar@testers-tomatoes.com     (member, Field Supervisor)
 *   lina@testers-tomatoes.com      (member, Sales Lead)
 *   tomas@testers-tomatoes.com     (member, Logistics)
 *   sage@testers-tomatoes.com      (member, QC + Food Safety)
 *
 * DO NOT run this in production — it deletes EVERY user, org, message, and task.
 * Reserved for `pnpm dev` workflows and demo deploys. CI tests use
 * apps/api/src/scripts/seed-test-org.ts (separate fixture pipeline).
 *
 * Bundled skills / task templates / employee templates live in `@deft/api` and
 * are NOT re-seeded here — `pnpm db:seed:demo` chains
 * `pnpm --filter @deft/api exec tsx src/scripts/seed-platform-bundles.ts` after
 * this script. Defty (the built-in agent user) is re-created inline below since
 * we insert users via raw SQL rather than the signup API.
 *
 * Optional env:
 *   SEED_OPENAI_KEY  — when set, encrypted via AES-256-GCM (keyed off
 *                      ENCRYPTION_KEY) and stored on orgs.ai_config.api_keys.openai.
 *                      All four LLM-task slots (classify/summarize/reason/extract)
 *                      are routed to OpenAI when set.
 */
import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and, asc } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import * as schema from './src/schema.js';

const { Pool } = pg;

const OPENAI_KEY = process.env.SEED_OPENAI_KEY || '';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';

if (!OPENAI_KEY) console.log('[seed-demo] SEED_OPENAI_KEY not set — workspace will boot without OpenAI configured');
if (OPENAI_KEY && !ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY env required to encrypt the OpenAI key');

function encrypt(text: string): string {
  const key = scryptSync(ENCRYPTION_KEY, 'deft-salt', 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + tag + ':' + encrypted;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? 'postgres'}@localhost:5432/deft`,
});
const db = drizzle(pool, { schema });

async function seed() {
  console.log('Seeding Testers Tomatoes demo workspace…');

  // ── Wipe existing data in reverse dependency order ──
  // The list mirrors the table relationships in schema.ts. Adding wipe entries
  // here is required whenever a new seeded table is added below, otherwise a
  // re-run hits a unique-constraint violation on the second pass.
  await db.delete(schema.burnoutAlerts);
  await db.delete(schema.oneonePreps);
  await db.delete(schema.teamHealthSnapshots);
  await db.delete(schema.peopleRelationships);
  await db.delete(schema.peoplePatterns);
  await db.delete(schema.peopleInfluence);
  await db.delete(schema.peopleExpertise);
  await db.delete(schema.peopleInteractions);
  await db.delete(schema.managerSettings);
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
  await db.delete(schema.wikiLinks);
  await db.delete(schema.wikiPages);
  await db.delete(schema.entityTags);
  await db.delete(schema.tags);
  await db.delete(schema.notes);
  await db.delete(schema.taskWatchers);
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
  await db.delete(schema.triggers);
  await db.delete(schema.skills);
  await db.delete(schema.tools);
  await db.delete(schema.labels);
  await db.delete(schema.events);
  await db.delete(schema.connectedAccounts);
  await db.delete(schema.orgs);
  await db.delete(schema.users);

  console.log('Wiped existing data');

  // ── Users (1 manager + 5 employees) — all share password tomato123 ──
  const pw = await bcrypt.hash('tomato123', 12);

  const [diego] = await db.insert(schema.users).values({
    name: 'Diego Vargas', email: 'diego@testers-tomatoes.com',
    password_hash: pw, email_verified: true,
    title: 'Founder & Farm Manager', timezone: 'America/Los_Angeles',
    status_emoji: '🍅', status_text: 'Walking the south field — pings will be slow',
  }).returning();

  const [marigold] = await db.insert(schema.users).values({
    name: 'Marigold Patel', email: 'marigold@testers-tomatoes.com',
    password_hash: pw, email_verified: true,
    title: 'Head Grower (Greenhouse)', timezone: 'America/Los_Angeles',
    status_emoji: '🌱', status_text: 'In Greenhouse 2 — high humidity day',
  }).returning();

  const [cesar] = await db.insert(schema.users).values({
    name: 'Cesar Okafor', email: 'cesar@testers-tomatoes.com',
    password_hash: pw, email_verified: true,
    title: 'Field Supervisor', timezone: 'America/Los_Angeles',
  }).returning();

  const [lina] = await db.insert(schema.users).values({
    name: 'Lina Bhattacharya', email: 'lina@testers-tomatoes.com',
    password_hash: pw, email_verified: true,
    title: 'Sales & Wholesale Lead', timezone: 'America/Los_Angeles',
    status_emoji: '📞', status_text: 'On a call with Sunbelt Produce',
  }).returning();

  const [tomas] = await db.insert(schema.users).values({
    name: 'Tomás Wakefield', email: 'tomas@testers-tomatoes.com',
    password_hash: pw, email_verified: true,
    title: 'Logistics & Distribution', timezone: 'America/Los_Angeles',
  }).returning();

  const [sage] = await db.insert(schema.users).values({
    name: 'Sage Nakamura', email: 'sage@testers-tomatoes.com',
    password_hash: pw, email_verified: true,
    title: 'QC & Food Safety', timezone: 'America/Los_Angeles',
  }).returning();

  console.log('Created 6 users');

  // ── Org with optional OpenAI BYOK ──
  const aiConfig: Record<string, unknown> = {};
  if (OPENAI_KEY) {
    aiConfig.api_keys = { openai: encrypt(OPENAI_KEY) };
    aiConfig.ai_models = {
      classify: { provider: 'openai', model: 'gpt-4o-mini' },
      summarize: { provider: 'openai', model: 'gpt-4o-mini' },
      reason: { provider: 'openai', model: 'gpt-4o' },
      extract: { provider: 'openai', model: 'gpt-4o-mini' },
    };
  }

  const [org] = await db.insert(schema.orgs).values({
    name: 'Testers Tomatoes', slug: 'testers-tomatoes',
    timezone: 'America/Los_Angeles', trust_level: 'standard',
    ai_config: aiConfig,
  }).returning();

  await db.insert(schema.orgMembers).values([
    { org_id: org!.id, user_id: diego!.id, role: 'owner' },
    { org_id: org!.id, user_id: marigold!.id, role: 'admin' },
    { org_id: org!.id, user_id: cesar!.id, role: 'member' },
    { org_id: org!.id, user_id: lina!.id, role: 'member' },
    { org_id: org!.id, user_id: tomas!.id, role: 'member' },
    { org_id: org!.id, user_id: sage!.id, role: 'member' },
  ]);

  // ── Defty (built-in agent) ──
  // Replicates apps/api/src/lib/ensure-defty-membership.ts: (1) ensure the
  // Defty user row, (2) add him to org_members. The 1:1 DM spaces + welcome
  // messages are created further below alongside the other DM spaces.
  let [deftyUser] = await db.select({ id: schema.users.id })
    .from(schema.users).where(eq(schema.users.email, 'deft-agent@system.local')).limit(1);
  if (!deftyUser) {
    [deftyUser] = await db.insert(schema.users).values({
      email: 'deft-agent@system.local', name: 'Defty',
      kind: 'agent', is_agent: true, email_verified: true,
    }).returning({ id: schema.users.id });
  }
  await db.insert(schema.orgMembers).values({
    org_id: org!.id, user_id: deftyUser!.id, role: 'member',
  }).onConflictDoNothing();

  console.log('Created org: Testers Tomatoes');

  // ── Onboarding state ──
  await db.insert(schema.onboardingState).values([
    { user_id: diego!.id, org_created: true, profile_set: true, first_space_created: true, first_message_sent: true, first_task_created: true, completed: true },
    { user_id: marigold!.id, profile_set: true, first_message_sent: true, completed: true },
    { user_id: cesar!.id, profile_set: true, first_message_sent: true, completed: true },
    { user_id: lina!.id, profile_set: true, first_message_sent: true, completed: true },
    { user_id: tomas!.id, profile_set: true, first_message_sent: true, completed: false },
    { user_id: sage!.id, profile_set: true, first_message_sent: true, completed: true },
  ]);

  // ── Message helper (declared early so Defty welcomes can use baseTime too) ──
  const baseTime = new Date('2026-05-04T07:30:00-07:00'); // 3 weeks ago, Pacific morning
  let msgOffset = 0;
  function msgTime(stepMin = 2): Date {
    msgOffset += stepMin;
    return new Date(baseTime.getTime() + msgOffset * 60_000);
  }

  // ── Spaces ──
  const [general] = await db.insert(schema.spaces).values({
    org_id: org!.id, name: 'general', description: 'Farm-wide announcements and daily checkins',
    type: 'public', is_default: true, created_by: diego!.id,
  }).returning();

  const [greenhouse] = await db.insert(schema.spaces).values({
    org_id: org!.id, name: 'greenhouse', description: 'Climate, irrigation, pest control — Greenhouses 1, 2, 3',
    type: 'public', created_by: marigold!.id,
  }).returning();

  const [fieldOps] = await db.insert(schema.spaces).values({
    org_id: org!.id, name: 'field-ops', description: 'Outdoor crops, weather, soil',
    type: 'public', created_by: cesar!.id,
  }).returning();

  const [sales] = await db.insert(schema.spaces).values({
    org_id: org!.id, name: 'sales-and-buyers', description: 'Wholesale buyer pipeline, farmers market, pricing',
    type: 'public', created_by: lina!.id,
  }).returning();

  const [logistics] = await db.insert(schema.spaces).values({
    org_id: org!.id, name: 'logistics', description: 'Deliveries, refrigerated truck schedules, packing',
    type: 'public', created_by: tomas!.id,
  }).returning();

  const [harvest] = await db.insert(schema.spaces).values({
    org_id: org!.id, name: 'harvest-room', description: 'Picking schedules, sorting, packing crews',
    type: 'public', created_by: cesar!.id,
  }).returning();

  const [random] = await db.insert(schema.spaces).values({
    org_id: org!.id, name: 'random', description: 'Water cooler — bring your own coffee',
    type: 'public', created_by: diego!.id,
  }).returning();

  // 1:1 DMs between Diego and his closest reports
  const [dmDM] = await db.insert(schema.spaces).values({
    org_id: org!.id, name: 'Diego, Marigold', type: 'dm', created_by: diego!.id,
  }).returning();
  const [dmDL] = await db.insert(schema.spaces).values({
    org_id: org!.id, name: 'Diego, Lina', type: 'dm', created_by: diego!.id,
  }).returning();
  const [dmDS] = await db.insert(schema.spaces).values({
    org_id: org!.id, name: 'Diego, Sage', type: 'dm', created_by: diego!.id,
  }).returning();

  // Memberships — everyone in the public spaces, DMs only their pair
  const allHumans = [diego!, marigold!, cesar!, lina!, tomas!, sage!];
  for (const space of [general!, greenhouse!, fieldOps!, sales!, logistics!, harvest!, random!]) {
    await db.insert(schema.spaceMembers).values(
      allHumans.map((u) => ({ space_id: space.id, user_id: u.id }))
    );
  }
  await db.insert(schema.spaceMembers).values([
    { space_id: dmDM!.id, user_id: diego!.id }, { space_id: dmDM!.id, user_id: marigold!.id },
    { space_id: dmDL!.id, user_id: diego!.id }, { space_id: dmDL!.id, user_id: lina!.id },
    { space_id: dmDS!.id, user_id: diego!.id }, { space_id: dmDS!.id, user_id: sage!.id },
  ]);

  // ── Defty DMs (1:1 with each human) + personalized welcome messages ──
  // The sidebar (apps/web/src/components/sidebar.tsx) pins Defty's DM at the
  // top of the Direct Messages section.
  const deftyWelcomes: Record<string, string> = {
    [diego!.id]: "Hey Diego, I'm Defty — your workspace agent. I can read the whole workspace (chat, tasks, notes, wiki, cross-references) and answer questions, draft updates, or kick off work. Some things to try:\n\n• Ask me 'what's on my plate this week?' for a personalized digest.\n• Ask 'summarize the GH-3 build' and I'll synthesize across chat, tasks, and Marigold's BOM notes.\n• @mention me (@deft) in any channel to pull me into a thread.\n\nI ask before I do anything irreversible. Trust level here is 'standard' so I'll auto-execute light things (creating tasks, posting summaries) and ask for approval on bigger writes.",
    [marigold!.id]: "Hi Marigold — I'm Defty, the workspace agent. If you want quick answers across the greenhouse logs, the GH-3 plan, and the variety wiki without scrolling chat, ask me here.\n\nTry: 'what's the latest on the GH-2 humidity issue?' or 'what's still open on the GH-3 build?'",
    [cesar!.id]: "Hey Cesar — I'm Defty. I can pull harvest schedules, weather-related tasks, and the audit checklist into one place when you need a quick read.\n\nTry: 'what's the hail prep status?' or 'list this week's harvest tasks ordered by day.'",
    [lina!.id]: "Hi Lina — Defty here. Best use of me on your side: buyer-pipeline rollups, contract status, and pulling notes + chat history when you're prepping for a buyer call.\n\nTry: 'what's outstanding on the Sunbelt contract?' or 'pull everything we have on Asha Mehta / Field Co-op for Friday.'",
    [tomas!.id]: "Hey Tomás — Defty. I can pull the delivery rotation, cold-chain incidents, and any open logistics tasks into a single view. Good for morning planning.\n\nTry: 'what's on the truck rotation this week?' or 'remind me of the cold-chain spec for Sunbelt.'",
    [sage!.id]: "Hi Sage — Defty here. For the GAP audit, I can pull the checklist, recent compliance issues from chat, and the open audit tasks into one summary.\n\nTry: 'what's the audit dry-run agenda?' or 'find anything in chat about handwashing compliance from the last 30 days.'",
  };
  const welcomeTime = new Date(baseTime.getTime() - 2 * 86400_000);
  for (const human of allHumans) {
    const [dmSpace] = await db.insert(schema.spaces).values({
      org_id: org!.id, name: `${human.name}, Defty`, type: 'dm', created_by: human.id,
    }).returning();
    await db.insert(schema.spaceMembers).values([
      { space_id: dmSpace!.id, user_id: human.id },
      { space_id: dmSpace!.id, user_id: deftyUser!.id },
    ]);
    await db.insert(schema.messages).values({
      org_id: org!.id, space_id: dmSpace!.id, user_id: deftyUser!.id,
      content: deftyWelcomes[human.id]!, created_at: welcomeTime,
    });
  }

  console.log('Created 16 spaces (10 + 6 Defty DMs) with Defty welcome messages');

  async function msg(spaceId: string, userId: string, content: string, opts: { parent_id?: string; stepMin?: number } = {}) {
    const [m] = await db.insert(schema.messages).values({
      org_id: org!.id, space_id: spaceId, user_id: userId,
      content, parent_id: opts.parent_id, created_at: msgTime(opts.stepMin ?? 2),
    }).returning();
    return m!;
  }

  const D = diego!.id, M = marigold!.id, C = cesar!.id, L = lina!.id, T = tomas!.id, Sg = sage!.id;

  // ── #general — daily standup vibes ──
  const gen1 = await msg(general!.id, D, "Morning team. The Sun Gold trial in GH-2 is looking really strong — we're picking the first cluster Thursday. Cesar's crew is on the south field rotation today (Romas + San Marzanos). Lina, you've got the Sunbelt call at 11.");
  await msg(general!.id, M, "Sun Gold trusses are heavier than last year by maybe 15%. Going to need extra clips before Thursday or they'll snap.");
  await msg(general!.id, C, "South field is at 78°F by 8am, projecting 91°F peak. Heat-stress watch is on. I'm pushing the noon irrigation up by 90 min.");
  await msg(general!.id, L, "Sunbelt wants to lock in a 6-week supply contract for slicers. Asking 1,200 lbs/week. Need to confirm we can hit that with the Beefsteak block before I commit.");
  await msg(general!.id, D, "Marigold, can you walk Lina through the Beefsteak yield projection after she's off the call? Pretty sure we're at 1,400/wk peak but want to be honest with Sunbelt about ramp.");
  await msg(general!.id, M, "Yep, I'll meet her in the office at noon. I have the truss counts from Monday.");
  await msg(general!.id, Sg, "Reminder: USDA-GAP audit is on June 18th. I'm running the dry-run audit next Tuesday — please don't argue with me about washing logs, just sign them. 🙏");
  await msg(general!.id, T, "Cold truck is back from servicing. Compressor was leaking — that explains why the Tuesday delivery to Green Leaf was warmer than spec. Logging it in the QC system.");
  await msg(general!.id, D, "Good. We owe Green Leaf a credit note for that batch — Lina, can you handle it after Sunbelt?");
  await msg(general!.id, L, "On it. I'll draft the credit memo this afternoon.");

  // ── #greenhouse — operational detail ──
  msgOffset += 30;
  const gh1 = await msg(greenhouse!.id, M, "GH-2 climate log overnight: humidity peaked at 84% at 4am. That's the third time this week. The dehumidifier on the north wall is undersized for the late-spring load.");
  const gh2 = await msg(greenhouse!.id, M, "If we don't fix this before peak fruit set on the Cherokee Purples, we're going to see early blight. Saw a few suspicious leaves on Row 7 yesterday.");
  await msg(greenhouse!.id, D, "Order a second unit. Pull from the GH-3 build budget if you have to — better to fight blight now than lose a block later.");
  await msg(greenhouse!.id, M, "Already on Grainger. 18,000 BTU portable unit, $1,840, ships tomorrow.");
  await msg(greenhouse!.id, Sg, "If we do get blight, the protocol is in the playbook — copper octanoate (OMRI listed) for the organic block, mancozeb for conventional. Don't mix them up.");
  await msg(greenhouse!.id, M, "Got it. Marking Row 7 with a flag in the morning so the picking crew avoids it until I confirm.");
  await msg(greenhouse!.id, M, "Side topic — Sun Gold drip emitters on Row 4 are clogging. Hard water deposits. Going to flush with citric acid this weekend.", { stepMin: 60 });
  await msg(greenhouse!.id, C, "Want to share the flush procedure with the field team? Our T-tape lines have the same problem in late summer.");
  const gh9 = await msg(greenhouse!.id, M, "Yeah, I'll write it up in the irrigation wiki. 1% citric solution, 30-min soak, flush with clean water. Works on emitters AND T-tape.");

  // ── #field-ops ──
  msgOffset += 25;
  const fo1 = await msg(fieldOps!.id, C, "Weather alert: hail risk Tuesday-Wednesday next week per NOAA. 30% chance, 1/2 inch stones. The Romas in the south field are fruiting — we lose anything bigger than a marble if hail hits.");
  await msg(fieldOps!.id, D, "What's the cost of putting hail netting on the south block?");
  await msg(fieldOps!.id, C, "I called Eastern Ag last fall — about $4,800 per acre installed, leases for one season. South block is 1.8 acres so $8,640. We made $38k off that block last year so it's not crazy if we lose half the crop.");
  await msg(fieldOps!.id, D, "Do it. Better insurance than insurance.");
  await msg(fieldOps!.id, C, "Calling them now. Install needs to happen Monday, no later.");
  await msg(fieldOps!.id, M, "While we're on weather — the hoop houses on the east edge are still vented for the heat. We should be ready to close them down fast if temps drop on Wednesday.");
  await msg(fieldOps!.id, C, "Tomás, can you stage the side panels by the hoop houses Monday afternoon? Two people can close them in 30 min if we don't have to chase down materials.");
  await msg(fieldOps!.id, T, "Done. I'll drop them off when I'm out there for the harvest pickup.");

  // ── #sales-and-buyers ──
  msgOffset += 40;
  const s1 = await msg(sales!.id, L, "Sunbelt Produce call recap: They want 1,200 lbs/wk of Beefsteak slicers for 6 weeks starting May 26. Price: $1.85/lb FOB. They'll commit to a fixed quantity (not min/max). Decision needed by Friday.");
  await msg(sales!.id, D, "How does $1.85 compare to last year's contract price?");
  await msg(sales!.id, L, "Last year was $1.62. So 14% higher. They flinched but didn't push back hard. I think we could've held $2.00 but I didn't want to risk it on the first contract of the season.");
  await msg(sales!.id, D, "Good read. Lock it in if Marigold confirms supply. The pricing-strategy doc I want to update — let's hold $2.00 as our anchor next year now that we've shown we can deliver.");
  await msg(sales!.id, L, "Will do. I'll also send Sunbelt the cold-chain spec — they were asking about delivery temp range.");
  await msg(sales!.id, T, "Our spec is 50-55°F. We pulp-temp every load before it leaves the cooler. Receipts in the QC log.");
  await msg(sales!.id, L, "Switching topics — farmers market on Saturday is forecast 88°F. The Cherokee Purples don't hold up in heat. I'm shifting display to the Sun Golds, Romas, and slicers.");
  await msg(sales!.id, L, "Also — the new buyer at Field Co-op (Asha Mehta) is coming to the farm Friday for a walk-through. I'd like the Cherokee Purple block to be at peak when she sees it. Marigold, what does your truss count say?");
  await msg(sales!.id, M, "Cherokee Purple peak fruit-set is right now. She'll see the prettiest block we've had in 3 years if the dehumidifier issue doesn't trigger blight. Bring her at 10am — light is best then.");

  // ── #logistics ──
  msgOffset += 30;
  const lg1 = await msg(logistics!.id, T, "Truck rotation for next week:\n- Mon 6am: harvest → cold storage (in-house)\n- Tue 4am: cold storage → Sunbelt DC (Fresno, 3.5hr)\n- Wed 4am: cold storage → Green Leaf (LA, 5hr)\n- Thu 5am: cold storage → Field Co-op trial run (2 pallets, sample order)\n- Sat 5am: farmers market load");
  await msg(logistics!.id, T, "Need a second driver for Wed — Green Leaf wants the 5hr trip AND the return same day. Diego, you OK to drive the empty back if I take the load out?");
  await msg(logistics!.id, D, "Yeah, I can do the return. Send me the pickup window.");
  await msg(logistics!.id, T, "Loading window: 4am-5am. Departure target 5am sharp. Arrival 10am LA. Unload 10-11. I'll be home by 4pm.");
  await msg(logistics!.id, Sg, "Pulp temps for the Tuesday Sunbelt load — make sure they're logged before AND after the trip. Sunbelt requires the printout. Last time we lost track and they took 30 min at the dock to verify.");
  await msg(logistics!.id, T, "Already on it. New logger arrives Friday — it does both pre and post readings to one PDF.");

  // ── #harvest-room ──
  msgOffset += 25;
  const hr1 = await msg(harvest!.id, C, "Harvest plan for the week:\n- Mon: Romas south field, full crew (6 people, 6am-12pm)\n- Tue: San Marzanos middle field, half crew (3 people)\n- Thu: Sun Gold first pull, GH-2, Marigold leads\n- Fri: Cherokee Purple selective pick for the Field Co-op visit");
  await msg(harvest!.id, C, "Romas: target firmness is 'breaker-plus' for the Sunbelt load. Anything that's already red goes to the farmers market bin. Sage will spot-check.");
  await msg(harvest!.id, Sg, "Reminder: nobody picks without washed hands and clean clippers. There's a sign at the entrance. I will absolutely walk you out and back if I see otherwise.");
  await msg(harvest!.id, M, "Sun Gold pull on Thursday — single layer in the 25-lb totes, NOT the regular 40s. They bruise if they're stacked.");
  await msg(harvest!.id, T, "I'll have 60 of the 25-lb totes washed and stacked at the harvest room by Wednesday EOD.");
  await msg(harvest!.id, C, "Friday pick for Field Co-op visit: leave the prettiest Cherokee Purple cluster on Row 12 — that's the one we'll show Asha. DO NOT PICK ROW 12 UNTIL AFTER 11AM.");

  // ── #random ──
  msgOffset += 30;
  await msg(random!.id, T, "Anyone else's farmers market table getting hit hard by the heat? I'm thinking we need a second pop-up for shade this weekend.");
  await msg(random!.id, L, "Yes. Last Saturday I lost two flats of Cherokee Purples to sun damage by 11am. I'll order a second 10x10 — REI has them on sale.");
  await msg(random!.id, M, "Random fact: the word 'tomato' comes from the Nahuatl 'tomatl' which literally means 'plump thing'. Just learned this from a podcast. 🍅");
  await msg(random!.id, D, "Plump Thing Industries. Our new company name.");
  await msg(random!.id, C, "Branding it.");
  await msg(random!.id, Sg, "My audit checklist now reads 'Plump Thing storage protocol'. You're welcome.");
  await msg(random!.id, T, "Lunch run to Manuel's tomorrow. Carne asada or al pastor? Going to do a batch order.");
  await msg(random!.id, L, "Al pastor. Always al pastor.");
  await msg(random!.id, M, "Vegetarian for me. Extra guacamole.");

  // ── DM Diego ↔ Marigold ──
  msgOffset += 30;
  await msg(dmDM!.id, D, "Hey, I've been thinking about GH-3. We've been treating it like 'just another greenhouse' but if we set it up for the heritage varieties specifically, we could double our farmers market premium.");
  await msg(dmDM!.id, M, "I agree. The Brandywines and Cherokee Purples sell for $6.50/lb retail vs $2.50 for the conventional slicers. If GH-3 is heritage-only we can run a tighter climate program (lower humidity, higher airflow) that's specifically what those varieties need.");
  await msg(dmDM!.id, D, "Let's make GH-3 a heritage-only build. Update the GH-3 project plan when you have a chance — different climate sensors, different irrigation zoning.");
  await msg(dmDM!.id, M, "Will do. Going to need a higher-capacity dehumidifier baseline (now that I'm thinking about it, the GH-2 issue is a foreshadowing) and a separate ferti-station because the heritages get a different feed schedule.");
  await msg(dmDM!.id, D, "Budget's not infinite but I want this to be done right. Send me the revised BOM and we'll figure it out.");

  // ── DM Diego ↔ Lina ──
  msgOffset += 20;
  await msg(dmDL!.id, D, "Confidential — I've been talking to Whole Foods Pacific Northwest about a regional supply slot. They want a year-round program, not seasonal. Means we'd need GH-3 producing by January 2027 at the latest.");
  await msg(dmDL!.id, L, "Whoa. That's a big leap. What volume are they talking?");
  await msg(dmDL!.id, D, "Initial: 800-1000 lbs/wk across 4 SKUs (Roma, Beefsteak, heritage mix, cherry mix). Could grow to 2,500/wk by year 2.");
  await msg(dmDL!.id, L, "That would 4x our wholesale revenue. But it also means we can't lose them — one missed week is contract-killing with Whole Foods.");
  await msg(dmDL!.id, D, "Exactly. I don't want to commit until GH-3 is online AND we've had a clean 6-month run with Sunbelt and Field Co-op. Let's plan to revisit in October.");
  await msg(dmDL!.id, L, "Got it. Keeping this off the public channels for now. I'll start building the cost model — what wholesale margins look like with a national chain vs. our regional buyers.");

  // ── DM Diego ↔ Sage ──
  msgOffset += 20;
  await msg(dmDS!.id, Sg, "About the GAP audit dry-run. I want to flag now — our handwashing log compliance has been spotty. Random spot-checks: 60% sign-in rate at the harvest room sink.");
  await msg(dmDS!.id, D, "That's an audit-failure level. What's driving it?");
  await msg(dmDS!.id, Sg, "Crews show up at 6am and want to start picking. Sign-in feels like friction. I think we need (1) a physical sign-in stand at the entrance with a clipboard literally blocking the path, and (2) Cesar enforcing it as part of the morning huddle.");
  await msg(dmDS!.id, D, "Do both. I'll back you on this if there's friction. Failing GAP costs us Sunbelt AND Field Co-op — neither of them will buy without certification.");
  await msg(dmDS!.id, Sg, "Thanks. I'll have the new station set up by Monday. Also — the audit covers more than handwashing. Pesticide application records, water testing, traceability. I'm building a checklist this weekend and would like an hour with you next week to walk through.");
  await msg(dmDS!.id, D, "Tuesday 2pm. Block it on my calendar.");

  console.log('Created messages across 10 spaces');

  // ── Reactions ──
  const reactions = [
    [gen1.id, M, '🍅'], [gen1.id, L, '👍'], [gen1.id, C, '☀️'],
    [gh1.id, D, '👀'], [gh1.id, Sg, '🚨'],
    [gh2.id, D, '🚨'],
    [gh9.id, C, '🙏'],
    [fo1.id, D, '⚠️'], [fo1.id, M, '⚠️'], [fo1.id, T, '😬'],
    [s1.id, D, '💰'], [s1.id, M, '🔥'],
    [lg1.id, D, '👍'], [lg1.id, Sg, '📋'],
    [hr1.id, M, '✅'], [hr1.id, L, '👍'],
  ] as const;
  for (const [mid, uid, emoji] of reactions) {
    await db.insert(schema.reactions).values({ message_id: mid, user_id: uid, emoji }).catch(() => {});
  }

  // ── Pin key messages ──
  await db.insert(schema.pinnedMessages).values([
    { message_id: gh1.id, space_id: greenhouse!.id, pinned_by: M },
    { message_id: fo1.id, space_id: fieldOps!.id, pinned_by: C },
    { message_id: s1.id, space_id: sales!.id, pinned_by: L },
    { message_id: lg1.id, space_id: logistics!.id, pinned_by: T },
    { message_id: hr1.id, space_id: harvest!.id, pinned_by: C },
  ]);

  // ── Thread replies on a key message ──
  msgOffset += 5;
  await msg(greenhouse!.id, D, "Quick clarifying question — is Row 7 a Cherokee Purple block or a Brandywine block? Want to flag the right variety in the audit log.", { parent_id: gh2.id });
  await msg(greenhouse!.id, M, "Cherokee Purple. Brandywines are in Row 11-13.", { parent_id: gh2.id });
  await msg(greenhouse!.id, Sg, "Logging both rows for inspection just to be safe. Will visit tomorrow morning.", { parent_id: gh2.id });

  await msg(fieldOps!.id, M, "We've never had hail this late in May. Is the netting reusable for next year or single-season?", { parent_id: fo1.id });
  await msg(fieldOps!.id, C, "Single season lease but Eastern Ag will swap it for next year if we commit early. I'll add a recurring task for January.", { parent_id: fo1.id });

  console.log('Added reactions, pins, threads');

  // ── Projects ──
  const [projHarv] = await db.insert(schema.projects).values({
    org_id: org!.id, name: 'Spring 2026 Harvest', description: 'Picking, packing, and delivery operations for the May-July harvest window.',
    prefix: 'HARV', icon: '🍅', color: '#E03A2F', lead_id: cesar!.id, task_counter: 12,
  }).returning();

  const [projWhl] = await db.insert(schema.projects).values({
    org_id: org!.id, name: 'Wholesale Expansion', description: 'New buyer pipeline, contracts, pricing strategy.',
    prefix: 'WHL', icon: '🤝', color: '#3B82F6', lead_id: lina!.id, task_counter: 10,
  }).returning();

  const [projGh3] = await db.insert(schema.projects).values({
    org_id: org!.id, name: 'Greenhouse 3 Build-out', description: 'New heritage-variety greenhouse — climate, irrigation, build schedule.',
    prefix: 'GH3', icon: '🏗️', color: '#0EA5E9', lead_id: marigold!.id, task_counter: 8,
  }).returning();

  await db.insert(schema.projectSpaces).values([
    { project_id: projHarv!.id, space_id: harvest!.id },
    { project_id: projHarv!.id, space_id: fieldOps!.id },
    { project_id: projWhl!.id, space_id: sales!.id },
    { project_id: projGh3!.id, space_id: greenhouse!.id },
  ]);

  console.log('Created 3 projects');

  // ── Tasks ──
  type TaskDef = { num: number; title: string; desc: string; status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled'; priority: 'p0' | 'p1' | 'p2' | 'p3'; assignee: string | null; creator: string; due?: 'overdue' | 'tomorrow' | 'this_week' | 'next_week' | 'done'; metadata?: Record<string, unknown> };

  const harvTasks: TaskDef[] = [
    { num: 1, title: 'Install hail netting on south field (Romas)', desc: 'Eastern Ag — 1.8 acres, $4,800/acre installed, lease for the season. Install Monday before NOAA hail window opens Tuesday.', status: 'in_progress', priority: 'p0', assignee: C, creator: D, due: 'tomorrow' },
    { num: 2, title: 'Roma harvest — south field, breaker-plus firmness', desc: 'Mon 6am-12pm, full crew (6). Target: 1,400 lbs into the Sunbelt cooler bins. Anything already red goes to farmers market bins. Sage spot-checks firmness every hour.', status: 'todo', priority: 'p1', assignee: C, creator: D, due: 'this_week' },
    { num: 3, title: 'San Marzano harvest — middle field', desc: 'Tue, half crew. These are going to the heritage box mix at the farmers market. Pick at full red, careful handling.', status: 'todo', priority: 'p1', assignee: C, creator: D, due: 'this_week' },
    { num: 4, title: 'Sun Gold first pull — GH-2', desc: 'Thursday. Marigold leads. 25-lb totes only — they bruise in 40s. Target 80 lbs for the Saturday farmers market display.', status: 'todo', priority: 'p1', assignee: M, creator: D, due: 'this_week' },
    { num: 5, title: 'Cherokee Purple selective pick — Field Co-op visit', desc: 'Friday afternoon. DO NOT pick Row 12 until after the 10am walkthrough with Asha Mehta. Then selective pick of mature clusters for the sample box.', status: 'todo', priority: 'p1', assignee: C, creator: L, due: 'this_week' },
    { num: 6, title: 'Sunbelt Tuesday delivery — pulp temp protocol', desc: 'Pre- and post-trip pulp temps logged on the new dual-PDF logger. Drop at Sunbelt Fresno DC by 8am. Print the PDF for their receiving team.', status: 'todo', priority: 'p0', assignee: T, creator: D, due: 'this_week' },
    { num: 7, title: 'Hand-washing sign-in station — harvest room entrance', desc: 'Physical clipboard stand that blocks the entrance path. Mandatory sign-in before any picking. Cesar enforces in the morning huddle. Drives the audit compliance from 60% to 100%.', status: 'in_progress', priority: 'p0', assignee: Sg, creator: D, due: 'tomorrow' },
    { num: 8, title: 'Order 60 25-lb totes — washed and stacked at harvest room', desc: 'For the Sun Gold pull Thursday. Tomás handles. Stage by Wednesday EOD.', status: 'in_progress', priority: 'p2', assignee: T, creator: M, due: 'this_week' },
    { num: 9, title: 'Credit memo — Green Leaf warm-batch from cold truck failure', desc: 'Compressor leak on the cold truck made the Tuesday Green Leaf delivery warmer than the 50-55°F spec. Draft the credit memo and send to their AP team.', status: 'todo', priority: 'p2', assignee: L, creator: D, due: 'tomorrow' },
    { num: 10, title: 'Stage hoop house side panels for fast deployment', desc: 'Tomás drops panels by the east hoop houses Monday afternoon. Two-person closure in 30 min if Wednesday temps drop.', status: 'todo', priority: 'p2', assignee: T, creator: C, due: 'tomorrow' },
    { num: 11, title: 'Saturday farmers market — heat-resilient variety shift', desc: 'Forecast 88°F. Display: Sun Golds, Romas, slicers. Skip the Cherokee Purples and Brandywines (heat-damaged by 11am). Order second 10x10 pop-up shade.', status: 'todo', priority: 'p2', assignee: L, creator: L, due: 'this_week' },
    { num: 12, title: 'Cold storage protocol audit — pre-GAP dry-run', desc: 'Walk-through with Sage Tuesday 2pm. Pesticide records, water testing, traceability. Build the dry-run checklist this weekend.', status: 'in_progress', priority: 'p1', assignee: Sg, creator: D, due: 'this_week' },
  ];

  const whlTasks: TaskDef[] = [
    { num: 1, title: 'Sunbelt 6-week contract — sign and return', desc: 'Beefsteak slicers, 1,200 lbs/wk, $1.85/lb FOB, starts May 26. Confirm with Marigold on supply ramp. Decision needed by Friday.', status: 'in_review', priority: 'p0', assignee: L, creator: D, due: 'this_week' },
    { num: 2, title: 'Field Co-op walk-through — Asha Mehta Friday 10am', desc: 'Tour: GH-2 Sun Gold, GH-2 Cherokee Purple, south field Roma block, harvest room. Sample box of heritage varieties + slicers. Pricing sheet for wholesale (heritage premium tier).', status: 'in_progress', priority: 'p1', assignee: L, creator: L, due: 'this_week' },
    { num: 3, title: 'Update 2027 pricing anchor — $2.00/lb slicers', desc: 'Sunbelt accepted $1.85 with little pushback. Hold $2.00 as the anchor next year. Update wholesale pricing sheet wiki. Note in cell: "validated 2026 with Sunbelt at $1.85".', status: 'todo', priority: 'p2', assignee: L, creator: D, due: 'next_week' },
    {
      num: 4,
      title: 'Whole Foods PNW — feasibility cost model (confidential)',
      desc: 'Year-round program, 800-1000 lbs/wk across 4 SKUs. Revisit in October once GH-3 status is clear and we have a clean 6-month run with regional buyers.',
      status: 'backlog',
      priority: 'p1',
      assignee: L,
      creator: D,
      metadata: { visibility: 'restricted', visible_user_ids: [D, L] },
    },
    { num: 5, title: 'Set up Sunbelt cold-chain spec — formal handoff doc', desc: 'Document our pulp-temp logging procedure, refrigeration spec (50-55°F), and dock receiving protocol. Share with Sunbelt receiving team.', status: 'in_progress', priority: 'p2', assignee: T, creator: L, due: 'this_week' },
    { num: 6, title: 'New buyer outreach — North Bay restaurant group', desc: 'A chef collective in Sonoma is looking for heritage tomatoes for a tasting menu. Lina to reach out, target 200 lbs/wk Cherokee Purples + Brandywines.', status: 'backlog', priority: 'p3', assignee: L, creator: L },
    { num: 7, title: 'Farmers market — heritage education signage', desc: 'Customers are asking about the varieties. Print A4 cards with variety name, flavor notes, best-use suggestions. Display next to each crate.', status: 'todo', priority: 'p3', assignee: L, creator: L, due: 'next_week' },
    { num: 8, title: 'Wholesale pricing sheet — heritage premium tier', desc: 'Document the +60% premium on Cherokee Purple, Brandywine, San Marzano vs slicers. Justify with retail comp ($6.50/lb vs $2.50/lb).', status: 'in_review', priority: 'p2', assignee: L, creator: D, due: 'this_week' },
    { num: 9, title: 'Quarterly buyer report — Q1 2026 retrospective', desc: 'Pounds delivered, on-time rate, credit memos, buyer satisfaction. Share with Diego before May 30. Drives 2027 planning.', status: 'done', priority: 'p2', assignee: L, creator: D, due: 'done' },
    { num: 10, title: 'CRM cleanup — buyer contacts current', desc: 'Old contact at Green Leaf left, new one is Mira Diaz (production planning). Update across all our sheets and the buyer directory wiki.', status: 'done', priority: 'p3', assignee: L, creator: L, due: 'done' },
  ];

  const gh3Tasks: TaskDef[] = [
    { num: 1, title: 'GH-3 BOM revision — heritage-only build', desc: 'Pivot from "general" GH-3 to heritage-focused: tighter humidity control (separate dehumidifier from day 1), zoned irrigation, separate ferti-station. Marigold drafts revised BOM.', status: 'in_progress', priority: 'p0', assignee: M, creator: D, due: 'this_week' },
    { num: 2, title: 'Climate control vendor RFQ — 3 quotes', desc: 'Wadsworth, AgriTomato, GreenTec. Spec: 40,000 sqft footprint, target 65-70%RH year-round, dual-zone temp. Want quotes by June 10.', status: 'todo', priority: 'p1', assignee: M, creator: M, due: 'next_week' },
    { num: 3, title: 'Soil prep contractor — broadfork + compost amendment', desc: 'Heritage varieties want deeper soil structure than the conventional block. Looking at Madsen Farms — they do compost amendment passes for $1,200/quarter-acre.', status: 'todo', priority: 'p2', assignee: M, creator: M, due: 'next_week' },
    { num: 4, title: 'GH-3 plumbing rough-in — schedule with Castro Bros', desc: 'Castro Bros has us tentatively in the calendar for July 8-15. Confirm by June 15 or they release the slot.', status: 'todo', priority: 'p1', assignee: M, creator: M, due: 'next_week' },
    { num: 5, title: 'Seed selection — heritage starter list', desc: 'Brandywine (Sudduth strain), Cherokee Purple, Aunt Ruby\'s German Green, Black Krim, Mortgage Lifter, Green Zebra. Source from Baker Creek + Johnny\'s. Order by June 1 for August seeding.', status: 'in_progress', priority: 'p1', assignee: M, creator: M, due: 'this_week' },
    { num: 6, title: 'Construction permit — county inspector follow-up', desc: 'Submitted April 1, expecting approval by mid-June. Have not heard back — call the inspector\'s office this week. Diego needs to be the point of contact (he\'s on the permit).', status: 'in_progress', priority: 'p1', assignee: D, creator: M, due: 'this_week' },
    { num: 7, title: 'Dehumidifier upsize learnings — apply to GH-3 design', desc: 'GH-2 dehumidifier failure at peak load is informing the GH-3 spec. Document the BTU/sqft ratio we landed on and bake it into the GH-3 climate spec.', status: 'in_progress', priority: 'p2', assignee: M, creator: M, due: 'next_week' },
    { num: 8, title: 'Initial GH-3 budget — submitted to Diego for approval', desc: 'Revised estimate after heritage-only pivot: $187,400 total (was $158,200). Diego to review and approve before BOM is locked.', status: 'done', priority: 'p1', assignee: M, creator: M, due: 'done' },
  ];

  const taskIds: Record<string, string> = {};
  const now = new Date();
  const dueMap = {
    overdue: new Date(now.getTime() - 2 * 86400_000),
    tomorrow: new Date(now.getTime() + 1 * 86400_000),
    this_week: new Date(now.getTime() + 4 * 86400_000),
    next_week: new Date(now.getTime() + 9 * 86400_000),
    done: new Date(now.getTime() - 14 * 86400_000),
  };

  async function insertTasks(project: typeof projHarv, defs: TaskDef[], keyPrefix: string) {
    for (const t of defs) {
      const [task] = await db.insert(schema.tasks).values({
        org_id: org!.id, project_id: project!.id, number: t.num, title: t.title, description: t.desc,
        status: t.status, priority: t.priority, assignee_id: t.assignee, created_by: t.creator,
        sort_order: t.num, due_date: t.due ? dueMap[t.due] : undefined, metadata: t.metadata,
      }).returning();
      taskIds[`${keyPrefix}${t.num}`] = task!.id;
    }
  }
  await insertTasks(projHarv, harvTasks, 'HARV');
  await insertTasks(projWhl, whlTasks, 'WHL');
  await insertTasks(projGh3, gh3Tasks, 'GH3');

  console.log('Created 30 tasks');

  // ── Labels ──
  const [urgentLbl] = await db.insert(schema.labels).values({ org_id: org!.id, name: 'urgent', color: '#dc2626' }).returning();
  const [audit] = await db.insert(schema.labels).values({ org_id: org!.id, name: 'audit', color: '#eab308' }).returning();
  const [weather] = await db.insert(schema.labels).values({ org_id: org!.id, name: 'weather', color: '#0ea5e9' }).returning();
  await db.insert(schema.labels).values({ org_id: org!.id, name: 'pests', color: '#16a34a' });
  const [capex] = await db.insert(schema.labels).values({ org_id: org!.id, name: 'capex', color: '#7c3aed' }).returning();
  const [buyer] = await db.insert(schema.labels).values({ org_id: org!.id, name: 'buyer', color: '#f97316' }).returning();
  const [heritage] = await db.insert(schema.labels).values({ org_id: org!.id, name: 'heritage', color: '#be185d' }).returning();

  await db.insert(schema.taskLabels).values([
    { task_id: taskIds['HARV1']!, label_id: urgentLbl!.id }, { task_id: taskIds['HARV1']!, label_id: weather!.id },
    { task_id: taskIds['HARV6']!, label_id: urgentLbl!.id }, { task_id: taskIds['HARV6']!, label_id: buyer!.id },
    { task_id: taskIds['HARV7']!, label_id: urgentLbl!.id }, { task_id: taskIds['HARV7']!, label_id: audit!.id },
    { task_id: taskIds['HARV12']!, label_id: audit!.id },
    { task_id: taskIds['HARV10']!, label_id: weather!.id },
    { task_id: taskIds['HARV4']!, label_id: heritage!.id },
    { task_id: taskIds['HARV5']!, label_id: heritage!.id },
    { task_id: taskIds['WHL1']!, label_id: buyer!.id }, { task_id: taskIds['WHL1']!, label_id: urgentLbl!.id },
    { task_id: taskIds['WHL2']!, label_id: buyer!.id }, { task_id: taskIds['WHL2']!, label_id: heritage!.id },
    { task_id: taskIds['WHL4']!, label_id: buyer!.id },
    { task_id: taskIds['WHL8']!, label_id: heritage!.id },
    { task_id: taskIds['GH31']!, label_id: capex!.id }, { task_id: taskIds['GH31']!, label_id: heritage!.id },
    { task_id: taskIds['GH32']!, label_id: capex!.id },
    { task_id: taskIds['GH34']!, label_id: capex!.id },
    { task_id: taskIds['GH36']!, label_id: capex!.id },
  ]);

  // ── Task comments ──
  await db.insert(schema.taskComments).values([
    { org_id: org!.id, task_id: taskIds['HARV1']!, user_id: C, content: 'Eastern Ag confirmed Monday 7am install. 4-hour job. They\'ll need the south field clear of equipment.' },
    { org_id: org!.id, task_id: taskIds['HARV1']!, user_id: T, content: 'I\'ll move the tractor and the drip lines Sunday evening so they\'re clear by Monday morning.' },
    { org_id: org!.id, task_id: taskIds['HARV1']!, user_id: D, content: 'Good. Sage — note in the QC log that the netting is non-permeable; spray applications stop the day before install.' },
    { org_id: org!.id, task_id: taskIds['HARV7']!, user_id: Sg, content: 'Station is set up. Clipboard + pen + hand sanitizer + signage in English and Spanish. Cesar is briefing the crew at 5:50am tomorrow.' },
    { org_id: org!.id, task_id: taskIds['HARV7']!, user_id: C, content: 'Crew is aware. They know I will walk anyone back to the station if they\'re caught skipping.' },
    { org_id: org!.id, task_id: taskIds['HARV12']!, user_id: Sg, content: 'Tuesday 2pm confirmed. I\'ll bring the dry-run checklist + the binder from last year\'s audit. Diego — please block 90 minutes, we have a lot to cover.' },
    { org_id: org!.id, task_id: taskIds['HARV4']!, user_id: M, content: 'Truss count on GH-2 Sun Gold: 144 trusses with at least one ripe fruit. Conservative pull: 80 lbs Thursday.' },
    { org_id: org!.id, task_id: taskIds['HARV6']!, user_id: T, content: 'New logger arrived Friday. I tested it Saturday — works as spec\'d, dual-PDF output. Sunbelt will have everything they need at the dock.' },
    { org_id: org!.id, task_id: taskIds['WHL1']!, user_id: L, content: 'Marigold confirmed we can hit 1,200/wk for 6 weeks with the Beefsteak block. Conservative — peak yield is 1,400/wk so we have buffer. Sending the signed contract back to Sunbelt today.' },
    { org_id: org!.id, task_id: taskIds['WHL1']!, user_id: M, content: 'Confirmed. The Beefsteak block is healthier this year than last — better fruit set, slightly larger size profile. We will be fine on supply.' },
    { org_id: org!.id, task_id: taskIds['WHL2']!, user_id: L, content: 'Asha wants the heritage box mix priced separately from the slicers. I\'m thinking $4.20/lb for the heritage mix (Cherokee Purple, Brandywine, San Marzano) vs $1.85/lb for the slicers. That tracks our retail premium.' },
    { org_id: org!.id, task_id: taskIds['WHL2']!, user_id: D, content: 'Good. Don\'t undersell the heritage premium — they will pay for the story.' },
    { org_id: org!.id, task_id: taskIds['GH31']!, user_id: M, content: 'Revised BOM going to Diego today. Key changes: dedicated dehumidifier from day 1 (not phase 2), zoned irrigation with 4 zones instead of 2, ferti-station with two reservoirs.' },
    { org_id: org!.id, task_id: taskIds['GH31']!, user_id: D, content: 'Approved in principle. Send me the updated number and I\'ll sign off formally.' },
    { org_id: org!.id, task_id: taskIds['GH35']!, user_id: M, content: 'Baker Creek confirmed: Brandywine Sudduth, Cherokee Purple, Black Krim in stock. Aunt Ruby\'s German Green is backordered 4 weeks — substituting with Lillian\'s Yellow Heirloom.' },
  ]);

  // ── Task activity ──
  await db.insert(schema.taskActivity).values([
    { org_id: org!.id, task_id: taskIds['HARV1']!, user_id: D, action: 'created', field: null, old_value: null, new_value: null },
    { org_id: org!.id, task_id: taskIds['HARV1']!, user_id: D, action: 'assigned', field: 'assignee_id', old_value: null, new_value: C },
    { org_id: org!.id, task_id: taskIds['HARV1']!, user_id: C, action: 'status_changed', field: 'status', old_value: 'todo', new_value: 'in_progress' },
    { org_id: org!.id, task_id: taskIds['HARV7']!, user_id: Sg, action: 'status_changed', field: 'status', old_value: 'todo', new_value: 'in_progress' },
    { org_id: org!.id, task_id: taskIds['HARV12']!, user_id: Sg, action: 'status_changed', field: 'status', old_value: 'todo', new_value: 'in_progress' },
    { org_id: org!.id, task_id: taskIds['WHL1']!, user_id: L, action: 'status_changed', field: 'status', old_value: 'in_progress', new_value: 'in_review' },
    { org_id: org!.id, task_id: taskIds['WHL1']!, user_id: D, action: 'priority_changed', field: 'priority', old_value: 'p1', new_value: 'p0' },
    { org_id: org!.id, task_id: taskIds['WHL8']!, user_id: L, action: 'status_changed', field: 'status', old_value: 'in_progress', new_value: 'in_review' },
    { org_id: org!.id, task_id: taskIds['WHL9']!, user_id: L, action: 'status_changed', field: 'status', old_value: 'in_review', new_value: 'done' },
    { org_id: org!.id, task_id: taskIds['WHL10']!, user_id: L, action: 'status_changed', field: 'status', old_value: 'in_progress', new_value: 'done' },
    { org_id: org!.id, task_id: taskIds['GH31']!, user_id: M, action: 'status_changed', field: 'status', old_value: 'todo', new_value: 'in_progress' },
    { org_id: org!.id, task_id: taskIds['GH35']!, user_id: M, action: 'status_changed', field: 'status', old_value: 'todo', new_value: 'in_progress' },
    { org_id: org!.id, task_id: taskIds['GH36']!, user_id: D, action: 'assigned', field: 'assignee_id', old_value: M, new_value: D },
    { org_id: org!.id, task_id: taskIds['GH38']!, user_id: D, action: 'status_changed', field: 'status', old_value: 'in_review', new_value: 'done' },
  ]);

  // ── Task watchers ──
  await db.insert(schema.taskWatchers).values([
    { task_id: taskIds['HARV1']!, user_id: D }, { task_id: taskIds['HARV1']!, user_id: M },
    { task_id: taskIds['HARV12']!, user_id: D },
    { task_id: taskIds['WHL1']!, user_id: D }, { task_id: taskIds['WHL1']!, user_id: M },
    { task_id: taskIds['WHL4']!, user_id: D },
    { task_id: taskIds['GH31']!, user_id: D },
    { task_id: taskIds['GH36']!, user_id: M },
  ]);

  // ── Task ↔ message provenance (source_message_id) ──
  await db.update(schema.tasks).set({ source_message_id: gh1.id }).where(eq(schema.tasks.id, taskIds['GH37']!));
  await db.update(schema.tasks).set({ source_message_id: fo1.id }).where(eq(schema.tasks.id, taskIds['HARV1']!));
  await db.update(schema.tasks).set({ source_message_id: s1.id }).where(eq(schema.tasks.id, taskIds['WHL1']!));
  await db.update(schema.tasks).set({ source_message_id: hr1.id }).where(eq(schema.tasks.id, taskIds['HARV2']!));

  console.log('Created task comments, activity, labels, watchers');

  // ── Wiki Pages (knowledge graph) ──
  function slugify(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

  const wikiDefs = [
    {
      type: 'resource' as const, title: 'Tomato Variety Guide',
      summary: 'Reference for every variety we grow — flavor, days to maturity, best use, retail premium.',
      content: `<h1>Tomato Variety Guide — Testers Tomatoes 2026</h1>
<h2>Slicers (conventional, wholesale program)</h2>
<ul>
<li><strong>Beefsteak</strong> — 80-90 days, 1lb+ fruit, our wholesale workhorse. Sunbelt contract @ $1.85/lb. Yield: 1,200-1,400 lbs/wk peak from the Beefsteak block.</li>
<li><strong>Roma</strong> — 75 days, dense paste-style. South field, hail-vulnerable. Sunbelt slicer fill + farmers market staple.</li>
<li><strong>San Marzano</strong> — 80 days, classic paste, middle field. Heritage box mix component.</li>
</ul>
<h2>Heritage (premium tier, farmers market + Field Co-op)</h2>
<ul>
<li><strong>Cherokee Purple</strong> — 80 days, smoky-sweet, retails $6.50/lb. Heat-sensitive; pull early or display in shade. Row 7, GH-2.</li>
<li><strong>Brandywine (Sudduth strain)</strong> — 85 days, the gold standard for flavor. Slow yielder. Rows 11-13, GH-2.</li>
<li><strong>Aunt Ruby's German Green</strong> — 85 days, green-when-ripe, divisive but loyal fans. Sometimes substituted with Lillian's Yellow Heirloom if backordered.</li>
<li><strong>Black Krim</strong> — 75 days, dusky purple-red. Solid producer for the heritage box.</li>
</ul>
<h2>Cherry / Snacking</h2>
<ul>
<li><strong>Sun Gold</strong> — 65 days, candy-sweet orange cherry. The farmers-market crowd favorite. GH-2 trial: 15% larger trusses than 2025. Pick into 25-lb totes only.</li>
</ul>`,
      tags: ['varieties', 'heritage', 'wholesale', 'farmers-market'],
    },
    {
      type: 'procedure' as const, title: 'Pest Management Playbook',
      summary: 'IPM protocol per pest and per block (organic vs conventional). Approved chemicals only.',
      content: `<h1>Integrated Pest Management — 2026</h1>
<h2>Early Blight (Alternaria solani)</h2>
<p>Most common issue in late spring on the Cherokee Purples when humidity is high. Watch for concentric brown leaf lesions.</p>
<ul>
<li>Organic block: <strong>Copper octanoate</strong> (OMRI listed), 7-day re-entry.</li>
<li>Conventional block: <strong>Mancozeb</strong>, 5-day pre-harvest interval. DO NOT MIX with organic.</li>
</ul>
<h2>Tomato Hornworm</h2>
<p>Hand-pick early (eggs on leaf underside). If outbreak: <strong>Bt</strong> (Bacillus thuringiensis), safe up to harvest.</p>
<h2>Aphids / Whitefly</h2>
<p>Insecticidal soap weekly during peak. Greenhouse-side: yellow sticky traps every 30 ft.</p>
<h2>Sign-off requirements</h2>
<p>Every application logged in the spray binder. Block, chemical, rate, applicator name, weather, re-entry date. Sage spot-checks weekly. The GAP audit will pull this binder.</p>`,
      tags: ['pests', 'audit', 'organic', 'spray-log'],
    },
    {
      type: 'procedure' as const, title: 'Irrigation Schedules — Greenhouse vs Field',
      summary: 'Watering by variety and block. Emitter flush procedure for hard-water buildup.',
      content: `<h1>Irrigation Schedule</h1>
<h2>GH-2 — Drip on emitters</h2>
<p>Slicers: 3 minutes morning + 4 minutes afternoon. Heritage: 4 + 3, slightly drier afternoon to discourage cracking.</p>
<h2>Field (south + middle) — T-tape</h2>
<p>Romas: 35 min at 5am, push to 8am if forecast >85°F. San Marzanos: 30 min daily, 6am.</p>
<h2>Emitter flush procedure (hard water deposits)</h2>
<ol>
<li>1% citric acid solution in the main reservoir.</li>
<li>Run 30 minutes through the line — solution sits in the emitters.</li>
<li>Switch back to clean water, run 15 minutes to flush.</li>
</ol>
<p>Works on both GH drip emitters AND field T-tape. Run quarterly or whenever flow drops 20%+.</p>`,
      tags: ['irrigation', 'maintenance'],
    },
    {
      type: 'procedure' as const, title: 'Cold Storage & Cold-Chain Protocol',
      summary: 'Post-harvest handling for wholesale buyers. Pulp temps, refrigeration spec, dock procedure.',
      content: `<h1>Cold-Chain Protocol</h1>
<h2>Refrigeration spec</h2>
<p>Cold room: <strong>52°F ± 2°F</strong>, 85% RH. Tomatoes do NOT belong below 50°F (chill injury).</p>
<h2>Pulp temperature logging</h2>
<p>Pre-trip: measured at the harvest room before loading. Post-trip: measured at the buyer's dock before unload. Both logged in the new dual-PDF logger as a single record per load.</p>
<h2>Buyer specs</h2>
<ul>
<li><strong>Sunbelt:</strong> 50-55°F, requires printed PDF at dock receiving.</li>
<li><strong>Green Leaf:</strong> 52-58°F, less strict but they pull pulp temps randomly.</li>
<li><strong>Field Co-op:</strong> TBD — Lina to confirm during Friday walkthrough.</li>
</ul>
<h2>The May 14 Green Leaf incident</h2>
<p>Cold truck compressor leak meant the Tuesday delivery arrived at 64°F. Credit memo issued, compressor serviced. Going forward — every truck pulls pulp temps BEFORE leaving the lot AND on arrival.</p>`,
      tags: ['cold-chain', 'wholesale', 'audit', 'incident'],
    },
    {
      type: 'entity' as const, title: 'Wholesale Buyer Directory',
      summary: 'Active and prospective buyer contacts, spec sheets, payment terms.',
      content: `<h1>Wholesale Buyer Directory</h1>
<h2>Active</h2>
<h3>Sunbelt Produce — Fresno DC</h3>
<p>Contact: Marcus Halverson, Produce Buyer. (559) 555-0148. Net 21. Spec: 50-55°F. Current contract: 1,200 lbs/wk Beefsteak, $1.85/lb FOB, May 26 - July 6.</p>
<h3>Green Leaf Distribution — LA</h3>
<p>Contact: Mira Diaz, Production Planning (NEW as of April 2026 — replaces Janet Wu). (213) 555-0192. Net 30. Spec: 52-58°F. Open order: mixed slicers, ~600 lbs/wk on standing PO.</p>
<h2>Prospective</h2>
<h3>Field Co-op (Bay Area regional)</h3>
<p>Contact: Asha Mehta, Sourcing Manager. (510) 555-0177. Farm visit scheduled Friday May 24, 10am. Heritage-mix interest. No contract yet.</p>
`,
      tags: ['buyers', 'contacts'],
    },
    {
      type: 'resource' as const, title: 'Farmers Market Pricing Strategy',
      summary: 'Per-variety retail price tiers and weather-adjusted displays.',
      content: `<h1>Farmers Market Pricing — 2026</h1>
<h2>Conventional tier</h2>
<ul><li>Beefsteak slicers: $3.00/lb</li><li>Roma: $2.50/lb</li></ul>
<h2>Heritage tier (premium)</h2>
<ul><li>Cherokee Purple: $6.50/lb</li><li>Brandywine: $7.00/lb</li><li>San Marzano: $4.50/lb</li><li>Black Krim: $5.50/lb</li><li>Aunt Ruby's German Green: $6.50/lb</li></ul>
<h2>Snacking</h2>
<ul><li>Sun Gold cherries: $5.00/pint</li></ul>
<h2>Heat-day adjustments</h2>
<p>Forecast >85°F: shift display to Sun Golds, Romas, Beefsteak slicers. Skip heritages (sunscald + lost premium). Bring second 10x10 pop-up for shade.</p>`,
      tags: ['farmers-market', 'pricing'],
    },
    {
      type: 'resource' as const, title: 'Greenhouse Climate Setpoints',
      summary: 'Target temp + RH per greenhouse. Dehumidifier sizing rule of thumb.',
      content: `<h1>Greenhouse Climate</h1>
<h2>GH-1 (legacy, conventional slicers)</h2>
<p>Day: 75°F / 65% RH. Night: 62°F / 75% RH. Acceptable RH ceiling 80%.</p>
<h2>GH-2 (current heritage + Sun Gold trial)</h2>
<p>Day: 73°F / 60% RH. Night: 60°F / 70% RH. <strong>Critical:</strong> RH ceiling 70% to prevent early blight on Cherokee Purples (lesson from May 2026 episode).</p>
<h2>GH-3 (under build — heritage-only)</h2>
<p>Spec target: same as GH-2 but with zoned humidity control and a dedicated dehumidifier sized 1 BTU per 2 sqft of canopy. The GH-2 dehumidifier was undersized at 1:3 — going to 1:2 for headroom.</p>`,
      tags: ['greenhouse', 'climate', 'specs'],
    },
    {
      type: 'procedure' as const, title: 'Food Safety Audit Checklist (USDA GAP)',
      summary: 'Pre-audit checklist for the June 18 USDA GAP inspection.',
      content: `<h1>USDA-GAP Pre-Audit Checklist</h1>
<p>Annual inspection scheduled <strong>June 18, 2026</strong>. Dry-run with Sage <strong>May 28</strong>.</p>
<h2>Records to have ready</h2>
<ul>
<li>Handwashing log (sign-in sheets from harvest room entrance station). Goal: 100% compliance for the 30 days preceding the audit.</li>
<li>Spray binder (every application logged with block / chemical / rate / applicator / weather / re-entry).</li>
<li>Water test results (irrigation source water, last 12 months).</li>
<li>Cold storage temp logs (continuous, with manual checks 2x daily).</li>
<li>Traceability — every wholesale load needs a lot code tied back to harvest date + block.</li>
<li>Pulp temp logs for every wholesale delivery (new dual-PDF logger).</li>
</ul>
<h2>Walk-through points</h2>
<p>Harvest room entrance (sign-in station), cold storage compressor service log, spray binder, water test binder, traceability lot codes on outgoing pallets.</p>`,
      tags: ['audit', 'gap', 'food-safety'],
    },
  ];

  const wikiIds: Record<string, string> = {};
  for (const w of wikiDefs) {
    const slug = slugify(w.title);
    const [page] = await db.insert(schema.wikiPages).values({
      org_id: org!.id, scope: 'org', type: w.type, title: w.title, slug,
      summary: w.summary, content: w.content, tags: w.tags, confidence: 0.95,
    }).returning();
    wikiIds[slug] = page!.id;
  }

  // Wiki cross-links (knowledge graph internal edges)
  await db.insert(schema.wikiLinks).values([
    { org_id: org!.id, source_page_id: wikiIds['tomato-variety-guide']!, target_page_id: wikiIds['farmers-market-pricing-strategy']!, context: 'Heritage premium tier pricing tracks the variety profiles' },
    { org_id: org!.id, source_page_id: wikiIds['tomato-variety-guide']!, target_page_id: wikiIds['greenhouse-climate-setpoints']!, context: 'Heritage humidity ceiling drives GH-2 setpoint' },
    { org_id: org!.id, source_page_id: wikiIds['pest-management-playbook']!, target_page_id: wikiIds['food-safety-audit-checklist-usda-gap']!, context: 'Spray binder is a GAP audit artifact' },
    { org_id: org!.id, source_page_id: wikiIds['cold-storage-cold-chain-protocol']!, target_page_id: wikiIds['wholesale-buyer-directory']!, context: 'Per-buyer cold-chain specs' },
    { org_id: org!.id, source_page_id: wikiIds['cold-storage-cold-chain-protocol']!, target_page_id: wikiIds['food-safety-audit-checklist-usda-gap']!, context: 'Pulp temp logs are GAP artifacts' },
    { org_id: org!.id, source_page_id: wikiIds['irrigation-schedules-greenhouse-vs-field']!, target_page_id: wikiIds['greenhouse-climate-setpoints']!, context: 'Irrigation and climate co-tuned' },
    { org_id: org!.id, source_page_id: wikiIds['greenhouse-climate-setpoints']!, target_page_id: wikiIds['pest-management-playbook']!, context: 'RH ceiling prevents blight — the GH-2 lesson' },
  ]);

  console.log('Created 8 wiki pages with internal cross-links');

  // ── Cross-references (knowledge graph: link messages ↔ tasks ↔ tasks) ──
  await db.insert(schema.crossReferences).values([
    { org_id: org!.id, source_type: 'message', source_id: fo1.id, target_type: 'task', target_id: taskIds['HARV1']!, context: 'Hail risk message spawned the hail-netting install task', created_by: D },
    { org_id: org!.id, source_type: 'message', source_id: s1.id, target_type: 'task', target_id: taskIds['WHL1']!, context: 'Sunbelt call recap spawned the contract task', created_by: D },
    { org_id: org!.id, source_type: 'message', source_id: gh1.id, target_type: 'task', target_id: taskIds['GH37']!, context: 'Dehumidifier failure informs GH-3 spec', created_by: M },
    { org_id: org!.id, source_type: 'message', source_id: gh2.id, target_type: 'task', target_id: taskIds['HARV12']!, context: 'Blight risk feeds into pre-audit dry-run', created_by: Sg },
    { org_id: org!.id, source_type: 'message', source_id: hr1.id, target_type: 'task', target_id: taskIds['HARV2']!, context: 'Harvest plan ↔ Monday Roma harvest task', created_by: C },
    { org_id: org!.id, source_type: 'message', source_id: hr1.id, target_type: 'task', target_id: taskIds['HARV4']!, context: 'Thursday Sun Gold pull from the harvest plan', created_by: C },
    { org_id: org!.id, source_type: 'message', source_id: lg1.id, target_type: 'task', target_id: taskIds['HARV6']!, context: 'Truck rotation message ↔ Sunbelt delivery task', created_by: T },
    { org_id: org!.id, source_type: 'task', source_id: taskIds['HARV1']!, target_type: 'task', target_id: taskIds['HARV10']!, context: 'Hail netting + hoop house panels — same weather event prep', created_by: C },
    { org_id: org!.id, source_type: 'task', source_id: taskIds['HARV12']!, target_type: 'task', target_id: taskIds['HARV7']!, context: 'Audit dry-run depends on handwashing station being live', created_by: Sg },
    { org_id: org!.id, source_type: 'task', source_id: taskIds['WHL1']!, target_type: 'task', target_id: taskIds['HARV6']!, context: 'Sunbelt contract drives Tuesday delivery cadence', created_by: L },
    { org_id: org!.id, source_type: 'task', source_id: taskIds['WHL2']!, target_type: 'task', target_id: taskIds['HARV5']!, context: 'Field Co-op visit ↔ Cherokee Purple selective pick', created_by: L },
    { org_id: org!.id, source_type: 'task', source_id: taskIds['GH37']!, target_type: 'task', target_id: taskIds['GH31']!, context: 'GH-2 lessons feed GH-3 BOM revision', created_by: M },
  ]);

  // ── Tags + entity_tags (the second axis of the knowledge graph) ──
  const tagDefs = [
    { name: 'audit', color: '#eab308' },
    { name: 'weather', color: '#0ea5e9' },
    { name: 'heritage', color: '#be185d' },
    { name: 'buyer', color: '#f97316' },
    { name: 'gh-3', color: '#0ea5e9' },
    { name: 'pricing', color: '#10b981' },
    { name: 'irrigation', color: '#06b6d4' },
    { name: 'cold-chain', color: '#6366f1' },
  ];
  const tagIds: Record<string, string> = {};
  for (const t of tagDefs) {
    const [tag] = await db.insert(schema.tags).values({ org_id: org!.id, name: t.name, color: t.color }).returning();
    tagIds[t.name] = tag!.id;
  }

  const entityTagBindings: { tag: string; type: 'message' | 'task' | 'note'; id: string }[] = [
    { tag: 'audit', type: 'task', id: taskIds['HARV7']! },
    { tag: 'audit', type: 'task', id: taskIds['HARV12']! },
    { tag: 'weather', type: 'task', id: taskIds['HARV1']! },
    { tag: 'weather', type: 'task', id: taskIds['HARV10']! },
    { tag: 'weather', type: 'message', id: fo1.id },
    { tag: 'heritage', type: 'task', id: taskIds['HARV4']! },
    { tag: 'heritage', type: 'task', id: taskIds['HARV5']! },
    { tag: 'heritage', type: 'task', id: taskIds['WHL2']! },
    { tag: 'heritage', type: 'task', id: taskIds['GH31']! },
    { tag: 'buyer', type: 'task', id: taskIds['WHL1']! },
    { tag: 'buyer', type: 'task', id: taskIds['WHL2']! },
    { tag: 'buyer', type: 'task', id: taskIds['WHL4']! },
    { tag: 'buyer', type: 'message', id: s1.id },
    { tag: 'gh-3', type: 'task', id: taskIds['GH31']! },
    { tag: 'gh-3', type: 'task', id: taskIds['GH32']! },
    { tag: 'gh-3', type: 'task', id: taskIds['GH35']! },
    { tag: 'gh-3', type: 'task', id: taskIds['GH36']! },
    { tag: 'gh-3', type: 'task', id: taskIds['GH37']! },
    { tag: 'gh-3', type: 'task', id: taskIds['GH38']! },
    { tag: 'cold-chain', type: 'task', id: taskIds['HARV6']! },
    { tag: 'cold-chain', type: 'task', id: taskIds['WHL5']! },
    { tag: 'cold-chain', type: 'task', id: taskIds['HARV9']! },
  ];
  for (const b of entityTagBindings) {
    await db.insert(schema.entityTags).values({
      org_id: org!.id, tag_id: tagIds[b.tag]!, entity_type: b.type, entity_id: b.id,
    }).catch(() => {});
  }

  console.log('Created cross-references, tags, and entity tags (knowledge graph)');

  // ── Notes (personal + shared) ──
  const notes = [
    {
      user: diego!, title: 'Sunday strategy notes — May 25', icon: '🧭', pinned: true, visibility: 'private' as const,
      content: `<h1>What's on my mind</h1>
<h2>This week's high-leverage moves</h2>
<ul>
<li>Hail netting on south field MUST happen Monday. Weather is a coin flip; netting is the cheaper outcome.</li>
<li>Sunbelt contract returns Friday. 14% price lift over last year — anchor $2.00 for 2027.</li>
<li>Asha Mehta visit Friday — this is the bigger long-term win. Heritage premium story.</li>
</ul>
<h2>Quiet move: GH-3 heritage pivot</h2>
<p>Marigold and I aligned this week — GH-3 is heritage-only, not "general purpose". Doubles the per-sqft margin. Permit follow-up is on me; calling the inspector Monday.</p>
<h2>Confidential: Whole Foods PNW</h2>
<p>Off the table until October. Don't even mention it to the team. Lina has the cost model.</p>
<h2>People notes</h2>
<ul>
<li>Sage is doing exactly the right thing about the GAP audit — back her up publicly Monday.</li>
<li>Tomás is overloaded with the cold truck servicing fallout. Check in.</li>
</ul>`,
    },
    {
      user: marigold!, title: 'GH-3 BOM revision — working draft', icon: '📋', pinned: true, visibility: 'private' as const,
      content: `<h1>GH-3 Revised BOM (heritage-only pivot)</h1>
<h2>Changes from v1</h2>
<ol>
<li><strong>Climate:</strong> dedicated 24,000 BTU dehumidifier from day 1 (was phase 2). +$3,400.</li>
<li><strong>Irrigation:</strong> 4 zones instead of 2 — heritage varieties want differentiated schedules. +$2,100 in additional valves + manifold.</li>
<li><strong>Ferti-station:</strong> dual reservoir (one organic, one conventional). +$1,800.</li>
<li><strong>Sensors:</strong> CO2 + airflow added — heritage varieties are pickier. +$900.</li>
<li><strong>Soil:</strong> deeper grading + compost amendment from Madsen Farms. +$4,800.</li>
</ol>
<h2>Total delta</h2>
<p>+$13,000 from original BOM. New total: $187,400. Diego approved in principle, needs formal signoff.</p>
<h2>Justification</h2>
<p>Heritage retail premium is 2.6x conventional slicers. The build delta pays back in <strong>~6 months</strong> of farmers market sales + Field Co-op contract.</p>`,
    },
    {
      user: lina!, title: 'Asha Mehta visit prep — Friday', icon: '🤝', pinned: true, visibility: 'private' as const,
      content: `<h1>Field Co-op walkthrough — May 24, 10am</h1>
<h2>Tour route</h2>
<ol>
<li>GH-2 entrance → Sun Gold trusses (the wow factor)</li>
<li>Cherokee Purple Row 12 (NOT picked yet — full display)</li>
<li>Walk out to south field → Roma block (talk operations)</li>
<li>Harvest room → cold storage (food safety story)</li>
<li>Office tasting — heritage box: Cherokee Purple, Brandywine, San Marzano slices</li>
</ol>
<h2>Pricing to pitch</h2>
<ul>
<li>Heritage box mix: <strong>$4.20/lb FOB</strong> (retail comp $6.50/lb)</li>
<li>Slicer fill: $1.85/lb FOB (matches Sunbelt)</li>
<li>Minimum order: 200 lbs/wk on heritage, 400 lbs/wk on slicers</li>
</ul>
<h2>Asks</h2>
<p>Net 30 payment terms. We deliver Wed mornings. They commit to a 6-week trial.</p>
<h2>Risks</h2>
<p>If Cherokee Purple block hits early blight before Friday (humidity issue Marigold flagged), the heritage pitch loses its visual. Backup: pull the Brandywines (Row 11-13) as the show variety.</p>`,
    },
    {
      user: sage!, title: 'GAP audit dry-run agenda', icon: '✅', pinned: false, visibility: 'org' as const,
      content: `<h1>GAP Audit Dry-Run — May 28, 2pm</h1>
<p>Walking Diego through the actual audit flow so there are zero surprises June 18.</p>
<h2>Records review (30 min)</h2>
<ul>
<li>Handwashing sign-in compliance — Goal: 100% for the 30 days before audit</li>
<li>Spray binder — full year of entries</li>
<li>Water test results — annual + last quarterly</li>
<li>Cold storage temp logs — continuous trace</li>
<li>Traceability — lot codes on outgoing pallets back to harvest date + block</li>
</ul>
<h2>Walkthrough (45 min)</h2>
<p>Same route the auditor will take: parking → harvest room entrance (sign-in station) → cold storage → spray storage → field. I'll point out anything that's still rough.</p>
<h2>Gap remediation (15 min)</h2>
<p>Whatever I find that's not ready, we ticket and assign before Diego leaves.</p>`,
    },
    {
      user: cesar!, title: 'Hail playbook (south field)', icon: '⚠️', pinned: false, visibility: 'org' as const,
      content: `<h1>Hail Response — South Field</h1>
<h2>Pre-event (T-72h)</h2>
<p>NOAA + Weather Underground both show >25% hail risk → call Eastern Ag for netting. Lead time 72h for install crew.</p>
<h2>During event</h2>
<p>If netting is up: nothing to do. If not: walk the rows after the event to mark damaged fruit with flagging tape for selective pick.</p>
<h2>Post-event triage</h2>
<p>Damaged fruit goes to the farmers market "salvage tier" at $1.50/lb (still sellable as sauce-grade if not broken-skinned). Anything broken-skinned: compost.</p>
<h2>Lesson from May 2025</h2>
<p>We didn't net last year — lost 40% of the Roma block to a freak late-May hail event. Cost: ~$22k revenue. Netting at $8,640 is a no-brainer.</p>`,
    },
    {
      user: tomas!, title: 'Cold truck service log', icon: '🚚', pinned: false, visibility: 'org' as const,
      content: `<h1>Cold Truck — 2026 Service Log</h1>
<table>
<tr><th>Date</th><th>Service</th><th>Cost</th><th>Notes</th></tr>
<tr><td>Feb 4</td><td>Annual inspection</td><td>$340</td><td>Compressor fitting noted as "watch"</td></tr>
<tr><td>May 14</td><td>Emergency: compressor leak</td><td>$1,820</td><td>Caused warm delivery to Green Leaf — credit memo issued. Replaced fitting + recharged R-410A.</td></tr>
<tr><td>May 21</td><td>Post-repair verification</td><td>$0</td><td>Confirmed pulp temp held at 51°F over 5hr LA trip.</td></tr>
</table>
<h2>Going forward</h2>
<p>Pulp temps logged BEFORE departure on EVERY trip, regardless of buyer requirement. Catches issues at the lot, not at the dock.</p>`,
    },
    {
      user: marigold!, title: 'Seed inventory — 2026', icon: '🌱', pinned: false, visibility: 'org' as const,
      content: `<h1>Seed Stock (as of May 25)</h1>
<h2>Conventional</h2>
<ul><li>Beefsteak: 2 lbs (~6,000 seeds). Enough for 2026 + 2027.</li><li>Roma: 0.5 lb. Need 0.5 lb more for 2027.</li><li>San Marzano: 0.25 lb. Ordering 0.5 lb.</li></ul>
<h2>Heritage (Baker Creek + Johnny's)</h2>
<ul><li>Cherokee Purple: 800 seeds, fresh 2026 packet.</li><li>Brandywine (Sudduth): 400 seeds, fresh 2026 packet.</li><li>Black Krim: 600 seeds, fresh.</li><li>Aunt Ruby's German Green: BACKORDERED — sub Lillian's Yellow Heirloom (400 seeds confirmed).</li><li>Mortgage Lifter: ordered, not yet arrived.</li><li>Green Zebra: 300 seeds, fresh.</li></ul>
<h2>Snacking</h2>
<ul><li>Sun Gold F1: 2 packets (~200 seeds total). Enough for GH-2 + farmers market trial.</li></ul>
<h2>To order by June 1</h2>
<p>Mortgage Lifter (confirm), Lillian's Yellow Heirloom (substitution), Roma top-up.</p>`,
    },
    {
      user: diego!, title: 'Pricing strategy — 2027 anchor', icon: '💰', pinned: false, visibility: 'private' as const,
      content: `<h1>Pricing Strategy — 2027</h1>
<h2>Slicers</h2>
<p>2026 contracted at $1.85 (Sunbelt). Anchor 2027 at $2.00. Sunbelt has shown willingness to pay; competitors are higher. Don't undersell.</p>
<h2>Heritage</h2>
<p>$4.20/lb wholesale (per Field Co-op pitch). Retail at $6.50/lb. Margin story to buyers: scarcity + flavor differentiation.</p>
<h2>Farmers market</h2>
<p>Hold current pricing through 2026; revisit when GH-3 comes online — if heritage volume grows 2x, may need to dial back retail premium to $6.00 to move volume. Watch.</p>
<h2>Whole Foods (confidential, not in play yet)</h2>
<p>If we go national in 2027, the conversation changes. National volume + branded program = sub-$3 wholesale even on heritage, made up on volume. Decide in Q4 after GH-3 reality check.</p>`,
    },
    {
      user: lina!, title: 'Farmers market — Saturday playbook', icon: '🏪', pinned: false, visibility: 'org' as const,
      content: `<h1>Farmers Market — Saturday</h1>
<h2>Forecast-driven display</h2>
<p>Check NOAA Thursday for Saturday's high.</p>
<ul>
<li><strong>&lt;80°F:</strong> full heritage display, premium up front. Cherokee Purple + Brandywine center stage.</li>
<li><strong>80-87°F:</strong> heritage in the shaded back row, slicers + Sun Golds up front. Watch for sun fade on heritages.</li>
<li><strong>&gt;87°F:</strong> heritage off the table (or in a cooler with samples only). Sun Gold + slicers only. Second pop-up for shade.</li>
</ul>
<h2>Signage</h2>
<p>Variety education cards next to each crate. Customers will pay 2x for the story.</p>
<h2>Crew</h2>
<p>2 people: one selling, one restocking + customer questions. Start 7am setup, market opens 8am.</p>`,
    },
  ];

  const noteIds: Record<string, string> = {};
  for (const n of notes) {
    const [note] = await db.insert(schema.notes).values({
      org_id: org!.id, user_id: n.user.id, title: n.title, icon: n.icon, content: n.content,
      is_pinned: n.pinned, visibility: n.visibility,
    }).returning();
    noteIds[n.title] = note!.id;
  }

  // Tag a few notes
  await db.insert(schema.entityTags).values([
    { org_id: org!.id, tag_id: tagIds['heritage']!, entity_type: 'note', entity_id: noteIds['Asha Mehta visit prep — Friday']! },
    { org_id: org!.id, tag_id: tagIds['buyer']!, entity_type: 'note', entity_id: noteIds['Asha Mehta visit prep — Friday']! },
    { org_id: org!.id, tag_id: tagIds['gh-3']!, entity_type: 'note', entity_id: noteIds['GH-3 BOM revision — working draft']! },
    { org_id: org!.id, tag_id: tagIds['audit']!, entity_type: 'note', entity_id: noteIds['GAP audit dry-run agenda']! },
    { org_id: org!.id, tag_id: tagIds['weather']!, entity_type: 'note', entity_id: noteIds['Hail playbook (south field)']! },
    { org_id: org!.id, tag_id: tagIds['cold-chain']!, entity_type: 'note', entity_id: noteIds['Cold truck service log']! },
    { org_id: org!.id, tag_id: tagIds['pricing']!, entity_type: 'note', entity_id: noteIds['Pricing strategy — 2027 anchor']! },
  ]);

  console.log('Created 9 notes');

  // ── Notifications ──
  await db.insert(schema.notifications).values([
    { org_id: org!.id, user_id: D, type: 'mention', title: 'Lina in #sales-and-buyers', body: 'Sunbelt call recap: $1.85/lb, 1,200 lbs/wk, 6 weeks. Decision by Friday.', link: `/chat?space=${sales!.id}`, is_read: false },
    { org_id: org!.id, user_id: D, type: 'task_assigned', title: 'Marigold assigned you GH3-6', body: 'Construction permit — county inspector follow-up', link: '/tasks?task=GH3-6', is_read: false },
    { org_id: org!.id, user_id: D, type: 'task_updated', title: 'Sage moved HARV-7 to In Progress', body: 'Hand-washing sign-in station', link: '/tasks?task=HARV-7', is_read: true },
    { org_id: org!.id, user_id: D, type: 'message', title: 'Marigold in #greenhouse', body: 'GH-2 climate log overnight: humidity peaked at 84%...', link: `/chat?space=${greenhouse!.id}`, is_read: false },
    { org_id: org!.id, user_id: M, type: 'mention', title: 'Diego in #greenhouse', body: 'Order a second dehumidifier. Pull from GH-3 budget if you have to.', link: `/chat?space=${greenhouse!.id}`, is_read: true },
    { org_id: org!.id, user_id: L, type: 'task_updated', title: 'Diego raised WHL-1 priority to p0', body: 'Sunbelt 6-week contract — sign and return', link: '/tasks?task=WHL-1', is_read: false },
    { org_id: org!.id, user_id: C, type: 'mention', title: 'Diego in #field-ops', body: '"Do it. Better insurance than insurance." (re: hail netting)', link: `/chat?space=${fieldOps!.id}`, is_read: true },
    { org_id: org!.id, user_id: Sg, type: 'mention', title: 'Diego in DM', body: 'Tuesday 2pm. Block it on my calendar.', link: `/chat?space=${dmDS!.id}`, is_read: false },
    { org_id: org!.id, user_id: T, type: 'task_assigned', title: 'Cesar assigned you HARV-10', body: 'Stage hoop house side panels for fast deployment', link: '/tasks?task=HARV-10', is_read: false },
  ]);

  // ── Read positions — partial unread for Diego ──
  const genMsgs = await db.select({ id: schema.messages.id, created_at: schema.messages.created_at })
    .from(schema.messages).where(eq(schema.messages.space_id, general!.id))
    .orderBy(asc(schema.messages.created_at));
  if (genMsgs.length > 5) {
    const anchor = genMsgs[Math.max(0, genMsgs.length - 4)]!;
    await db.update(schema.spaceMembers).set({
      last_read_message_id: anchor.id, last_read_at: new Date(anchor.created_at),
    }).where(and(eq(schema.spaceMembers.space_id, general!.id), eq(schema.spaceMembers.user_id, D)));
  }

  // ── Audit log breadcrumbs ──
  await db.insert(schema.auditLog).values([
    { org_id: org!.id, actor_type: 'user', actor_id: D, action: 'create', entity_type: 'org', entity_id: org!.id, metadata: { source: 'seed-demo' } },
    { org_id: org!.id, actor_type: 'user', actor_id: L, action: 'update', entity_type: 'task', entity_id: taskIds['WHL1']!, before_state: { status: 'in_progress' }, after_state: { status: 'in_review' } },
    { org_id: org!.id, actor_type: 'user', actor_id: D, action: 'update', entity_type: 'task', entity_id: taskIds['WHL1']!, before_state: { priority: 'p1' }, after_state: { priority: 'p0' } },
    { org_id: org!.id, actor_type: 'user', actor_id: Sg, action: 'update', entity_type: 'task', entity_id: taskIds['HARV7']!, before_state: { status: 'todo' }, after_state: { status: 'in_progress' } },
  ]);

  console.log('\n✅ Testers Tomatoes demo seed complete!\n');
  console.log('Login (password for everyone: tomato123):');
  console.log('  diego@testers-tomatoes.com     (owner, Farm Manager)');
  console.log('  marigold@testers-tomatoes.com  (admin, Head Grower)');
  console.log('  cesar@testers-tomatoes.com     (member, Field Supervisor)');
  console.log('  lina@testers-tomatoes.com      (member, Sales Lead)');
  console.log('  tomas@testers-tomatoes.com     (member, Logistics)');
  console.log('  sage@testers-tomatoes.com      (member, QC + Food Safety)\n');
  console.log('Projects: HARV (Spring Harvest), WHL (Wholesale Expansion), GH3 (Greenhouse 3 Build-out)');
  console.log(`OpenAI key: ${OPENAI_KEY ? '✅ stored encrypted on orgs.ai_config' : 'not set (workspace boots without LLM; set SEED_OPENAI_KEY to enable)'}`);

  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
