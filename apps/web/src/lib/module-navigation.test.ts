import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getModuleNavigationItems,
  isPrimaryNavigationItemActive,
  MODULE_SETTINGS_HREF,
  moduleAppHref,
} from './module-navigation';

const installations = [
  {
    slug: 'sales pipeline',
    enabled: true,
    manifest: { name: 'Sales', icon: 'briefcase' },
  },
  {
    slug: 'contacts',
    enabled: true,
    manifest: { name: 'Contacts', icon: 'users' },
  },
  {
    slug: 'payroll',
    enabled: false,
    manifest: { name: 'Payroll', icon: 'wallet' },
  },
];

test('enabled modules become stable first-class navigation items', () => {
  assert.deepEqual(getModuleNavigationItems(installations, 'member'), [
    { kind: 'module', name: 'Contacts', href: '/modules/contacts', icon: 'users' },
    { kind: 'module', name: 'Sales', href: '/modules/sales%20pipeline', icon: 'briefcase' },
  ]);
});

test('disabled modules and every module for guests are absent from navigation', () => {
  assert.equal(getModuleNavigationItems(installations, 'admin').some((item) => item.name === 'Payroll'), false);
  assert.deepEqual(getModuleNavigationItems(installations, 'guest'), []);
  assert.deepEqual(getModuleNavigationItems(installations, null), []);
});

test('module navigation uses exact route boundaries and settings owns administration', () => {
  assert.equal(MODULE_SETTINGS_HREF, '/settings/modules');
  assert.equal(moduleAppHref('crm/core'), '/modules/crm%2Fcore');
  assert.equal(isPrimaryNavigationItemActive('/modules/contacts/people/123', '/modules/contacts'), true);
  assert.equal(isPrimaryNavigationItemActive('/modules/contacts-plus', '/modules/contacts'), false);
});
