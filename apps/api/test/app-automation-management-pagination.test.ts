import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeAppAutomationManagementCursor,
  projectAppAutomationManagementEligibility,
  selectAppAutomationManagementPage,
} from '../src/lib/app-automation-management-service.js';

type Row = { id: string; app_installation_id: string; created_at: Date };

function olderRows(rows: readonly Row[], cursor: string | null, installationId: string): Row[] {
  const after = decodeAppAutomationManagementCursor(cursor ?? undefined, installationId);
  return rows.filter((row) => !after
    || row.created_at < after.created_at
    || (row.created_at.getTime() === after.created_at.getTime() && row.id < after.id));
}

test('management pagination reaches an old active schedule with equal timestamps and no duplicates', () => {
  const installationId = 'installation-a';
  const createdAt = new Date('2026-09-05T00:00:00.000Z');
  const rows = Array.from({ length: 101 }, (_, index) => ({
    id: String(1000 - index).padStart(4, '0'),
    app_installation_id: installationId,
    created_at: createdAt,
  }));

  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const result = selectAppAutomationManagementPage(olderRows(rows, cursor, installationId), 50);
    seen.push(...result.page.map((row) => row.id));
    cursor = result.next_cursor;
  } while (cursor);

  assert.deepEqual(seen, rows.map((row) => row.id));
  assert.equal(new Set(seen).size, 101);
});

test('management distinguishes known expiry and revocation from the delivery-time stale check', () => {
  const now = new Date('2026-09-05T12:00:00.000Z');
  const base = { valid_from: new Date('2026-09-01T00:00:00.000Z'), valid_until: new Date('2026-09-10T00:00:00.000Z') };
  assert.equal(projectAppAutomationManagementEligibility({ ...base, state: 'active' } as never, now, true).status, 'awaiting_delivery_check');
  assert.equal(projectAppAutomationManagementEligibility({ ...base, state: 'active', valid_until: now } as never, now, true).status, 'expired');
  assert.equal(projectAppAutomationManagementEligibility({ ...base, state: 'revoked' } as never, now, true).status, 'revoked');
  assert.equal(projectAppAutomationManagementEligibility({ ...base, state: 'active' } as never, now, false).status, 'delivery_disabled');
});

test('management cursor rejects malformed and cross-installation pages', () => {
  assert.throws(
    () => decodeAppAutomationManagementCursor('not-a-cursor', 'installation-a'),
    /Invalid App automation cursor/,
  );
  const cursor = selectAppAutomationManagementPage([{
    id: 'definition-2', app_installation_id: 'installation-a', created_at: new Date('2026-09-05T00:00:00.000Z'),
  }, {
    id: 'definition-1', app_installation_id: 'installation-a', created_at: new Date('2026-09-05T00:00:00.000Z'),
  }], 1).next_cursor;
  assert.ok(cursor);
  assert.throws(
    () => decodeAppAutomationManagementCursor(cursor ?? undefined, 'installation-b'),
    /Invalid App automation cursor/,
  );
});
