import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleSearchNotice } from './module-search-notice';

test('a failed module branch is distinct from an empty successful search without leaking errors', () => {
  assert.equal(moduleSearchNotice({ modules: [], search_diagnostics: { modules: { status: 'ready' } } }), null);
  assert.match(moduleSearchNotice({ modules: [], search_diagnostics: { modules: { status: 'unavailable', message: 'private database error' } } })!, /could not be searched/);
  assert.match(moduleSearchNotice({ modules: [], search_diagnostics: { modules: { status: 'forbidden' } } })!, /do not have access/);
  assert.equal(moduleSearchNotice({ modules: [] }), null);
  assert.equal(moduleSearchNotice({ search_diagnostics: { modules: { status: 'private database error' } } }), null);
});
