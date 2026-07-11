import { strict as assert } from 'node:assert';
import test from 'node:test';
import { resolveSpaceTargetFromRows, type SpaceTargetRow } from '../src/lib/resolve-space-target.js';

function space(id: string, name: string, type = 'public'): SpaceTargetRow {
  return { id, name, type, is_archived: false };
}

test('space target resolution uses exact space names before fuzzy aliases', () => {
  const result = resolveSpaceTargetFromRows(
    [
      space('sales', 'sales'),
      space('internal', 'sales-internal'),
      space('leadership', 'sales-leadership'),
    ],
    { spaceName: 'sales' },
  );

  assert.equal(result.status, 'resolved');
  if (result.status === 'resolved') {
    assert.equal(result.space.id, 'sales');
  }
});

test('space target resolution allows a single unambiguous channel alias', () => {
  const result = resolveSpaceTargetFromRows(
    [
      space('buyers', 'sales-and-buyers'),
      space('marketing', 'marketing'),
    ],
    { spaceName: '#sales' },
  );

  assert.equal(result.status, 'resolved');
  if (result.status === 'resolved') {
    assert.equal(result.space.id, 'buyers');
  }
});

test('space target resolution refuses ambiguous channel aliases', () => {
  const result = resolveSpaceTargetFromRows(
    [
      space('internal', 'sales-internal'),
      space('leadership', 'sales-leadership'),
      space('buyers', 'sales-and-buyers'),
    ],
    { spaceName: 'sales' },
  );

  assert.equal(result.status, 'ambiguous');
  if (result.status === 'ambiguous') {
    assert.equal(result.matches.length, 3);
    assert.match(result.message, /Multiple spaces match "sales"/);
  }
});

test('space target resolution reports missing spaces', () => {
  const result = resolveSpaceTargetFromRows(
    [space('marketing', 'marketing')],
    { spaceName: 'sales' },
  );

  assert.equal(result.status, 'missing');
  assert.match(result.message, /not found/);
});
