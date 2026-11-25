import assert from 'node:assert/strict';
import test from 'node:test';
import { pageTemplateFor } from './error-telemetry';

// The page goes to the server as its route template: every segment that is a
// dynamic param's value becomes ":name", whatever the value looks like.
test('dynamic segments become their names, static ones stay', () => {
  assert.equal(pageTemplateFor('/modules/billing', { slug: 'billing' }), '/modules/:slug');
  assert.equal(pageTemplateFor('/tasks/abc123', { id: 'abc123' }), '/tasks/:id');
  assert.equal(pageTemplateFor('/settings/agent-employees/emp-1/personality', { id: 'emp-1' }), '/settings/agent-employees/:id/personality');
  assert.equal(pageTemplateFor('/chat', {}), '/chat');
  assert.equal(pageTemplateFor('/chat', null), '/chat');
});

test('encoded values, catch-all params, queries and fragments', () => {
  assert.equal(pageTemplateFor('/notes/Board%20deck%20final', { id: 'Board deck final' }), '/notes/:id');
  assert.equal(pageTemplateFor('/docs/a/b/c', { path: ['a', 'b', 'c'] }), '/docs/:path/:path/:path');
  assert.equal(pageTemplateFor('/invite?token=x#setup=y', {}), '/invite');
});
