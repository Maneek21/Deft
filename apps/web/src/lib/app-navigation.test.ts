import assert from 'node:assert/strict';
import test from 'node:test';
import { appNavigationHref, getAppNavigationItems } from './app-navigation';

test('active App navigation resolves only to host-rendered Module routes', () => {
  const item = { label: 'Greetings', module_slug: 'hello workspace', collection_key: 'greetings' };
  assert.equal(appNavigationHref(item), '/modules/hello%20workspace/greetings');
  assert.deepEqual(getAppNavigationItems([item]), [{
    kind: 'app',
    name: 'Greetings',
    href: '/modules/hello%20workspace/greetings',
    icon: null,
  }]);
});
