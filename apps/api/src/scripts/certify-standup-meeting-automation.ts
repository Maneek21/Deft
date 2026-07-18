import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  automationRuns,
  events,
  meetingBriefs,
  messages,
  orgMembers,
  orgs,
  projects,
  spaceMembers,
  spaces,
  standups,
  tasks,
  users,
} from '@deft/db/schema';
import { db } from '../lib/db.js';
import { DEFTY_EMAIL } from '../lib/ensure-defty-membership.js';
import { generateMeetingPrep } from '../lib/meeting-prep-automation.js';
import { generateDailyStandup } from '../lib/standup-automation.js';

const CERT_TITLE = 'Automation certification buyer handoff';
const PRIVATE_MARKER = 'PRIVATE_AUTOMATION_CERT_MARKER';
const RESTRICTED_TASK_MARKER = 'RESTRICTED_AUTOMATION_CERT_TASK';
const EXPECTED_GENERATOR = process.env.AUTOMATION_CERT_EXPECT_GENERATOR ?? 'fallback';

async function main() {
  const [org] = await db.select({ id: orgs.id }).from(orgs)
    .where(eq(orgs.name, 'Testers Tomatoes')).limit(1);
  assert(org, 'Seeded Testers Tomatoes org is required');

  const people = await db.select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .innerJoin(orgMembers, and(
      eq(orgMembers.user_id, users.id),
      eq(orgMembers.org_id, org.id),
      eq(orgMembers.is_active, true),
    ));
  const diego = people.find((person) => person.email === 'diego@testers-tomatoes.com');
  const lina = people.find((person) => person.email === 'lina@testers-tomatoes.com');
  const sage = people.find((person) => person.email === 'sage@testers-tomatoes.com');
  assert(diego && lina && sage, 'Diego, Lina, and Sage must exist in the seeded org');

  const now = new Date('2026-07-18T05:30:00.000Z');
  const firstStandup = await generateDailyStandup({ orgId: org.id, requestedByUserId: diego.id, now });
  const secondStandup = await generateDailyStandup({ orgId: org.id, requestedByUserId: diego.id, now });
  assert.equal(firstStandup.alreadyExisted, false, 'First standup run must execute');
  assert.equal(secondStandup.alreadyExisted, true, 'Second standup run must deduplicate');
  assert(firstStandup.standup, 'Standup must be persisted');
  assert(firstStandup.run, 'Standup automation run must be persisted');
  const standupRun = firstStandup.run;
  assert.equal(standupRun.status, 'delivered');
  assert.equal(standupRun.generator, EXPECTED_GENERATOR, 'Standup must expose the expected generator provenance');

  const [defty] = await db.select({ id: users.id, is_agent: users.is_agent }).from(users)
    .where(eq(users.email, DEFTY_EMAIL)).limit(1);
  assert(defty?.is_agent, 'Defty must exist as an agent user');
  assert.equal(firstStandup.standup.generated_by, defty.id, 'Standup must be authored by Defty');

  const standupOutput = standupRun.output as Record<string, unknown> | null;
  const standupMessageId = typeof standupOutput?.message_id === 'string' ? standupOutput.message_id : null;
  assert(standupMessageId, 'Standup delivery message must be recorded');
  const [standupMessage] = await db.select({ user_id: messages.user_id }).from(messages)
    .where(eq(messages.id, standupMessageId)).limit(1);
  assert.equal(standupMessage?.user_id, defty.id, 'Delivered standup message must be authored by Defty');

  const [privateSpace] = await db.insert(spaces).values({
    org_id: org.id,
    name: `automation-cert-private-${Date.now()}`,
    type: 'private',
    created_by: lina.id,
  }).returning({ id: spaces.id });
  assert(privateSpace);
  await db.insert(spaceMembers).values([
    { space_id: privateSpace.id, user_id: lina.id },
    { space_id: privateSpace.id, user_id: sage.id },
  ]);
  await db.insert(messages).values({
    org_id: org.id,
    space_id: privateSpace.id,
    user_id: lina.id,
    content: `${PRIVATE_MARKER}: do not expose this to Diego's meeting brief.`,
    created_at: new Date(now.getTime() - 10 * 60_000),
  });

  const certSuffix = randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
  const [project] = await db.insert(projects).values({
    org_id: org.id,
    name: `Automation certification ${certSuffix}`,
    prefix: `AC${certSuffix.slice(0, 4)}`,
    lead_id: lina.id,
  }).returning({ id: projects.id });
  assert(project, 'Certification project must be created');
  await db.insert(tasks).values({
    org_id: org.id,
    project_id: project.id,
    number: 900_000 + Math.floor(Math.random() * 90_000),
    title: `${CERT_TITLE} ${RESTRICTED_TASK_MARKER}`,
    assignee_id: lina.id,
    created_by: lina.id,
    metadata: { visibility: 'restricted', visible_user_ids: [lina.id] },
  });

  const meetingStart = new Date(now.getTime() + 15 * 60_000);
  const [meeting] = await db.insert(events).values({
    org_id: org.id,
    source: 'native',
    event_type: 'calendar_event',
    external_id: `automation-cert-${Date.now()}`,
    title: CERT_TITLE,
    timestamp: meetingStart,
    user_id: diego.id,
    metadata: {
      end: new Date(meetingStart.getTime() + 30 * 60_000).toISOString(),
      attendees: [{ email: lina.email, displayName: lina.name }],
    },
  }).returning({ id: events.id });
  assert(meeting);

  const firstPrep = await generateMeetingPrep(meeting.id, now);
  const secondPrep = await generateMeetingPrep(meeting.id, now);
  assert.equal(firstPrep.alreadyExisted, false, 'First meeting-prep run must execute');
  assert.equal(secondPrep.alreadyExisted, true, 'Second meeting-prep run must deduplicate');
  assert(firstPrep.brief, 'Meeting brief must be persisted');
  assert(firstPrep.run, 'Meeting-prep automation run must be persisted');
  const meetingRun = firstPrep.run;
  assert.equal(meetingRun.status, 'delivered');
  assert.equal(meetingRun.generator, EXPECTED_GENERATOR, 'Meeting prep must expose the expected generator provenance');
  assert(!firstPrep.brief.brief_text.includes(PRIVATE_MARKER), 'Recipient-inaccessible chat must not leak');

  const meetingOutput = meetingRun.output as Record<string, unknown> | null;
  const evidence = JSON.stringify(meetingOutput?.evidence ?? []);
  assert(evidence.includes(`event:${meeting.id}`), 'Meeting evidence must cite the source event');
  assert(!evidence.includes(PRIVATE_MARKER), 'Private-space evidence must be excluded before synthesis');
  assert(!evidence.includes(RESTRICTED_TASK_MARKER), 'Restricted task evidence must be excluded before synthesis');

  const [persistedEvent] = await db.select({ metadata: events.metadata }).from(events)
    .where(eq(events.id, meeting.id)).limit(1);
  const attendeeMetadata = persistedEvent?.metadata as { attendees?: Array<{ email?: string }> } | undefined;
  assert.equal(attendeeMetadata?.attendees?.[0]?.email, lina.email, 'Native attendee metadata must persist');

  const standupRows = await db.select({ id: standups.id }).from(standups)
    .where(eq(standups.id, firstStandup.standup.id));
  const briefRows = await db.select({ id: meetingBriefs.id }).from(meetingBriefs)
    .where(and(eq(meetingBriefs.event_id, meeting.id), eq(meetingBriefs.user_id, diego.id)));
  const standupRunRows = await db.select({ id: automationRuns.id }).from(automationRuns)
    .where(and(eq(automationRuns.org_id, org.id), eq(automationRuns.kind, 'standup')));
  const meetingRunRows = await db.select({ id: automationRuns.id }).from(automationRuns)
    .where(and(eq(automationRuns.org_id, org.id), eq(automationRuns.subject_id, meeting.id)));
  assert.equal(standupRows.length, 1, 'One standup result must exist for the claimed run');
  assert.equal(briefRows.length, 1, 'One brief must exist per event and recipient');
  assert.equal(standupRunRows.length, 1, 'Repeated standup calls must share one run');
  assert.equal(meetingRunRows.length, 1, 'Repeated meeting calls must share one run');

  console.log(JSON.stringify({
    ok: true,
    standup: {
      generator: standupRun.generator,
      deduplicated: secondStandup.alreadyExisted,
      authored_by_defty: firstStandup.standup.generated_by === defty.id,
      delivered_message_id: standupMessageId,
    },
    meeting_prep: {
      generator: meetingRun.generator,
      deduplicated: secondPrep.alreadyExisted,
      attendee_persisted: attendeeMetadata?.attendees?.[0]?.email === lina.email,
      private_context_excluded: !evidence.includes(PRIVATE_MARKER),
      restricted_tasks_excluded: !evidence.includes(RESTRICTED_TASK_MARKER),
      brief_id: firstPrep.brief.id,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
