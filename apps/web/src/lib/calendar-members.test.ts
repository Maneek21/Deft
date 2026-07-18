import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarMemberDisplayName, calendarMemberMatches } from './calendar-members';

test('calendar member search tolerates incomplete agent and system identities', () => {
  assert.equal(calendarMemberDisplayName({ name: null, email: 'defty@deft.local' }), 'defty');
  assert.equal(calendarMemberDisplayName({ name: null, email: null }), 'Unnamed member');
  assert.equal(calendarMemberMatches({ name: null, email: 'defty@deft.local' }, 'deft'), true);
  assert.equal(calendarMemberMatches({ name: null, email: null }, 'lina'), false);
});
