import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExperienceBridge, parseExperienceView, type ExperiencePin, type ExperiencePort } from './app-experience-bridge';
import { createDeftExperienceSdk } from '../../../../packages/app-kit/src/experience-sdk';

const pin: ExperiencePin = Object.freeze({
  org_id: 'org_a', user_id: 'user_a', app_installation_id: 'installation_a',
  app_version_id: 'version_a', grant_snapshot_id: 'grant_a',
  lifecycle_epoch: 3, grant_epoch: 4, session_id: 'session_12345678', session_epoch: 1,
});
class FakePort implements ExperiencePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  postMessage(value: unknown) { this.sent.push(value); }
  close() { this.closed = true; }
  receive(value: unknown) { this.onmessage?.({ data: value } as MessageEvent); }
}
const view = { root: { kind:'stack', id:'root', children:[
  { kind:'grid', id:'orders', columns:['Order','Status'],
    rows:[{ id:'alpha', cells:['Alpha','Open'] }] },
  { kind:'canvas', id:'sketch', strokes:[{ points:[{x:0,y:0},{x:1,y:1}] }] },
] } };
const message = (sequence: number, value: Record<string, unknown>) => ({
  version:'deft.experience_bridge.v1', session_id:pin.session_id, sequence, ...value,
});
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('sidebar navigation accepts bounded buttons and rejects routes, collisions and other nodes', () => {
  const root = { kind: 'text', id: 'content', text: 'Content' };
  const item = { kind: 'button', id: 'inbox', label: 'Inbox', selected: true, disabled: false };
  assert.deepEqual(parseExperienceView({ root, navigation: [item] }), { root, navigation: [item] });
  assert.equal(parseExperienceView({ root, navigation: [{ ...item, href: '/settings' }] }), null);
  assert.equal(parseExperienceView({ root, navigation: [root] }), null);
  assert.equal(parseExperienceView({ root, navigation: [item, item] }), null);
  assert.equal(parseExperienceView({ root, navigation: [{ ...item, id: 'content' }] }), null);
  assert.equal(parseExperienceView({ root, navigation: Array.from({ length: 17 }, (_, i) => ({ ...item, id: `nav_${i}` })) }), null);
  assert.deepEqual(parseExperienceView({ root }), { root });
});

test('public SDK sidebar clicks use the existing live session and stop after revocation', async () => {
  const hostPort = new FakePort(), authorPort = new FakePort();
  hostPort.postMessage = value => { hostPort.sent.push(value); authorPort.receive(structuredClone(value)); };
  authorPort.postMessage = value => hostPort.receive(structuredClone(value));
  let live = true; const views: unknown[] = [], events: unknown[] = [];
  const bridge = createExperienceBridge({ port: hostPort, pin, resourceKeys: [], actionKeys: [],
    broker: { isLive: () => live }, onView: view => views.push(view) });
  const sdk = createDeftExperienceSdk(authorPort, pin.session_id);
  sdk.onEvent(event => events.push(event));
  const view = { root: { kind: 'text', id: 'content', text: 'Inbox' }, navigation: [{ kind: 'button', id: 'sent', label: 'Sent' }] };
  try {
    sdk.render(view); await delay(); assert.deepEqual(views, [view]);
    assert.equal(await bridge.sendUiEvent({ kind: 'click', node_id: 'sent' }), true);
    assert.deepEqual(events, [{ kind: 'click', node_id: 'sent' }]);
    live = false;
    assert.equal(await bridge.sendUiEvent({ kind: 'click', node_id: 'sent' }), false);
    assert.equal(events.length, 1);
  } finally { sdk.close(); bridge.revoke(); }
});

test('public SDK opens declared source through host without receiving a locator or file content', async () => {
  const hostPort = new FakePort(), authorPort = new FakePort();
  hostPort.postMessage = value => { hostPort.sent.push(value); authorPort.receive(structuredClone(value)); };
  authorPort.postMessage = value => { authorPort.sent.push(value); hostPort.receive(structuredClone(value)); };
  const recordId = '12345678-1234-4234-8234-123456789012'; let calls = 0;
  const bridge = createExperienceBridge({ port: hostPort, pin, resourceKeys: ['inbox'], actionKeys: [],
    broker: { isLive: () => true, openResource: async (_pin, key, input) => {
      assert.equal(key, 'inbox'); assert.deepEqual(input, { record_id: recordId }); calls++; return { opened: true };
    } }, onView: () => undefined });
  const sdk = createDeftExperienceSdk(authorPort, pin.session_id);
  try {
    assert.deepEqual(await sdk.openResource('inbox', recordId), { opened: true }); assert.equal(calls, 1);
    assert.equal(JSON.stringify(hostPort.sent).includes(recordId), false);
    await assert.rejects(sdk.openResource('inbox', 'https://example.test/arbitrary'), /Invalid record locator/);
    hostPort.receive(message(2, { kind: 'request', request_id: 'request_2', operation: 'open_resource', key: 'undeclared', input: { record_id: recordId } }));
    await delay(); assert.equal(bridge.active, false); assert.equal(calls, 1);
  } finally { sdk.close(); bridge.revoke(); }
});

test('public SDK optional undefined request fields preserve Run status and keyed action dispatch', async () => {
  const hostPort = new FakePort(), authorPort = new FakePort();
  hostPort.postMessage = value => { hostPort.sent.push(value); authorPort.receive(structuredClone(value)); };
  authorPort.postMessage = value => { authorPort.sent.push(value); hostPort.receive(structuredClone(value)); };
  let statusCalls = 0, actionCalls = 0;
  const run = { id: 'run_test', state: 'succeeded' };
  const bridge = createExperienceBridge({ port: hostPort, pin, resourceKeys: [], actionKeys: ['send_message'],
    broker: { isLive: () => true, runStatus: async () => { statusCalls += 1; return run; },
      action: async (_pin, key, input) => { assert.equal(key, 'send_message'); assert.equal(input, undefined); actionCalls += 1; return run; } },
    onView: () => undefined });
  const sdk = createDeftExperienceSdk(authorPort, pin.session_id);
  try {
    assert.deepEqual(await sdk.request('run_status', undefined, { run_id: run.id }), run);
    assert.deepEqual(await sdk.request('action', 'send_message'), run);
    assert.equal(statusCalls, 1); assert.equal(actionCalls, 1); assert.equal(bridge.active, true);
    assert.ok(Object.hasOwn(authorPort.sent[0] as object, 'key'));
    assert.ok(Object.hasOwn(authorPort.sent[1] as object, 'input'));
  } finally { sdk.close(); bridge.revoke(); }
});

test('optional envelope normalization still denies unknown undefined fields nested undefined and Run status keys', async () => {
  for (const fields of [{ extra: undefined, key: undefined, input: { run_id: 'run_test' } },
    { key: undefined, input: { run_id: 'run_test', nested: undefined } },
    { key: 'send_message', input: { run_id: 'run_test' } }]) {
    const port = new FakePort(); let calls = 0;
    const bridge = createExperienceBridge({ port, pin, resourceKeys: [], actionKeys: ['send_message'],
      broker: { isLive: () => true, runStatus: async () => { calls += 1; return {}; } }, onView: () => undefined });
    port.receive(structuredClone(message(1, { kind: 'request', request_id: 'request_1', operation: 'run_status', ...fields })));
    await delay(); assert.equal(bridge.active, false); assert.equal(port.closed, true); assert.equal(calls, 0);
  }
});

test('bounded rich view accepted; spoofed session and replay close the port', async () => {
  const port = new FakePort();
  const views: unknown[] = [];
  const bridge = createExperienceBridge({
    port, pin, resourceKeys:[], actionKeys:[],
    broker:{ isLive:()=>true }, onView:(value)=>views.push(value),
  });
  port.receive(message(1, { kind:'view', view }));
  await delay();
  assert.equal(views.length, 1);
  port.receive(message(1, { kind:'view', view }));
  assert.equal(bridge.active, false);
  assert.equal(port.closed, true);
  const other = new FakePort();
  const spoof = createExperienceBridge({
    port:other, pin, resourceKeys:[], actionKeys:[],
    broker:{ isLive:()=>true }, onView:()=>undefined,
  });
  other.receive({ ...message(1, {kind:'view', view}), session_id:'session_foreign' });
  assert.equal(spoof.active, false);
});

test('host stamps exact pin and drops late resource response after revocation', async () => {
  const port = new FakePort();
  let finish!: (value: unknown) => void;
  let suppliedPin: ExperiencePin | undefined;
  let suppliedSignal: AbortSignal | undefined;
  const pending = new Promise<unknown>((resolve) => { finish = resolve; });
  const bridge = createExperienceBridge({
    port, pin, resourceKeys:['orders'], actionKeys:[],
    broker:{ isLive:()=>true, resource:async (authority, key, input, signal) => {
      suppliedPin = authority; suppliedSignal = signal;
      assert.equal(key, 'orders'); assert.deepEqual(input, { page:1 });
      return pending;
    } }, onView:()=>undefined,
  });
  port.receive(message(1, { kind:'request', request_id:'request_1',
    operation:'resource', key:'orders', input:{page:1} }));
  await delay();
  assert.deepEqual(suppliedPin, pin);
  bridge.revoke();
  finish({ records:['late'] });
  await delay();
  assert.equal(suppliedSignal?.aborted, true);
  assert.equal(port.sent.length, 0);
});

test('wrong action key, malformed payload and flood fail closed before callbacks', async () => {
  let calls = 0;
  const port = new FakePort();
  const bridge = createExperienceBridge({
    port, pin, resourceKeys:[], actionKeys:['submit'],
    broker:{ isLive:()=>true, action:async()=>{ calls++; return {run_id:'run_a'}; } },
    onView:()=>undefined,
  });
  port.receive(message(1, { kind:'request', request_id:'request_1',
    operation:'action', key:'other', input:{} }));
  assert.equal(bridge.active, false);
  assert.equal(calls, 0);

  const cycle: {self?: unknown} = {}; cycle.self = cycle;
  const cyclePort = new FakePort();
  const cycleBridge = createExperienceBridge({
    port:cyclePort, pin, resourceKeys:[], actionKeys:[],
    broker:{ isLive:()=>true }, onView:()=>undefined,
  });
  cyclePort.receive(message(1, { kind:'view', view:cycle }));
  assert.equal(cycleBridge.active, false);

  const floodPort = new FakePort();
  const flood = createExperienceBridge({
    port:floodPort, pin, resourceKeys:[], actionKeys:[],
    broker:{ isLive:()=>true }, onView:()=>undefined, now:()=>1000,
  });
  for (let sequence=1; sequence<=101; sequence++) {
    floodPort.receive(message(sequence, { kind:'view', view }));
  }
  assert.equal(flood.active, false);
});

test('missing action callback fails closed and stale live authority drops result', async () => {
  const port = new FakePort();
  let live = true;
  const bridge = createExperienceBridge({
    port, pin, resourceKeys:[], actionKeys:['submit'],
    broker:{ isLive:()=>live }, onView:()=>undefined,
  });
  port.receive(message(1, { kind:'request', request_id:'request_1',
    operation:'action', key:'submit', input:{} }));
  await delay();
  assert.deepEqual(port.sent[0], {
    version:'deft.experience_bridge.v1', kind:'response',
    session_id:pin.session_id, request_id:'request_1', ok:false, code:'UNAVAILABLE',
  });
  live = false;
  port.receive(message(2, {kind:'view', view}));
  await delay();
  assert.equal(bridge.active, false);
});

test('UI events are dropped when the live pin is revoked', async () => {
  const port = new FakePort();
  let live = true;
  const bridge = createExperienceBridge({
    port, pin, resourceKeys:[], actionKeys:[],
    broker:{ isLive:()=>live }, onView:()=>undefined,
  });
  assert.equal(await bridge.sendUiEvent({ kind:'click', node_id:'submit' }), true);
  assert.equal(port.sent.length, 1);
  live = false;
  assert.equal(await bridge.sendUiEvent({ kind:'click', node_id:'submit' }), false);
  assert.equal(port.sent.length, 1);
  assert.equal(bridge.active, false);
});

test('input change reaches the Worker before a rapid submit click', async () => {
  const port = new FakePort();
  let releaseFirst!: () => void;
  const firstLive = new Promise<boolean>((resolve) => { releaseFirst = () => resolve(true); });
  let checks = 0;
  const bridge = createExperienceBridge({
    port, pin, resourceKeys: [], actionKeys: [],
    broker: { isLive: () => ++checks === 1 ? firstLive : true },
    onView: () => undefined,
  });
  const changed = bridge.sendUiEvent({ kind: 'input', node_id: 'shipment', value: 'parcel-1' });
  const clicked = bridge.sendUiEvent({ kind: 'click', node_id: 'submit' });
  await delay();
  assert.equal(port.sent.length, 0);
  releaseFirst();
  assert.equal(await changed, true);
  assert.equal(await clicked, true);
  assert.deepEqual((port.sent as Array<{event: {kind: string}}>).map((item) => item.event.kind),
    ['input', 'click']);
});

test('resource response bounds cover the entire envelope and withdrawal drops late data', async () => {
  const port = new FakePort();
  let resolveRead!: (value: unknown) => void;
  const pending = new Promise(resolve => { resolveRead = resolve; });
  const bridge = createExperienceBridge({ port, pin, resourceKeys: ['inbox'], actionKeys: [],
    broker: { isLive: () => true, resource: () => pending }, onView: () => undefined });
  port.receive(message(1, { kind: 'request', request_id: 'request_1', operation: 'resource', key: 'inbox', input: {} }));
  await delay();
  bridge.revoke();
  resolveRead({ private_body: 'late' });
  await delay();
  assert.equal(port.sent.length, 0);
  const boundedPort = new FakePort();
  createExperienceBridge({ port: boundedPort, pin, resourceKeys: ['inbox'], actionKeys: [],
    broker: { isLive: () => true, resource: async () => Array.from({ length: 15 }, () => 'x'.repeat(4095)) }, onView: () => undefined });
  boundedPort.receive(message(1, { kind: 'request', request_id: 'request_1', operation: 'resource', key: 'inbox', input: {} }));
  await delay();
  assert.equal((boundedPort.sent[0] as any).code, 'RESOURCE_PAYLOAD_TOO_LARGE');
  assert.equal((boundedPort.sent[0] as any).output, undefined);
});


test('safe presentation options round-trip without admitting author HTML or CSS', () => {
  const rich = { root: { kind: 'stack', id: 'root', layout: 'split', surface: 'panel', mobile: 'only', children: [
    { kind: 'text', id: 'title', text: '<b>Literal title</b>', tone: 'heading' },
    { kind: 'button', id: 'message', label: 'Sender', variant: 'list', description: 'Preview', meta: '10:00', selected: true, disabled: false },
    { kind: 'input', id: 'body', label: 'Message', value: 'Draft', multiline: true, placeholder: 'Write a message' },
  ] } };
  assert.deepEqual(parseExperienceView(rich), rich);
  assert.deepEqual(parseExperienceView(view), view);
  assert.deepEqual(parseExperienceView({ root: { kind: 'stack', id: 'list', layout: 'list', children: [] } }),
    { root: { kind: 'stack', id: 'list', layout: 'list', children: [] } });
  const cases = [
    { kind: 'text', id: 'title', text: 'Hello', tone: 'html' },
    { kind: 'text', id: 'title', text: 'Hello', html: '<b>Hello</b>' },
    { kind: 'button', id: 'send', label: 'Send', style: { color: 'red' } },
    { kind: 'button', id: 'send', label: 'Send', variant: 'link' },
    { kind: 'button', id: 'send', label: 'Send', selected: 'true' },
    { kind: 'button', id: 'send', label: 'Send', disabled: 1 },
    { kind: 'button', id: 'send', label: 'Send', description: 'x'.repeat(513) },
    { kind: 'button', id: 'send', label: 'Send', meta: 'x'.repeat(81) },
    { kind: 'input', id: 'body', label: 'Body', value: '', multiline: 'true' },
    { kind: 'input', id: 'body', label: 'Body', value: '', placeholder: 'x'.repeat(129) },
    { kind: 'stack', id: 'root', children: [], layout: 'absolute' },
    { kind: 'stack', id: 'root', children: [], surface: 'glass' },
    { kind: 'stack', id: 'root', children: [], mobile: 'always' },
    { kind: 'stack', id: 'root', children: [], layout: { toString: () => 'split' } },
  ];
  for (const root of cases) assert.equal(parseExperienceView({ root }), null);
});


test('flat workspace presentation stays symbolic and bounded', () => {
  const workspace = { root: { kind: 'stack', id: 'root', layout: 'workspace', children: [
    { kind: 'stack', id: 'toolbar', layout: 'toolbar', children: [
      { kind: 'button', id: 'compose', label: 'Compose', icon: 'compose' },
      { kind: 'input', id: 'search', label: 'Search', value: '', appearance: 'search' },
    ] },
    { kind: 'stack', id: 'split', layout: 'split', children: [
      { kind: 'stack', id: 'sidebar', surface: 'sidebar', children: [
        { kind: 'button', id: 'message', label: 'Subject', eyebrow: 'Sender', variant: 'list' },
      ] },
      { kind: 'stack', id: 'document', surface: 'document', children: [
        { kind: 'text', id: 'body', text: 'Literal body', tone: 'body' },
        { kind: 'input', id: 'to', label: 'To', value: '', appearance: 'inline' },
        { kind: 'input', id: 'draft', label: 'Message', value: '', multiline: true, appearance: 'body' },
      ] },
    ] },
  ] } };
  assert.deepEqual(parseExperienceView(workspace), workspace);
  for (const extra of [{ icon: '<svg onload=alert(1)>' }, { icon: 'https://example.test/icon.svg' },
    { icon: { toString: () => 'send' } }, { eyebrow: 'x'.repeat(129) }, { icon_only: true }]) {
    assert.equal(parseExperienceView({ root: { kind: 'button', id: 'send', label: 'Send', ...extra } }), null);
  }
  assert.equal(parseExperienceView({ root: { kind: 'input', id: 'body', label: 'Body', value: '', appearance: 'html' } }), null);
});


test('private state dispatch requires an explicitly declared key and live pin', async () => {
  const port = new FakePort(); let calls = 0;
  const bridge = createExperienceBridge({ port, pin, resourceKeys: [], actionKeys: [], stateKeys: ['drafts'],
    broker: { isLive: () => true, privateState: async (_pin, key, input) => { calls++; assert.equal(key, 'drafts');
      assert.deepEqual(input, { operation: 'list' }); return { operation: 'list', items: [] }; } }, onView: () => undefined });
  port.receive(message(1, { kind: 'request', request_id: 'request_1', operation: 'private_state', key: 'drafts', input: { operation: 'list' } }));
  await delay(); assert.equal(calls, 1); assert.equal(bridge.active, true);
  port.receive(message(2, { kind: 'request', request_id: 'request_2', operation: 'private_state', key: 'undeclared', input: { operation: 'list' } }));
  await delay(); assert.equal(calls, 1); assert.equal(bridge.active, false);
});
