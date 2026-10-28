import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { agentNudges, messages, notifications, spaceMembers, spaces, taskRelationships, tasks, users } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { handleBlockedAlert } from '../src/workers/handlers/blocked-alert.js';

const trigger = {
  messageId: 'new-migration-blocker',
  spaceId: 'engineering-space',
  orgId: 'workspace',
  userId: 'rahul',
  content: 'I am blocked on the migration because the production schema is missing.',
};

afterEach(() => mock.restoreAll());

function stubBlockedAlertDatabase(leadCanReadSpace = true) {
  const createdNotifications: Array<Record<string, any>> = [];
  let staleMessageReads = 0;
  mock.method(db, 'select', () => {
    let table: unknown;
    const query = {
      from(value: unknown) { table = value; return query; },
      innerJoin() { return query; },
      where() { return query; },
      orderBy() { return query; },
      limit() { return query; },
      then(resolve: (rows: unknown[]) => unknown) {
        let rows: unknown[] = [];
        if (table === users) rows = [{ name: 'Rahul', notification_preferences: null }];
        if (table === spaces) rows = [{ name: 'engineering' }];
        if (table === tasks) rows = [{
          id: 'migration-task', title: 'Apply migration', number: 7,
          project_id: 'project', project_prefix: 'DEFT', project_lead_id: 'lead',
        }];
        if (table === spaceMembers && leadCanReadSpace) rows = [{ is_muted: false, notification_level: 'all' }];
        if (table === taskRelationships || table === agentNudges) rows = [];
        if (table === messages) {
          staleMessageReads += 1;
          rows = [{ id: 'older-flaky-test', content: 'I am blocked by a flaky test.' }];
        }
        return Promise.resolve(resolve(rows));
      },
    };
    return query as any;
  });
  mock.method(db, 'insert', (table: unknown) => ({
    values(value: Record<string, any>) {
      if (table === notifications) createdNotifications.push(value);
      const rows = table === notifications ? [{ id: 'notification', ...value }] : [];
      const query = {
        returning: async () => rows,
        onConflictDoUpdate() { return query; },
        onConflictDoNothing() { return query; },
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(rows)),
      };
      return query;
    },
  }) as any);
  // Unexpected queries must never fall through to a real database connection.
  mock.method(db, 'execute', () => { throw new Error('Unexpected database execution'); });
  mock.method(db, 'update', () => { throw new Error('Unexpected database update'); });
  mock.method(db, 'transaction', () => { throw new Error('Unexpected database transaction'); });
  return { createdNotifications, staleMessageReads: () => staleMessageReads };
}

test('blocked alert for a new blocked message links and quotes that message', async () => {
  const database = stubBlockedAlertDatabase();
  await handleBlockedAlert({ id: 'job', name: 'blocked-alert', data: trigger, attempts: 0 });
  assert.equal(database.createdNotifications.length, 1);
  const notification = database.createdNotifications[0]!;
  assert.equal(notification.org_id, trigger.orgId);
  assert.equal(notification.user_id, 'lead');
  assert.equal(notification.link, '/chat?space=engineering-space&message=new-migration-blocker');
  assert.ok(notification.body.includes(`'${trigger.content}'`));
  assert.doesNotMatch(notification.body, /flaky test/);
  assert.equal(database.staleMessageReads(), 0, 'the supplied trigger must not be replaced by an older message');
});

test('blocked alert does not quote private space content to a lead without membership', async () => {
  const database = stubBlockedAlertDatabase(false);
  await handleBlockedAlert({ id: 'job', name: 'blocked-alert', data: trigger, attempts: 0 });
  assert.equal(database.createdNotifications.length, 0);
});
