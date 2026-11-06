import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchConnectionAction, parseExperienceAccountTarget } from './app-experience-connection-action';
import type { ExperienceConnectionAction } from '../../../../packages/app-kit/src/experience-account';

function makePorts() {
  const calls: Record<string, any[]> = { showSettings: [], setResourceTarget: [], beginConnection: [], reestablish: [], openRestore: [], notice: [] };
  const ports = {
    showSettings: async (open?: boolean, section?: string) => { calls.showSettings.push([open, section]); },
    setResourceTarget: (key: string) => { calls.setResourceTarget.push(key); },
    beginConnection: async (targetKey: string) => { calls.beginConnection.push(targetKey); },
    reestablishBackgroundAccess: async (targetKey: string) => { calls.reestablish.push(targetKey); return 're-established'; },
    openRestore: (targetKey: string | null) => { calls.openRestore.push(targetKey); },
    notice: (message: string) => { calls.notice.push(message); },
  };
  return { ports, calls };
}

test('unknown target_key opens settings, never changes target, does not beginConnection', async () => {
  const { ports, calls } = makePorts();
  const action: ExperienceConnectionAction = { kind: 'reconnect', target_key: 'missing' };
  await dispatchConnectionAction(action, 'current', [], ports);
  assert.deepEqual(calls.showSettings, [[true, undefined]]);
  assert.equal(calls.setResourceTarget.length, 0);
  assert.equal(calls.beginConnection.length, 0);
});

test('beginConnection throwing restores previous target and shows notice', async () => {
  const { ports, calls } = makePorts();
  ports.beginConnection = async (targetKey: string) => { calls.beginConnection.push(targetKey); throw new Error('boom'); };
  const action: ExperienceConnectionAction = { kind: 'reconnect', target_key: 'target' };
  await dispatchConnectionAction(action, 'prev', [{ key: 'target', label: 'T' } as any], ports);
  assert.deepEqual(calls.beginConnection, ['target']);
  assert.deepEqual(calls.setResourceTarget, ['target', 'prev']);
  assert.deepEqual(calls.notice, ['boom']);
  assert.deepEqual(calls.showSettings, [[true, undefined]]);
});

test('connected target calls reestablish once and not beginConnection', async () => {
  const { ports, calls } = makePorts();
  const action: ExperienceConnectionAction = { kind: 'reconnect', target_key: 'target' };
  await dispatchConnectionAction(action, 'current', [{ key: 'target', label: 'T', health: { connection: 'connected' } } as any], ports);
  assert.equal(calls.reestablish.length, 1);
  assert.equal(calls.beginConnection.length, 0);
  assert.deepEqual(calls.notice, ['re-established']);
});

test('connected target with ended background lease still reestablishes (not beginConnection)', async () => {
  const { ports, calls } = makePorts();
  const action: ExperienceConnectionAction = { kind: 'reconnect', target_key: 'target' };
  await dispatchConnectionAction(action, 'current', [{ key: 'target', label: 'T', health: { connection: 'connected', background: { state: 'ended', since: '2026-01-01T00:00:00Z', reason: 'expired' } } } as any], ports);
  assert.equal(calls.reestablish.length, 1);
  assert.equal(calls.beginConnection.length, 0);
});

test('disconnected target calls beginConnection with that key', async () => {
  const { ports, calls } = makePorts();
  const action: ExperienceConnectionAction = { kind: 'reconnect', target_key: 'target' };
  await dispatchConnectionAction(action, 'current', [{ key: 'target', label: 'T', health: { connection: 'disconnected' } } as any], ports);
  assert.deepEqual(calls.beginConnection, ['target']);
});

test('restore_access routes to openRestore', async () => {
  const { ports, calls } = makePorts();
  const action: ExperienceConnectionAction = { kind: 'restore_access', target_key: 'target' };
  await dispatchConnectionAction(action, 'current', [], ports);
  assert.deepEqual(calls.openRestore, ['target']);
});

test('review_consent routes to settings access', async () => {
  const { ports, calls } = makePorts();
  const action: ExperienceConnectionAction = { kind: 'review_consent', target_key: 'target' };
  await dispatchConnectionAction(action, 'current', [], ports);
  assert.deepEqual(calls.openRestore, [null]);
  assert.deepEqual(calls.showSettings, [[true, 'access']]);
});

test('parseExperienceAccountTarget keeps valid target', () => {
  const input = { key: 'primary', label: 'Primary' };
  assert.deepEqual(parseExperienceAccountTarget(input), input);
});

test('parseExperienceAccountTarget drops invalid health but keeps target', () => {
  const input = { key: 'primary', label: 'Primary', health: { connection: 'bogus' } };
  assert.deepEqual(parseExperienceAccountTarget(input), { key: 'primary', label: 'Primary' });
});

test('parseExperienceAccountTarget drops invalid target', () => {
  const input = { key: 'Bad Key', label: 'Primary' };
  assert.equal(parseExperienceAccountTarget(input), null);
});
