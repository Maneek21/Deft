import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { notifications, orgs, users } from '@deft/db/schema';
import { db } from '../lib/db.js';
import {
  addInboxCompactionMetadata,
  inboxCompactionRunId,
  planLegacyTaskNudgeCompaction,
  removeInboxCompactionMetadata,
} from '../lib/inbox-maintenance.js';

type Args = {
  orgSlug: string | null;
  userEmail: string | null;
  apply: boolean;
  restoreRunId: string | null;
};

function readFlagValue(argv: string[], name: string) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

function parseArgs(argv: string[]): Args {
  return {
    orgSlug: readFlagValue(argv, '--org-slug'),
    userEmail: readFlagValue(argv, '--user-email'),
    apply: argv.includes('--apply'),
    restoreRunId: readFlagValue(argv, '--restore'),
  };
}

function usage() {
  return [
    'Usage:',
    '  pnpm --filter @deft/api inbox:compact -- --org-slug <slug> [--user-email <email>]',
    '  pnpm --filter @deft/api inbox:compact -- --org-slug <slug> [--user-email <email>] --apply',
    '  pnpm --filter @deft/api inbox:compact -- --org-slug <slug> --restore <run-id>',
    '',
    'The default is a dry run. Apply marks only superseded unread task nudges as read.',
    'Every changed row records a run id in metadata so the operation can be restored.',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.orgSlug || (args.apply && args.restoreRunId)) {
    throw new Error(usage());
  }

  const [org] = await db.select({ id: orgs.id, name: orgs.name })
    .from(orgs)
    .where(eq(orgs.slug, args.orgSlug))
    .limit(1);
  if (!org) throw new Error(`Organization not found: ${args.orgSlug}`);

  const rows = await db.select({
    id: notifications.id,
    user_id: notifications.user_id,
    user_email: users.email,
    title: notifications.title,
    is_read: notifications.is_read,
    metadata: notifications.metadata,
    created_at: notifications.created_at,
  })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.user_id))
    .where(and(
      eq(notifications.org_id, org.id),
      eq(notifications.type, 'agent_suggestion'),
      args.userEmail ? eq(users.email, args.userEmail) : undefined,
    ))
    .orderBy(desc(notifications.created_at));

  if (args.restoreRunId) {
    const restorable = rows.filter((row) => inboxCompactionRunId(row.metadata) === args.restoreRunId);
    if (restorable.length === 0) {
      console.log(`No compacted notifications found for run ${args.restoreRunId}.`);
      return;
    }

    await db.transaction(async (tx) => {
      for (const row of restorable) {
        await tx.update(notifications)
          .set({
            is_read: false,
            metadata: removeInboxCompactionMetadata(row.metadata),
            updated_at: new Date(),
          })
          .where(and(eq(notifications.id, row.id), eq(notifications.org_id, org.id)));
      }
    });
    console.log(`Restored ${restorable.length} notification(s) in ${org.name}.`);
    return;
  }

  const groups = planLegacyTaskNudgeCompaction(rows);
  const compactRows = groups.flatMap((group) => group.compact.map((row) => ({ row, group })));
  console.log(`Organization: ${org.name}`);
  console.log(`Task-nudge groups with duplicates: ${groups.length}`);
  for (const group of groups) {
    const email = rows.find((row) => row.user_id === group.userId)?.user_email ?? group.userId;
    console.log(`- ${email} / ${group.nudgeType}: keep "${group.keep.title}", compact ${group.compact.length}`);
  }
  console.log(`Superseded unread notifications: ${compactRows.length}`);

  if (!args.apply || compactRows.length === 0) {
    console.log(args.apply ? 'Nothing to change.' : 'Dry run only. Re-run with --apply to compact these rows.');
    return;
  }

  const runId = `inbox-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const compactedAt = new Date().toISOString();
  await db.transaction(async (tx) => {
    for (const { row, group } of compactRows) {
      await tx.update(notifications)
        .set({
          is_read: true,
          metadata: addInboxCompactionMetadata({
            metadata: row.metadata,
            runId,
            compactedAt,
            keptNotificationId: group.keep.id,
          }),
          updated_at: new Date(),
        })
        .where(and(eq(notifications.id, row.id), eq(notifications.org_id, org.id)));
    }
  });

  console.log(`Compacted ${compactRows.length} notification(s).`);
  console.log(`Restore with: pnpm --filter @deft/api inbox:compact -- --org-slug ${args.orgSlug} --restore ${runId}`);
  console.log(`COMPACTION_RUN_ID=${runId}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
