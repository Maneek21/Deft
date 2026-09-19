import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { shouldLinkifyTaskReferences, ThreadMessageContent } from './thread-panel';

test('actual threaded message consumer renders canonical Sources from metadata', () => {
  const html = renderToStaticMarkup(<ThreadMessageContent
    content=""
    metadata={{ is_agent_reply: true, citations: [
      { type: 'module_record', id: 'one', title: 'Fictional company', url: '/modules/example/companies/one' },
      { type: 'wiki', id: 'wiki', title: 'Reference', url: '/knowledge?slug=reference' },
      { type: 'mcp', id: 'hidden', title: 'Provider secret', url: '/modules/example/companies/hidden' },
    ] }}
  />);
  assert.match(html, /aria-label="Sources"/);
  assert.match(html, /href="\/modules\/example\/companies\/one"/);
  assert.match(html, /href="\/knowledge\?slug=reference"/);
  assert.doesNotMatch(html, /https:\/\/deft.com|companies\/two|Provider secret|companies\/hidden/);
});

test('ordinary messages without metadata do not invent Sources', () => {
  const html = renderToStaticMarkup(<ThreadMessageContent content="" />);
  assert.doesNotMatch(html, /aria-label="Sources"/);
});

test('agent bare task references stay plain while canonical Sources remain linked', () => {
  assert.equal(shouldLinkifyTaskReferences({ is_agent_reply: true }), false);
  assert.equal(shouldLinkifyTaskReferences(undefined), true);
  const html = renderToStaticMarkup(<ThreadMessageContent
    content=""
    metadata={{ is_agent_reply: true, citations: [
      { type: 'task', id: 'CRM-999', title: 'Verified follow-up', url: '/tasks?task=CRM-999' },
    ] }}
  />);
  assert.match(html, /aria-label="Sources"/);
  assert.match(html, /href="\/tasks\?task=CRM-999"/);
});
