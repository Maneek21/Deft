import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExperienceBridge, type ExperiencePin, type ExperiencePort } from './app-experience-bridge';

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
