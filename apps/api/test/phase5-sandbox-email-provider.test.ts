import assert from 'node:assert/strict';
import test from 'node:test';
import { PHASE4_SANDBOX_EMAIL_PROVIDER, Phase4SandboxEmailProvider } from './fixtures/phase4-sandbox-email-provider.js';

test('sandbox email provider implements the frozen private contract deterministically', async () => {
  const provider = new Phase4SandboxEmailProvider();
  const input = {
    to: 'ada@example.test',
    subject: 'Analytical Engines',
    body_text: 'Hello Ada',
    idempotency_key: 'campaign:one/contact:ada',
  };
  const first = await provider.invoke(input);
  const replay = await provider.invoke(input);

  assert.equal(PHASE4_SANDBOX_EMAIL_PROVIDER.provider_kind, 'mcp');
  assert.equal(PHASE4_SANDBOX_EMAIL_PROVIDER.operation_name, 'send_email');
  assert.deepEqual(replay, first);
  assert.equal(first.status, 'accepted');
  assert.match(first.message_id, /^sandbox_[a-f0-9]{24}$/);
  assert.equal(provider.callCount, 1);
  for (const conflictingInput of [
    { ...input, to: 'grace@example.test' },
    { ...input, subject: 'Compilers' },
    { ...input, body_text: 'Hello Grace' },
  ]) {
    await assert.rejects(
      () => provider.invoke(conflictingInput),
      /idempotency key was reused with different input/i,
    );
  }
  assert.equal(provider.callCount, 1);
  await assert.rejects(() => provider.invoke({ ...input, to: 'not-email' }), /email/i);
});
