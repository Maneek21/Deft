import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExperienceSettings } from './experience-settings';

const account = { key: 'primary', label: 'Primary account', statusLabel: 'Connected' };
const render = (props: Partial<Parameters<typeof ExperienceSettings>[0]> = {}) => renderToStaticMarkup(
  <ExperienceSettings experienceLabel="App" onBack={() => {}} accounts={[account]} selectedAccountKey="primary"
    access={{ state: 'active' }} {...props} />);

test('active private access alone cannot claim background sync is active', () => {
  const html = render();
  assert.doesNotMatch(html, /Everything is healthy/);
  assert.doesNotMatch(html, /background sync are active/);
});

test('connected account with a healthy background lease reports everything healthy', () => {
  const html = render({ accountHealth: [{ key: 'primary', connection: 'connected', background: { state: 'healthy', since: '2026-11-04T00:00:00.000Z', reason: 'live' } }] });
  assert.match(html, /Everything is healthy · Private access and background sync are active\./);
});

test('connected account with a paused background lease says paused, never healthy', () => {
  const html = render({ accountHealth: [{ key: 'primary', connection: 'connected', background: { state: 'paused', since: '2026-11-04T00:00:00.000Z', reason: 'lapsed' } }] });
  assert.match(html, /Background sync is paused/);
  assert.doesNotMatch(html, /Everything is healthy/);
  assert.doesNotMatch(html, /background sync are active/);
});

test('connected account with no background lease says background sync is off', () => {
  const html = render({ accountHealth: [{ key: 'primary', connection: 'connected' }] });
  assert.match(html, /Background sync is off/);
  assert.doesNotMatch(html, /Everything is healthy/);
  assert.doesNotMatch(html, /background sync are active/);
});

test('a disconnected account is never healthy even with a healthy-looking lease', () => {
  const html = render({ accountHealth: [{ key: 'primary', connection: 'disconnected', background: { state: 'healthy', since: '2026-11-04T00:00:00.000Z', reason: 'live' } }] });
  assert.doesNotMatch(html, /Everything is healthy/);
  assert.doesNotMatch(html, /background sync are active/);
});
