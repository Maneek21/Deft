import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AUTONOMOUS_EMPLOYEE_CONFIRM,
  TRUST_CHAT_NOTE,
  TRUST_CONNECTED_NOTE,
  TRUST_EMPLOYEE_NOTE,
  TRUST_LEVELS,
  TRUST_READ_ONLY_NOTE,
  TRUST_SCOPE_NOTE,
  TrustLevelControl,
  canEditTrustLevel,
  createGenerationGuard,
  loadTrustLevel,
  saveTrustLevel,
  saveTrustLevelAndReconcile,
  type TrustViewPatch,
} from './trust-level-control';

const noop = () => {};

function render(props: Partial<Parameters<typeof TrustLevelControl>[0]> = {}) {
  return renderToStaticMarkup(
    <TrustLevelControl value="standard" canEdit saving={false} onSelect={noop} {...props} />,
  );
}

function radioTags(html: string): string[] {
  return html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
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
  const radios = radioTags(html);
  assert.equal(radios.length, 3);
  for (const b of radios) assert.doesNotMatch(b, /disabled=""/);
  assert.ok(!html.includes(TRUST_READ_ONLY_NOTE));
  const standard = radios.find((r) => r.includes('data-testid="trust-level-standard"'));
  assert.ok(standard && /checked=""/.test(standard));
});

test('E02 member sees disabled trust buttons with the reason', () => {
  const html = render({ canEdit: false });
  const radios = radioTags(html);
  assert.equal(radios.length, 3);
  for (const b of radios) assert.match(b, /disabled=""/);
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
  assert.ok(!serverError.ok && serverError.outcome === 'unknown');

  const network = await saveTrustLevel(async () => {
    throw new TypeError('Failed to fetch');
  }, 'standard');
  assert.equal(network.ok, false);
  assert.ok(!network.ok && network.error.includes('Could not reach the server'));
});

test('E05 unknown trust level shows no selection and disables the buttons', () => {
  const loading = render({ value: null });
  assert.ok(!radioTags(loading).some((r) => /checked=""/.test(r)));
  for (const b of radioTags(loading)) assert.match(b, /disabled=""/);
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

test('E08 trust copy scopes trust to approved plans and keeps chat out', () => {
  const html = render();
  assert.ok(html.includes(escapeHtml(TRUST_SCOPE_NOTE)));
  assert.ok(html.includes(escapeHtml(TRUST_CHAT_NOTE)));
  assert.match(TRUST_SCOPE_NOTE, /plans Defty runs after you approve them/);
  assert.match(TRUST_CHAT_NOTE, /Chat does not use this level/);
  assert.match(TRUST_CHAT_NOTE, /Defty proposes tasks, messages and similar changes for your approval/);
  assert.match(TRUST_CHAT_NOTE, /saving a memory, drafting a plan for your review, or cancelling its own unsent app work/);
  assert.ok(!html.includes('All actions auto-execute except external writes'));
});

// ── Round 2 review findings ─────────────────────────────────────────────

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function viewState() {
  const state: TrustViewPatch = { value: 'standard', loadError: null, saveError: null, saving: false };
  const patches: TrustViewPatch[] = [];
  return {
    state,
    patches,
    apply: (patch: TrustViewPatch) => {
      patches.push(patch);
      Object.assign(state, patch);
    },
  };
}

test('E08-F1: chat copy keeps the trust level out of chat', () => {
  assert.match(TRUST_CHAT_NOTE, /^Chat does not use this level\./);
  assert.doesNotMatch(TRUST_SCOPE_NOTE, /heartbeat|trigger/i);
});

test('E08-F2: descriptions say connected tools follow their configured tier', () => {
  const [conservative, standard, autonomous] = TRUST_LEVELS;
  assert.match(conservative!.desc, /low-risk task updates on its own, such as changing a task's status, assignee or due date/);
  assert.match(standard!.desc, /creating tasks, adding comments and setting reminders/);
  assert.doesNotMatch(standard!.desc, /external writes/);
  assert.match(autonomous!.desc, /such as posting messages and bulk task updates/);
  assert.match(autonomous!.desc, /does not run actions classed as destructive on its own/);
  assert.match(TRUST_CONNECTED_NOTE, /Connected \(MCP\) tools use the approval setting on their own connection/);
  // Lane S2: the destructive exclusion now holds at every trust level.
  assert.match(TRUST_CONNECTED_NOTE, /no trust level lets Defty run a call classed as destructive on its own/);
  assert.doesNotMatch(TRUST_CONNECTED_NOTE, /at any level/);
  assert.ok(render().includes(escapeHtml(TRUST_CONNECTED_NOTE)));
});

test('E08-F3: the control is labelled as the Defty workspace policy and points to per-employee trust', () => {
  const html = render();
  assert.match(html, /<legend[^>]*>Defty trust level<\/legend>/);
  assert.match(TRUST_EMPLOYEE_NOTE, /Agent employees are not affected\. Each employee has its own trust level/);
  assert.match(TRUST_EMPLOYEE_NOTE, /under Employees below/);
  assert.ok(html.includes(escapeHtml(TRUST_EMPLOYEE_NOTE)));
});

test('E08-F4: the employee Autonomous confirmation makes modest, enforced claims', () => {
  const text = AUTONOMOUS_EMPLOYEE_CONFIRM.join(' ');
  assert.match(text, /A healthy employee can already post its own chat messages without approval at Conservative and Standard, so Autonomous is not needed for chat\./);
  assert.match(text, /Autonomous also lets most of this employee's other writes through Deft run without approval\./);
  assert.doesNotMatch(text, /including messages it posts in chat/, 'Autonomous no longer unlocks chat messages');
  assert.match(text, /actions classed as destructive \(such as deleting, archiving, unlinking, or creating records in bulk\)/);
  assert.match(text, /sending documents, importing workspace plans, and apps that require their own review/);
  assert.match(text, /Most of its writes are recorded in the Action Log/);
  assert.match(text, /Only workspace owners and admins can make this change/);
  assert.doesNotMatch(text, /wherever it acts|Its writes still appear/);
  assert.doesNotMatch(text, /Every action will still produce a signed receipt/);
  assert.doesNotMatch(text, /cannot be undone without another confirmation/);
});

// ── Round 3: modest, verifiable copy ────────────────────────────────────

test('E08-R3: copy makes no universal approval promise', () => {
  const html = render();
  const all = [html, AUTONOMOUS_EMPLOYEE_CONFIRM.join(' ')].join(' ');
  for (const phrase of [
    /Everything else waits/i,
    /each one waits/i,
    /wherever it acts/i,
    /whatever approval tier/i,
    /always waits/i,
    /never uses/i,
    /still wait for approval/i,
  ]) {
    assert.doesNotMatch(all, phrase);
  }
});

test('E08-R3: plan dependency direction', () => {
  assert.match(TRUST_SCOPE_NOTE, /a change that later steps depend on can run on its own or needs its own approval/);
  assert.match(TRUST_SCOPE_NOTE, /Steps of a plan you approved run under that approval/);
  assert.match(TRUST_SCOPE_NOTE, /except a step classed as destructive, which always needs its own approval/);
  assert.match(TRUST_SCOPE_NOTE, /when it retries a failed step/);
  assert.doesNotMatch(TRUST_SCOPE_NOTE, /uses an earlier step's result/);
  assert.ok(render().includes(escapeHtml(TRUST_SCOPE_NOTE)));
});

test('E05-F5: a definite 4xx rejection says the level was not changed and keeps the selection', async () => {
  const v = viewState();
  let gets = 0;
  const outcome = await saveTrustLevelAndReconcile(
    {
      patch: async () => response(400, { error: 'Invalid trust level', code: 'VALIDATION_ERROR' }),
      get: async () => {
        gets += 1;
        return response(200, { trust_level: 'standard' });
      },
    },
    'autonomous',
    v.apply,
    () => true,
  );
  assert.equal(outcome, 'rejected');
  assert.equal(gets, 0);
  assert.equal(v.state.value, 'standard');
  assert.equal(v.state.saving, false);
  assert.match(v.state.saveError ?? '', /Invalid trust level\)\. It was not changed\./);
});

test('E05-F5: a lost response reports an unknown outcome and reloads', async () => {
  const v = viewState();
  const outcome = await saveTrustLevelAndReconcile(
    {
      patch: async () => {
        throw new TypeError('Failed to fetch');
      },
      get: async () => response(200, { trust_level: 'autonomous' }),
    },
    'autonomous',
    v.apply,
    () => true,
  );
  assert.equal(outcome, 'reloaded');
  // The stale selection is cleared before the reload, never asserted as unchanged.
  assert.ok(v.patches.some((p) => p.value === null));
  assert.equal(v.state.value, 'autonomous');
  assert.match(v.state.saveError ?? '', /not known whether the trust level changed/);
  assert.match(v.state.saveError ?? '', /the trust level is now Autonomous/);
  assert.doesNotMatch(v.state.saveError ?? '', /was not changed/);
});

test('E05-F5: 5xx, timeout and unreadable success bodies are unknown, not rejections', async () => {
  const unreadable = {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('bad json');
    },
  };
  for (const res of [response(502, null), response(408, null), unreadable]) {
    const result = await saveTrustLevel(async () => res, 'standard');
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.outcome === 'unknown', `status ${res.status}`);
    assert.ok(!result.ok && !result.error.includes('not changed'));
  }
});

test('E05-F5: if the reload also fails the control shows the unknown state, not a stale value', async () => {
  const v = viewState();
  const outcome = await saveTrustLevelAndReconcile(
    { patch: async () => response(503, { error: 'Service Unavailable' }), get: async () => response(500, null) },
    'conservative',
    v.apply,
    () => true,
  );
  assert.equal(outcome, 'unknown');
  assert.equal(v.state.value, null);
  assert.equal(v.state.saveError, null);
  assert.match(v.state.loadError ?? '', /could not be reloaded either/);
  const html = render({ value: null, loadError: v.state.loadError });
  assert.ok(!radioTags(html).some((r) => /checked=""/.test(r)));
  assert.match(html, /role="alert"[^>]*>The server did not confirm the save/);
});

test('E05-F6: an obsolete load cannot overwrite a saved value', async () => {
  const guard = createGenerationGuard();
  const v = viewState();
  // Mount load (e.g. the first of two Strict Mode effect runs) is slow.
  const slowGet = deferred<ReturnType<typeof response>>();
  const loadIsCurrent = guard.begin();
  const load = loadTrustLevel(() => slowGet.promise).then((r) => {
    if (loadIsCurrent() && r.ok) v.apply({ value: r.value });
  });
  // A save takes a newer generation and succeeds first.
  const outcome = await saveTrustLevelAndReconcile(
    {
      patch: async () => response(200, { success: true, trust_level: 'autonomous' }),
      get: async () => response(200, { trust_level: 'autonomous' }),
    },
    'autonomous',
    v.apply,
    guard.begin(),
  );
  assert.equal(outcome, 'saved');
  slowGet.resolve(response(200, { trust_level: 'conservative' }));
  await load;
  assert.equal(v.state.value, 'autonomous');
});

test('E05-F6: cleanup makes an in-flight save reconcile obsolete', async () => {
  const guard = createGenerationGuard();
  const v = viewState();
  const slowGet = deferred<ReturnType<typeof response>>();
  const run = saveTrustLevelAndReconcile(
    { patch: async () => response(504, null), get: () => slowGet.promise },
    'autonomous',
    v.apply,
    guard.begin(),
  );
  await new Promise((r) => setTimeout(r, 0));
  guard.cancel();
  slowGet.resolve(response(200, { trust_level: 'conservative' }));
  assert.equal(await run, 'obsolete');
  assert.notEqual(v.state.value, 'conservative');
});

test('E02-F7: trust levels are native radios in a fieldset', () => {
  const html = render({ canEdit: false });
  assert.match(html, /^<fieldset[^>]*data-testid="trust-level-control"/);
  assert.match(html, /<legend class="sr-only">Defty trust level<\/legend>/);
  const radios = radioTags(html);
  assert.equal(radios.length, 3);
  const names = new Set(radios.map((r) => /name="([^"]+)"/.exec(r)?.[1]));
  assert.equal(names.size, 1);
  assert.ok(!html.includes('role="radiogroup"'));
  assert.ok(!html.includes('<button'));
  // The read-only reason is announced with the group.
  const describedBy = /^<fieldset[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1] ?? '';
  const readOnlyId = /<p id="([^"]+)"[^>]*data-testid="trust-read-only-note"/.exec(html)?.[1];
  assert.ok(readOnlyId && describedBy.split(' ').includes(readOnlyId));
  // Each radio is described by its level's text.
  for (const r of radios) assert.match(r, /aria-describedby="[^"]+-desc"/);
});

test('E02-F7: saving keeps the radios focusable and announces progress politely', () => {
  const html = render({ saving: true });
  for (const r of radioTags(html)) assert.doesNotMatch(r, /disabled=""/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /role="status" aria-live="polite">Saving…</);
});
