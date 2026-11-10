import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TRUST_READ_ONLY_NOTE,
  TRUST_SCOPE_NOTE,
  TrustLevelControl,
  canEditTrustLevel,
  saveTrustLevel,
} from './trust-level-control';

const noop = () => {};

function render(props: Partial<Parameters<typeof TrustLevelControl>[0]> = {}) {
  return renderToStaticMarkup(
    <TrustLevelControl value="standard" canEdit saving={false} onSelect={noop} {...props} />,
  );
}

function buttonTags(html: string): string[] {
  return html.match(/<button[^>]*>/g) ?? [];
}

const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('E02 only owners and admins can edit the trust level', () => {
  assert.equal(canEditTrustLevel('owner'), true);
  assert.equal(canEditTrustLevel('admin'), true);
  assert.equal(canEditTrustLevel('member'), false);
  assert.equal(canEditTrustLevel('guest'), false);
  assert.equal(canEditTrustLevel(undefined), false);
});

test('E02 owner sees enabled trust buttons and no read-only note', () => {
  const html = render({ canEdit: true });
  const buttons = buttonTags(html);
  assert.equal(buttons.length, 3);
  for (const b of buttons) assert.doesNotMatch(b, /disabled=""/);
  assert.ok(!html.includes(TRUST_READ_ONLY_NOTE));
  assert.match(html, /data-testid="trust-level-standard"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-testid="trust-level-standard"/);
});

test('E02 member sees disabled trust buttons with the reason', () => {
  const html = render({ canEdit: false });
  const buttons = buttonTags(html);
  assert.equal(buttons.length, 3);
  for (const b of buttons) assert.match(b, /disabled=""/);
  assert.ok(html.includes(TRUST_READ_ONLY_NOTE));
});

test('E02 a 403 from the server becomes a readable error, not a saved value', async () => {
  const result = await saveTrustLevel(
    async () => response(403, { error: 'Forbidden', code: 'FORBIDDEN' }),
    'autonomous',
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.includes('Only workspace owners and admins'));
  assert.ok(!result.ok && result.error.includes('not changed'));
});

test('E05 trust save: displayed value commits only after a 2xx response', async () => {
  const ok = await saveTrustLevel(async (path, body) => {
    assert.equal(path, '/api/agent/settings');
    assert.deepEqual(body, { trust_level: 'autonomous' });
    return response(200, { success: true, trust_level: 'autonomous' });
  }, 'autonomous');
  assert.deepEqual(ok, { ok: true, value: 'autonomous' });

  const serverError = await saveTrustLevel(async () => response(500, { error: 'boom' }), 'standard');
  assert.equal(serverError.ok, false);
  assert.ok(!serverError.ok && serverError.error.includes('boom'));

  const network = await saveTrustLevel(async () => {
    throw new TypeError('Failed to fetch');
  }, 'standard');
  assert.equal(network.ok, false);
  assert.ok(!network.ok && network.error.includes('Could not reach the server'));
});

test('E05 unknown trust level shows no selection and disables the buttons', () => {
  const loading = render({ value: null });
  assert.ok(!loading.includes('aria-checked="true"'));
  for (const b of buttonTags(loading)) assert.match(b, /disabled=""/);
  assert.ok(loading.includes('Loading current trust level'));

  const failed = render({ value: null, loadError: 'Could not load the current trust level.' });
  assert.ok(failed.includes('role="alert"'));
  assert.ok(failed.includes('Could not load the current trust level.'));
});

test('E05 a save error is rendered as an alert', () => {
  const html = render({ error: 'Could not save the trust level (HTTP 500). It was not changed.' });
  assert.match(html, /role="alert"[^>]*data-testid="trust-level-error"|data-testid="trust-level-error"[^>]*role="alert"/);
  assert.ok(html.includes('It was not changed.'));
});

test('E08 trust copy says chat is approval-only and scopes trust to background runs', () => {
  const html = render();
  assert.ok(html.includes(TRUST_SCOPE_NOTE));
  assert.match(TRUST_SCOPE_NOTE, /background and automation runs only/);
  assert.match(TRUST_SCOPE_NOTE, /in chat, every change it proposes waits for your approval/);
  assert.ok(!html.includes('All actions auto-execute except external writes'));
});
