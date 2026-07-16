import test from 'node:test';
import assert from 'node:assert/strict';
import { getSettingsNavGroups, isSettingsItemActive } from './settings-navigation';

test('members see only personal workspace and personal connection settings', () => {
  const items = getSettingsNavGroups('member').flatMap((group) => group.items);
  assert.deepEqual(items.map((item) => item.name), ['General', 'Profile', 'Calendar', 'Connections']);
  assert.equal(items.some((item) => item.href === '/settings/api-access'), false);
});

test('owners get seven primary destinations and specialist controls under Advanced', () => {
  const groups = getSettingsNavGroups('owner');
  const primary = groups.filter((group) => !group.advanced).flatMap((group) => group.items);
  const advanced = groups.find((group) => group.advanced);

  assert.equal(primary.length, 7);
  assert.ok(advanced);
  assert.ok(advanced.items.some((item) => item.name === 'Mention groups'));
  assert.ok(advanced.items.some((item) => item.name === 'API access'));
});

test('nested settings routes keep their parent navigation item active', () => {
  assert.equal(isSettingsItemActive('/settings/agent-employees/create', '/settings/agent-employees'), true);
  assert.equal(isSettingsItemActive('/settings/profile', '/settings'), false);
});
