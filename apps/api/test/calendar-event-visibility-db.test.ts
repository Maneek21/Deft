import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { agentEmployees, connectedAccounts, events, orgMembers, orgs, users } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import { eventsQuery } from '../src/lib/mcp-tools/events.js';
import { humanCalendarList } from '../src/lib/mcp-tools/human.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target === process.env.DATABASE_URL && target !== undefined
  && new URL(target).hostname === '127.0.0.1' && new URL(target).port === '55435'
  && /^\/gate_g_phase5_test_c03b_(?:public|root)(?:_v[0-9]+)?$/.test(new URL(target).pathname);
const eventTime = new Date('2037-06-15T12:00:00.000Z');
const range = { from: '2037-06-14T00:00:00.000Z', until: '2037-06-17T00:00:00.000Z' };

function rowIds(result: { content: Array<{ text: string }>; isError?: boolean }): Set<string> {
  assert.equal(result.isError, false);
  return new Set((JSON.parse(result.content[0]!.text) as Array<{ id: string }>).map(row => row.id));
}

test('calendar events enforce live owner custody for human, employee MCP and native agent reads',
  { skip: !safe }, async () => {
    const marker = randomUUID();
    const orgId = randomUUID();
    const foreignOrgId = randomUUID();
    const ownerId = randomUUID();
    const peerId = randomUUID();
    const employeeUserId = randomUUID();
    const employeeId = randomUUID();
    const accountId = randomUUID();
    const ids = { owner: randomUUID(), peerNative: randomUUID(), peerIcs: randomUUID(),
      peerConnected: randomUUID(), employee: randomUUID(), foreign: randomUUID() };
    const names = { owner: `${marker}-owner`, peerNative: `${marker}-peer-native`,
      peerIcs: `${marker}-peer-ics`, peerConnected: `${marker}-peer-connected`,
      employee: `${marker}-employee`, foreign: `${marker}-foreign` };
    try {
      await db.insert(orgs).values([
        { id: orgId, name: 'Calendar visibility fixture', slug: `${marker}-org` },
        { id: foreignOrgId, name: 'Foreign calendar fixture', slug: `${marker}-foreign-org` },
      ]);
      await db.insert(users).values([
        { id: ownerId, email: `${marker}-owner@example.test`, name: 'Owner' },
        { id: peerId, email: `${marker}-peer@example.test`, name: 'Peer' },
        { id: employeeUserId, email: `${marker}-employee@example.test`, name: 'Employee' },
      ]);
      await db.insert(orgMembers).values([ownerId, peerId, employeeUserId].map(userId => ({
        id: randomUUID(), org_id: orgId, user_id: userId, role: 'member' as const,
      })));
      await db.insert(agentEmployees).values({ id: employeeId, org_id: orgId,
        user_id: employeeUserId, name: 'Calendar test employee', slug: `${marker}-agent`,
        role: 'custom', system_prompt: 'Synthetic calendar ACL test', created_by: ownerId });
      await db.insert(connectedAccounts).values({ id: accountId, org_id: orgId,
        user_id: peerId, provider: 'google_calendar',
        provider_account_id: `${marker}-account`, access_token_encrypted: 'synthetic-test-only' });
      const event = (id: string, eventOrgId: string, source: 'native' | 'ics' | 'google_calendar',
        title: string, userId: string | null, connectedId: string | null = null) => ({
        id, org_id: eventOrgId, source, event_type: 'calendar_event', title,
        body: 'Synthetic private content', timestamp: eventTime,
        metadata: { start: eventTime.toISOString(), end: new Date(eventTime.getTime() + 3600_000).toISOString() },
        user_id: userId, connected_account_id: connectedId,
      });
      await db.insert(events).values([
        event(ids.owner, orgId, 'native', names.owner, ownerId),
        event(ids.peerNative, orgId, 'native', names.peerNative, peerId),
        event(ids.peerIcs, orgId, 'ics', names.peerIcs, peerId),
        event(ids.peerConnected, orgId, 'google_calendar', names.peerConnected, null, accountId),
        event(ids.employee, orgId, 'native', names.employee, employeeUserId),
        event(ids.foreign, foreignOrgId, 'native', names.foreign, null),
      ]);

      const owner = rowIds(await humanCalendarList(range, { org_id: orgId, user_id: ownerId,
        role: 'member', scopes: ['read:calendar'] }));
      const unscoped = await humanCalendarList(range, { org_id: orgId, user_id: ownerId,
        role: 'member', scopes: [] });
      assert.equal(unscoped.isError, true);
      const peer = rowIds(await humanCalendarList(range, { org_id: orgId, user_id: peerId,
        role: 'member', scopes: ['read:calendar'] }));
      assert.equal(owner.has(ids.owner), true);
      for (const id of [ids.peerNative, ids.peerIcs, ids.peerConnected, ids.employee]) {
        assert.equal(owner.has(id), false);
      }
      for (const id of [ids.peerNative, ids.peerIcs, ids.peerConnected]) assert.equal(peer.has(id), true);
      assert.equal(peer.has(ids.owner), false);

      const employeeContext = { org_id: orgId, employee_id: employeeId,
        employee_slug: `${marker}-agent`, trust_level: 'standard' as const };
      const employee = rowIds(await eventsQuery({ caller_employee_slug: 'forged-other-employee',
        type: 'calendar_event', limit: 200 }, employeeContext));
      assert.equal(employee.has(ids.employee), true);
      for (const id of [ids.owner, ids.peerNative, ids.peerIcs, ids.peerConnected, ids.foreign]) {
        assert.equal(employee.has(id), false);
      }
      const employeeNative = await executeToolCall('check_calendar', { date: '2037-06-15' },
        orgId, ownerId, undefined, employeeId);
      const employeeTitles = new Set((employeeNative.result as Array<{ title: string }>).map(row => row.title));
      assert.equal(employeeTitles.has(names.employee), true);
      for (const name of [names.owner, names.peerNative, names.peerIcs, names.peerConnected, names.foreign]) {
        assert.equal(employeeTitles.has(name), false);
      }
      const ownerNative = await executeToolCall('check_calendar', { date: '2037-06-15' }, orgId, ownerId);
      const ownerTitles = new Set((ownerNative.result as Array<{ title: string }>).map(row => row.title));
      assert.equal(ownerTitles.has(names.owner), true);
      assert.equal(ownerTitles.has(names.peerNative), false);

      await db.update(agentEmployees).set({ is_active: false }).where(eq(agentEmployees.id, employeeId));
      assert.equal(rowIds(await eventsQuery({ caller_employee_slug: `${marker}-agent` }, employeeContext))
        .has(ids.employee), false);
      await db.update(agentEmployees).set({ is_active: true }).where(eq(agentEmployees.id, employeeId));
      await db.update(orgMembers).set({ is_active: false }).where(and(
        eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, employeeUserId)));
      assert.equal(rowIds(await eventsQuery({ caller_employee_slug: `${marker}-agent` }, employeeContext))
        .has(ids.employee), false);
      await db.update(orgMembers).set({ is_active: false }).where(and(
        eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, ownerId)));
      const revokedNative = await executeToolCall('check_calendar', { date: '2037-06-15' }, orgId, ownerId);
      assert.equal((revokedNative.result as Array<{ title: string }>).some(row => row.title === names.owner), false);
    } finally {
      await db.delete(events).where(inArray(events.id, Object.values(ids)));
      await db.delete(connectedAccounts).where(eq(connectedAccounts.id, accountId));
      await db.delete(agentEmployees).where(eq(agentEmployees.id, employeeId));
      await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
      await db.delete(users).where(inArray(users.id, [ownerId, peerId, employeeUserId]));
      await db.delete(orgs).where(inArray(orgs.id, [orgId, foreignOrgId]));
    }
  });
