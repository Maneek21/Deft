import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuntimeById } from './agent-runtime-catalog';

test('Hermes onboarding defaults to the native adapter and keeps the bridge rollback-only', () => {
  const runtime = getRuntimeById('hermes');

  assert.equal(runtime.defaultWakeMode, 'external_chat');
  assert.deepEqual(runtime.transports, ['Native Deft platform adapter', 'MCP streamable HTTP']);
  assert.ok(runtime.setupNotes.some((note) => note.includes('native deft-platform')));
  assert.ok(runtime.setupNotes.some((note) => note.includes('directly as an HTTP MCP server')));
  assert.ok(runtime.caveats.some((note) => note.includes('rollback-only')));
  assert.equal(runtime.transports.some((transport) => /stdio bridge/i.test(transport)), false);
});
