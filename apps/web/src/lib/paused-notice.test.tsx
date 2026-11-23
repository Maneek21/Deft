import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Socket } from 'socket.io-client';
import { PausedBanner } from '../components/paused-banner';
import {
  calmPausedRefusal,
  PAUSED_BANNER_TEXT,
  PAUSED_READ_MESSAGE,
  PAUSED_REFUSED_EVENT,
  PAUSED_WRITE_MESSAGE,
  parsePausedNotice,
} from './paused-notice';
import { prepareSocketForUse, stopIfPaused } from './socket';

const render = (props: Parameters<typeof PausedBanner>[0]) => renderToStaticMarkup(createElement(PausedBanner, props));

test('billing: the banner says payment is overdue, what still works and who can restore it', () => {
  const html = render({ notice: { reason: 'billing' } });
  assert.match(html, /role="region" aria-label="Workspace paused"/);
  assert.match(html, /This workspace is paused because a payment is overdue\. You can read everything, but nothing can be changed, and AI, notifications and live updates are off\. The workspace owner can restore it by paying the outstanding invoice\./);
  assert.doesNotMatch(html, /restore\b(?! it)|<a\b/);
});

test('restore review: the banner says the workspace is being checked', () => {
  const html = render({ notice: { reason: 'restore_review' } });
  assert.match(html, /This workspace is being checked after a restore\. You can read everything, but nothing can be changed yet\./);
  assert.doesNotMatch(html, /payment|invoice|<a\b/);
});

test('emergency stop: the banner says outgoing activity is stopped, what still works and that nothing scheduled is lost', () => {
  const html = render({ notice: { reason: 'emergency_stop' } });
  assert.match(html, /data-paused-reason="emergency_stop"/);
  assert.match(html, /Outgoing activity in this workspace is stopped while a problem is looked into\. You can sign in and read everything, but nothing can be changed, and link previews, email, notifications and AI are off\. Nothing scheduled is lost: it goes out once the stop is lifted\./);
  assert.doesNotMatch(html, /payment|invoice|restore|<a\b/);
});

test('not paused: no banner at all', () => {
  assert.equal(render({ notice: null }), '');
});

test('absent means not paused; an unknown reason still shows the neutral notice', () => {
  assert.equal(parsePausedNotice(undefined), null);
  assert.equal(parsePausedNotice(null), null);
  assert.deepEqual(parsePausedNotice({ reason: 'billing' }), { reason: 'billing' });
  assert.deepEqual(parsePausedNotice({ reason: 'restore_review' }), { reason: 'restore_review' });
  assert.deepEqual(parsePausedNotice({ reason: 'emergency_stop' }), { reason: 'emergency_stop' });
  assert.deepEqual(parsePausedNotice({ reason: 'something-new' }), { reason: 'restore_review' });
  assert.equal(PAUSED_BANNER_TEXT.billing.includes('http'), false);
});

function withWindowEvents(run: (events: string[]) => Promise<void>) {
  const target = new EventTarget();
  const events: string[] = [];
  target.addEventListener(PAUSED_REFUSED_EVENT, (event) => events.push(event.type));
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = target;
  return run(events).finally(() => { (globalThis as { window?: unknown }).window = previous; });
}

test('a 503 PAUSED write is reported and its body replaced by the calm message', () => withWindowEvents(async (events) => {
  const refused = new Response(JSON.stringify({ error: 'This Deft install started paused: …DEFT_PAUSED_START', code: 'PAUSED' }), { status: 503 });
  const calmed = await calmPausedRefusal(refused, 'post');
  assert.equal(calmed.status, 503);
  assert.deepEqual(await calmed.json(), { error: PAUSED_WRITE_MESSAGE, code: 'PAUSED' });
  assert.deepEqual(events, [PAUSED_REFUSED_EVENT]);
}));

test('a 503 PAUSED read gets the read wording', () => withWindowEvents(async (events) => {
  const calmed = await calmPausedRefusal(new Response(JSON.stringify({ code: 'PAUSED', error: 'x' }), { status: 503 }), 'GET');
  assert.deepEqual(await calmed.json(), { error: PAUSED_READ_MESSAGE, code: 'PAUSED' });
  assert.deepEqual(events, [PAUSED_REFUSED_EVENT]);
}));

test('every other response passes through untouched', () => withWindowEvents(async (events) => {
  for (const response of [
    new Response('{"ok":true}', { status: 200 }),
    new Response(JSON.stringify({ code: 'DATABASE_UNAVAILABLE', error: 'Database unavailable' }), { status: 503 }),
    new Response('not json', { status: 503 }),
  ]) {
    assert.equal(await calmPausedRefusal(response, 'POST'), response);
  }
  assert.deepEqual(events, []);
}));

test('realtime refused as PAUSED stops reconnecting and later uses do not restart it', () => withWindowEvents(async (events) => {
  let disconnects = 0;
  let connects = 0;
  const socket = {
    active: false,
    auth: {},
    connect() { connects += 1; return socket; },
    disconnect() { disconnects += 1; return socket; },
  } as unknown as Socket;
  assert.equal(stopIfPaused(socket, 'Invalid token'), false);
  assert.equal(disconnects, 0);
  assert.equal(stopIfPaused(socket, 'PAUSED'), true);
  assert.equal(disconnects, 1);
  assert.deepEqual(events, [PAUSED_REFUSED_EVENT]);
  prepareSocketForUse(socket, 'fresh');
  assert.equal(connects, 0);
}));
