import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExperienceBridge, type ExperiencePin, type ExperiencePort } from './app-experience-bridge';

const pin: ExperiencePin = {
  org_id: 'org_a', user_id: 'user_a', app_installation_id: 'installation_a',
  app_version_id: 'version_a', grant_snapshot_id: 'grant_a',
  lifecycle_epoch: 1, grant_epoch: 1, session_id: 'session_12345678', session_epoch: 1,
};
class Port implements ExperiencePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  sent: unknown[] = [];
  postMessage(value: unknown) { this.sent.push(value); }
  close() { this.closed = true; }
  view(sequence: number, text: string) {
    this.onmessage?.({ data: {
      version: 'deft.experience_bridge.v1', session_id: pin.session_id,
      sequence, kind: 'view', view: { root: { kind: 'text', id: 'status', text } },
    } } as MessageEvent);
  }
}
function deferred() {
  let resolve!: (live: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  return { promise, resolve };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test('a held earlier live view cannot replace the newer compose view', async () => {
  const port = new Port(), first = deferred(), second = deferred();
  const rendered: string[] = [];
  let checks = 0;
  const bridge = createExperienceBridge({ port, pin, resourceKeys: [], actionKeys: [],
    broker: { isLive: () => ++checks === 1 ? first.promise : second.promise },
    onView: view => { assert.equal(view.root.kind, 'text'); if (view.root.kind === 'text') rendered.push(view.root.text); },
  });
  port.view(1, 'Waiting for the authorized host');
  port.view(2, 'Compose');
  second.resolve(true); await settle();
  assert.deepEqual(rendered, ['Compose']);
  first.resolve(true); await settle();
  assert.deepEqual(rendered, ['Compose']);
  assert.equal(bridge.active, true);
});

test('an earlier false liveness result still revokes after a newer view renders', async () => {
  const port = new Port(), first = deferred(), second = deferred();
  let checks = 0, rendered = 0;
  const bridge = createExperienceBridge({ port, pin, resourceKeys: [], actionKeys: [],
    broker: { isLive: () => ++checks === 1 ? first.promise : second.promise },
    onView: () => { rendered++; },
  });
  port.view(1, 'Busy'); port.view(2, 'Reply');
  second.resolve(true); await settle();
  assert.equal(rendered, 1);
  first.resolve(false); await settle();
  assert.equal(bridge.active, false); assert.equal(port.closed, true);
  port.view(3, 'After revoke'); await settle(); assert.equal(rendered, 1);
});

test('a pending newer true view cannot render after the earlier result revokes', async () => {
  const port = new Port(), first = deferred(), second = deferred();
  let checks = 0, rendered = 0;
  const bridge = createExperienceBridge({ port, pin, resourceKeys: [], actionKeys: [],
    broker: { isLive: () => ++checks === 1 ? first.promise : second.promise },
    onView: () => { rendered++; },
  });
  port.view(1, 'Busy'); port.view(2, 'Compose');
  first.resolve(false); await settle(); assert.equal(bridge.active, false);
  second.resolve(true); await settle();
  assert.equal(rendered, 0); assert.equal(port.closed, true);
});
