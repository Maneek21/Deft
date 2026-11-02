import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultIntegrationOperations, IntegrationAccessSettings } from './integration-access-settings';

test('a fresh Defty delegation defaults to read-only, while other principals start empty', () => {
  assert.deepEqual(defaultIntegrationOperations('defty:00000000-0000-4000-8000-000000000001'), ['read']);
  assert.deepEqual(defaultIntegrationOperations('personal_mcp:00000000-0000-4000-8000-000000000001'), []);
});

test('the settings surface never invents a principal or permission before a real account is reviewed', () => {
  const html = renderToStaticMarkup(<IntegrationAccessSettings
    account={{ installation_id: '00000000-0000-4000-8000-000000000001', account_ref: 'account_1', store_key: 'drafts' }}
    current={() => true} signal={new AbortController().signal} />);
  assert.match(html, /aria-label="Account automation permissions"/);
  assert.match(html, /Choose recipient/);
  assert.doesNotMatch(html, /Send always requires review/);
});
