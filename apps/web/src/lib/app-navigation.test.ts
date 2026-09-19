import assert from 'node:assert/strict';
import test from 'node:test';
import { appNavigationHref, appNavigationLinkKey, getAppNavigationItems, getAppNavigationModuleOwner, getVisibleModuleNavigationItems, isAppNavigationGroupActive, isAppNavigationLinkActive } from './app-navigation';

test('active App navigation resolves only to host-rendered Module routes', () => {
  const item = { app_installation_id: 'install-1', app_id: 'app-1', app_name: 'Hello App', label: 'Greetings', module_slug: 'hello workspace', collection_key: 'greetings', view_key: 'all' };
  assert.equal(appNavigationHref(item), '/modules/hello%20workspace/greetings?view=all');
  assert.deepEqual(getAppNavigationItems([item])[0], {
    kind: 'app', name: 'Hello App', href: '/modules/hello%20workspace/greetings?view=all', icon: null,
    installationId: 'install-1', links: [{ ...item, href: '/modules/hello%20workspace/greetings?view=all' }],
  });
  const link = getAppNavigationItems([item])[0]!.links[0]!;
  assert.equal(isAppNavigationLinkActive('/modules/hello%20workspace/greetings', link), true);
  assert.equal(isAppNavigationGroupActive('/modules/hello%20workspace/greetings', getAppNavigationItems([item])[0]!, getAppNavigationItems([item])), true);
});

test('App navigation preserves the collection fallback when no view is declared', () => {
  const item = { app_installation_id: 'install-1', app_id: 'app-1', app_name: 'Hello App', label: 'Greetings', module_slug: 'hello', collection_key: 'greetings' };
  assert.equal(appNavigationHref(item), '/modules/hello/greetings');
});

test('App navigation selects only the authored link for the current collection view', () => {
  const links = getAppNavigationItems([
    { app_installation_id: 'install-1', app_id: 'app-1', app_name: 'Pipeline App', label: 'Table', module_slug: 'sales', collection_key: 'deals', view_key: 'table' },
    { app_installation_id: 'install-1', app_id: 'app-1', app_name: 'Pipeline App', label: 'Pipeline', module_slug: 'sales', collection_key: 'deals', view_key: 'pipeline' },
  ])[0]!.links;
  assert.equal(isAppNavigationLinkActive('/modules/sales/deals', links[0]!, 'pipeline'), false);
  assert.equal(isAppNavigationLinkActive('/modules/sales/deals', links[1]!, 'pipeline'), true);
  assert.equal(isAppNavigationLinkActive('/modules/sales/deals/record-1', links[0]!), true);
});

test('App navigation groups one installation and stays conservative for shared routes', () => {
  const items = getAppNavigationItems([
    { app_installation_id: 'install-1', app_id: 'app-1', app_name: 'First', label: 'Contacts', module_slug: 'shared', collection_key: 'contacts' },
    { app_installation_id: 'install-1', app_id: 'app-1', app_name: 'First', label: 'Deals', module_slug: 'shared', collection_key: 'deals' },
    { app_installation_id: 'install-2', app_id: 'app-2', app_name: 'Second', label: 'Contacts', module_slug: 'shared', collection_key: 'contacts' },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.links.length, 2);
  assert.equal(isAppNavigationGroupActive('/modules/shared/contacts', items[0]!, items), false);
});

test('App links use declared order and collision-safe secondary keys', () => {
  const [group] = getAppNavigationItems([
    { app_installation_id: 'install-1', app_id: 'app-1', app_name: 'Ordered', label: 'Later', module_slug: 'second', collection_key: 'same', key: 'later', navigation_order: 4 },
    { app_installation_id: 'install-1', app_id: 'app-1', app_name: 'Ordered', label: 'First', module_slug: 'first', collection_key: 'same', key: 'first', navigation_order: 0 },
  ]);
  assert.equal(group?.links[0]?.label, 'First');
  assert.equal(group?.href, '/modules/first/same');
  assert.notEqual(appNavigationLinkKey(group!.links[0]!), appNavigationLinkKey(group!.links[1]!));
});

test('Module/App composition preserves unowned and shared modules, hides singly-owned modules only when authoritative', () => {
  const modules = [{ href: '/modules/unowned' }, { href: '/modules/single' }, { href: '/modules/shared' }];
  const apps = [
    { app_installation_id: 'a1', app_id: 'a', app_name: 'A', label: 'Single', module_slug: 'single', collection_key: 'home' },
    { app_installation_id: 'a1', app_id: 'a', app_name: 'A', label: 'Shared A', module_slug: 'shared', collection_key: 'home' },
    { app_installation_id: 'a2', app_id: 'b', app_name: 'B', label: 'Shared B', module_slug: 'shared', collection_key: 'home' },
  ];
  assert.deepEqual(getVisibleModuleNavigationItems(modules, apps, true).map((item) => item.href), ['/modules/unowned', '/modules/shared']);
  assert.deepEqual(getVisibleModuleNavigationItems(modules, apps, false).map((item) => item.href), modules.map((item) => item.href));
  assert.deepEqual(getVisibleModuleNavigationItems(modules, [], true).map((item) => item.href), modules.map((item) => item.href));
});

test('App active state covers root/detail boundaries and ambiguous shared routes', () => {
  const [first, second] = getAppNavigationItems([
    { app_installation_id: 'a1', app_id: 'a', app_name: 'A', label: 'Home', module_slug: 'shared', collection_key: 'home' },
    { app_installation_id: 'a2', app_id: 'b', app_name: 'B', label: 'Home', module_slug: 'shared', collection_key: 'home' },
  ]);
  assert.equal(isAppNavigationGroupActive('/modules/shared/home/detail', first!, [first!]), true);
  assert.equal(isAppNavigationGroupActive('/modules/shared/home-other', first!, [first!]), false);
  assert.equal(isAppNavigationGroupActive('/modules/shared/home', first!, [first!, second!]), false);
});

test('a singly owned module root keeps its App context for generic module workspaces', () => {
  const groups = getAppNavigationItems([
    { app_installation_id: 'crm', app_id: 'crm-app', app_name: 'CRM', label: 'Contacts', module_slug: 'relationships', collection_key: 'contacts' },
    { app_installation_id: 'crm', app_id: 'crm-app', app_name: 'CRM', label: 'Deals', module_slug: 'relationships', collection_key: 'deals' },
  ]);
  assert.equal(getAppNavigationModuleOwner('relationships', groups)?.installationId, 'crm');
  assert.equal(getAppNavigationModuleOwner('relationships', groups)?.name, 'CRM');
  assert.equal(isAppNavigationGroupActive('/modules/relationships', groups[0]!, groups), true);
});

test('a shared module root does not claim either App owner', () => {
  const groups = getAppNavigationItems([
    { app_installation_id: 'first', app_id: 'first-app', app_name: 'First', label: 'Home', module_slug: 'shared', collection_key: 'first' },
    { app_installation_id: 'second', app_id: 'second-app', app_name: 'Second', label: 'Home', module_slug: 'shared', collection_key: 'second' },
  ]);
  assert.equal(getAppNavigationModuleOwner('shared', groups), null);
  assert.equal(isAppNavigationGroupActive('/modules/shared', groups[0]!, groups), false);
  assert.equal(isAppNavigationGroupActive('/modules/shared', groups[1]!, groups), false);
});
