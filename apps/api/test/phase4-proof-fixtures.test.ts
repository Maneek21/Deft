import assert from 'node:assert/strict';
import test from 'node:test';
import { PHASE4_SANDBOX_EMAIL_PROVIDER, Phase4SandboxEmailProvider } from './fixtures/phase4-sandbox-email-provider.js';

test('Phase 4 sandbox email provider is a frozen network effect and remains unused', () => {
  const provider = new Phase4SandboxEmailProvider();
  assert.equal(PHASE4_SANDBOX_EMAIL_PROVIDER.effect_class, 'network');
  assert.equal(Object.isFrozen(PHASE4_SANDBOX_EMAIL_PROVIDER), true);
  assert.equal(provider.callCount, 0);
});
