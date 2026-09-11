import test from 'node:test';
import assert from 'node:assert/strict';
import { getSettingsNavGroups, isSettingsItemActive } from './settings-navigation';

test('members and guests see personal settings without admin destinations', () => {
  for (const role of ['member', 'guest'] as const) {
    const items = getSettingsNavGroups(role).flatMap((group) => group.items);
    assert.deepEqual(items.map((item) => item.href), ['/settings', '/settings/profile', '/settings/mcp-access', '/settings/calendar', '/license']);
  }
});

test('administrators get distinct personal, workspace and service connection destinations', () => {
  for (const role of ['owner', 'admin'] as const) {
    const groups = getSettingsNavGroups(role);
    const groupFor = (href: string) => groups.find((group) => group.items.some((item) => item.href === href));
    assert.equal(groupFor('/settings/mcp-access')?.label, 'Your account');
    assert.equal(groupFor('/settings/integrations')?.label, 'Agents & AI');
    assert.equal(groupFor('/settings/api-access')?.advanced, true);
    assert.equal(groupFor('/settings/modules')?.label, 'Workspace');
    assert.equal(groupFor('/settings/workflows')?.label, 'Work management');
    const hrefs = groups.flatMap((group) => group.items.map((item) => item.href));
    assert.equal(new Set(hrefs).size, hrefs.length);
  }
});

test('nested settings routes keep their parent navigation item active', () => {
  assert.equal(isSettingsItemActive('/settings/agent-employees/create', '/settings/agent-employees'), true);
  assert.equal(isSettingsItemActive('/settings/profile', '/settings'), false);
  assert.equal(isSettingsItemActive('/settings/agent-employees', '/settings/agent'), false);
});
