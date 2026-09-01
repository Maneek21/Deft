import assert from 'node:assert/strict';
import test from 'node:test';

import { SandboxEmailSendInputSchema } from '@deft/app-kit';
import { appRunProviderIdempotencyKey } from '../src/lib/app-run-attempt-runner.js';

test('provider idempotency keys remain stable and satisfy the frozen interface', () => {
  const formerlyInvalid = [
    appRunProviderIdempotencyKey('00000000-0000-4000-8000-000000000000'),
    appRunProviderIdempotencyKey('00000000-0000-4000-8000-000000000012'),
  ];
  assert.deepEqual(formerlyInvalid, [
    'd-mcO2as3SSMVRkJ3PyFG9uFOVBfN-MPqGrDGmim-aFQ',
    'd_4RiSOcIU8xRmFwghSICpZM0kU1mtv-Ri_kgI5vZqGU',
  ]);
  assert.equal(
    appRunProviderIdempotencyKey('00000000-0000-4000-8000-000000000001'),
    'B2exXALhKKYyYOXb5sg0Deb9T9RaewglbbbUxXGO1OE',
    'already-valid v1 keys must remain byte-identical',
  );
  for (const idempotencyKey of formerlyInvalid) {
    assert.doesNotThrow(() => SandboxEmailSendInputSchema.parse({
      to: 'recipient@example.test',
      subject: 'Contract-safe key',
      body_text: 'The generated key must satisfy the frozen provider schema.',
      idempotency_key: idempotencyKey,
    }));
  }
});
