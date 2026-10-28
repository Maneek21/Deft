import assert from 'node:assert/strict';
import test from 'node:test';
import React, { type MouseEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isThreadlessChannelMessageDestination, navigateMessageLink, threadParamId } from './message-link-navigation';
import { ThreadMessageContent } from './thread-panel';

function clickLink(href: string, options: { event?: Partial<MouseEvent<HTMLElement>>; attributes?: Record<string, string>; inside?: boolean; hasAnchor?: boolean } = {}) {
  const attributes: Record<string, string> = { href, ...options.attributes };
  const anchor = {
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => Object.hasOwn(attributes, name),
  };
  let prevented = false;
  const navigated: string[] = [];
  const event = {
    button: 0, defaultPrevented: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    target: { closest: () => options.hasAnchor === false ? null : anchor },
    currentTarget: { contains: (candidate: unknown) => options.inside !== false && candidate === anchor },
    preventDefault: () => { prevented = true; },
    ...options.event,
  } as unknown as MouseEvent<HTMLElement>;
  navigateMessageLink(event, (destination) => navigated.push(destination));
  return { prevented, navigated };
}

test('plain clicks on in-app message and task links navigate client-side', () => {
  for (const href of ['/chat?space=s1&message=m1', '/tasks?task=DEFT-7']) {
    assert.deepEqual(clickLink(href), { prevented: true, navigated: [href] });
  }
  assert.deepEqual(clickLink('/tasks?task=DEFT-7', { attributes: { target: '_self' } }), { prevented: true, navigated: ['/tasks?task=DEFT-7'] });
});

test('modified and non-primary clicks retain native browser behavior', () => {
  for (const event of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }, { defaultPrevented: true }]) {
    assert.deepEqual(clickLink('/tasks?task=t1', { event }), { prevented: false, navigated: [] });
  }
});

test('external, protocol-relative, and unsafe destinations are never intercepted', () => {
  for (const href of ['https://example.com/tasks', 'http://example.com', 'mailto:person@example.com', '//example.com/tasks', '/\\example.com/tasks', '/tasks?task=a b', '/tasks\n?task=t1', 'javascript:alert(1)', '#message', 'tasks?task=t1', '']) {
    assert.deepEqual(clickLink(href), { prevented: false, navigated: [] }, href);
  }
});

test('downloads, targeted links, and anchors outside the message surface retain native behavior', () => {
  const linkAttributes: Array<Record<string, string>> = [{ download: '' }, { target: '_blank' }, { target: 'other-frame' }];
  for (const attributes of linkAttributes) {
    assert.deepEqual(clickLink('/tasks?task=t1', { attributes }), { prevented: false, navigated: [] });
  }
  assert.deepEqual(clickLink('/tasks?task=t1', { inside: false }), { prevented: false, navigated: [] });
  assert.deepEqual(clickLink('/tasks?task=t1', { hasAnchor: false }), { prevented: false, navigated: [] });
});

test('empty and whitespace thread params mean no thread', () => {
  for (const value of [null, undefined, '', '   ', '\n\t']) assert.equal(threadParamId(value), null, JSON.stringify(value));
  assert.equal(threadParamId('t1'), 't1');
  assert.equal(threadParamId('  t1  '), 't1');
});

test('only a message destination without a thread closes the thread panel', () => {
  const origin = 'https://deft.example';
  for (const href of [
    '/chat?space=s1&message=m2',
    '/chat?space=s1&message=m2&thread=',
    '/chat?space=s1&message=m2&thread=%20',
  ]) assert.equal(isThreadlessChannelMessageDestination(href, origin), true, href);
  for (const href of [
    '/chat?space=s1&message=m2&thread=t1',
    '/chat?space=s1',
    '/tasks?task=DEFT-7',
    'https://example.com/chat?space=s1&message=m2',
    '//example.com/chat?space=s1&message=m2',
  ]) assert.equal(isThreadlessChannelMessageDestination(href, origin), false, href);
});

test('Defty markdown renders verified relative message and task citations as links', () => {
  const html = renderToStaticMarkup(React.createElement(ThreadMessageContent, {
    content: '[source](/chat?space=s1&message=m1) and [task](/tasks?task=DEFT-7)',
    metadata: { is_agent_reply: true, citations: [
      { type: 'message', id: 'm1', title: 'Priya', url: '/chat?space=s1&message=m1' },
      { type: 'task', id: 'DEFT-7', title: 'Exact title', url: '/tasks?task=DEFT-7' },
    ] },
  }));
  assert.match(html, /<a\b[^>]*href="\/chat\?space=s1&amp;message=m1"/);
  assert.match(html, /<a\b[^>]*href="\/tasks\?task=DEFT-7"/);
});

test('Defty markdown keeps citation filtering for unverified and unsafe links', () => {
  const html = renderToStaticMarkup(React.createElement(ThreadMessageContent, {
    content: '[unverified](/tasks?task=unknown) and [unsafe](javascript:alert(1))',
    metadata: { is_agent_reply: true, citations: [] },
  }));
  assert.doesNotMatch(html, /href="\/tasks\?task=unknown"/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test('links inside editable message composers keep native editor behavior', () => {
  const anchor = { isContentEditable: true, getAttribute: (name: string) => name === 'href' ? '/tasks?task=t1' : null, hasAttribute: () => false };
  let prevented = false;
  const navigated: string[] = [];
  navigateMessageLink({
    button: 0, defaultPrevented: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    target: { closest: () => anchor }, currentTarget: { contains: () => true },
    preventDefault: () => { prevented = true; },
  } as unknown as MouseEvent<HTMLElement>, (href) => navigated.push(href));
  assert.equal(prevented, false);
  assert.deepEqual(navigated, []);
});
