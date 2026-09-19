import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentCitations, resolveAgentCitationLink } from './agent-citations';
import { formatChatInline } from './chat-links';

test('agent record links resolve only to an exact canonical source, without trusting an invented host', () => {
  const citations = [{ type: 'module_record', id: 'one', title: 'Company', url: '/modules/contacts/companies/one' }];
  assert.equal(resolveAgentCitationLink('https://deft.com/modules/contacts/companies/one', citations), citations[0].url);
  assert.equal(resolveAgentCitationLink('./modules/contacts/companies/one', citations), citations[0].url);
  assert.equal(resolveAgentCitationLink('/modules/contacts/companies/denied', citations), null);
  assert.equal(resolveAgentCitationLink('https://deft.com/modules/contacts/companies/denied', citations), null);
  assert.equal(resolveAgentCitationLink('https://example.com/docs', citations), 'https://example.com/docs');
  assert.equal(resolveAgentCitationLink('https://evil.test/modules/contacts/companies/one?redirect=evil', citations), null);
  assert.equal(resolveAgentCitationLink('javascript:alert', citations), null);
  const html = formatChatInline('[Company](https://deft.com/modules/contacts/companies/one) [Unreturned](https://deft.com/modules/contacts/companies/denied)', href => resolveAgentCitationLink(href, citations));
  assert.match(html, /href="\/modules\/contacts\/companies\/one"/);
  assert.doesNotMatch(html, /deft.com|companies\/denied/);
});

test('normalizes authority-filtered citations into a deduplicated Sources footer', () => {
  const sources = normalizeAgentCitations([
    { type: 'module_record', id: 'module_record:company-1', title: 'Maple Haven QA', url: '/modules/contacts/companies/company-1' },
    { type: 'module_record', id: 'module_record:company-1', title: 'Maple Haven QA duplicate', url: '/modules/contacts/companies/company-1' },
    { type: 'task', id: '11111111-1111-4111-8111-111111111111', title: 'CFRV-7: Follow up' },
    { type: 'wiki', id: 'wiki-1', title: 'Visible but not linkable' },
    { type: 'mcp', id: 'provider-1', title: 'Private provider metadata', url: '/modules/contacts' },
  ]);

  assert.deepEqual(sources, [
    { id: 'module_record:company-1', title: 'Maple Haven QA', href: '/modules/contacts/companies/company-1' },
    { id: '11111111-1111-4111-8111-111111111111', title: 'CFRV-7: Follow up', href: '/tasks?task=11111111-1111-4111-8111-111111111111' },
    { id: 'wiki-1', title: 'Visible but not linkable', href: null },
  ]);
});

test('preserves safe root-relative citations while rejecting model-relative and unsafe destinations', () => {
  const sources = normalizeAgentCitations([
    { type: 'module_record', id: 'relative', title: 'Relative model link', url: './modules/contacts/companies/1' },
    { type: 'module_record', id: 'protocol', title: 'Protocol relative', url: '//evil.test/modules/contacts' },
    { type: 'module_record', id: 'settings', title: 'Unrelated local route', url: '/settings/ai' },
    { type: 'module', id: 'queue', title: 'Follow-up queue', url: '/modules/contacts?workspace=follow-ups' },
    { type: 'module', id: 'bad-query', title: 'Bad query', url: '/modules/contacts?workspace=follow-ups&redirect=evil' },
    { type: 'task', id: 'task-1', title: 'Task', url: '/tasks?task=CRM-7' },
  ]);

  assert.deepEqual(sources.map(({ id, href }) => ({ id, href })), [
    { id: 'relative', href: null },
    { id: 'protocol', href: null },
    { id: 'settings', href: '/settings/ai' },
    { id: 'queue', href: '/modules/contacts?workspace=follow-ups' },
    { id: 'bad-query', href: '/modules/contacts?workspace=follow-ups&redirect=evil' },
    { id: 'task-1', href: '/tasks?task=CRM-7' },
  ]);
});

test('preserves generic canonical local citations and only applies the legacy comma filter to messages', () => {
  const sources = normalizeAgentCitations([
    { type: 'wiki', id: 'wiki-1', title: 'Account policy', url: '/knowledge?slug=account-policy' },
    { type: 'message', id: 'message-1', title: '#crm - Diego', url: '/chat?space=space-1&message=message-1' },
    { type: 'event', id: 'event-1', title: 'Account review', url: '/calendar?date=2026-09-17' },
    { type: 'module_record', id: 'module_record:1', title: 'Acme, Inc.', url: '/modules/contacts/companies/1' },
    { type: 'message', id: 'dm-1', title: 'Maneek, Rahul', url: '/chat?space=dm-1&message=dm-message' },
  ]);

  assert.deepEqual(sources.map(({ title, href }) => ({ title, href })), [
    { title: 'Account policy', href: '/knowledge?slug=account-policy' },
    { title: '#crm - Diego', href: '/chat?space=space-1&message=message-1' },
    { title: 'Account review', href: '/calendar?date=2026-09-17' },
    { title: 'Acme, Inc.', href: '/modules/contacts/companies/1' },
  ]);
});
