import assert from 'node:assert/strict';
import test from 'node:test';

test('validated persistent resource consent survives final guards without extending technical or web leases', async () => {
  const flags = ['DEFT_APPS_ENABLED', 'DEFT_APP_RUNS_ENABLED', 'DEFT_APP_RUN_APP_ORIGIN_ENABLED',
    'DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED', 'DEFT_APP_ATTACHMENT_BROKER_ENABLED'];
  const previous = flags.map(key => process.env[key]);
  const priorKeyrings = process.env.DEFT_APP_RUN_KEYRINGS;
  for (const key of flags) process.env[key] = 'true';
  const ring = (id: string, byte: number) => ({ current: id, keys: { [id]: Buffer.alloc(32, byte).toString('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: ring('final-enc', 11), receipt_signing: ring('final-sign', 12), fingerprint: ring('final-fp', 13) });
  try {
    const { assertAttachmentStageFinalAuthority } = await import('./app-attachment-sync-run.js');
    const { AppResourceSyncClosureService } = await import('./app-resource-sync-closure.js');
    let now = Date.now();
    const clock = () => new Date(now), future = () => new Date(now + 60_000);
    const tx = { select: () => ({ from: () => ({ where: async () => [{ id: 'owner', kind: 'human', is_agent: false }] }) }),
      execute: async () => ({ rows: [{ now_ms: String(now) }] }) } as any;
    const binding = { id: 'resource', owner_user_id: 'owner', consent_expires_at: null as Date | null,
      consent_lifetime: 'until_revoked' as string | null };
    const authority = { binding, registration: { operator_user_id: 'owner' }, session: { expires_at: future() } };
    const run = { authorization_snapshot: {}, input_expires_at: future(), result_expires_at: future() };
    const attempt = { lease_expires_at: future() };
    const context = { authority, run, attempt } as any;
    const guard = Object.assign(async () => {}, { current_web_session_expires_at: future });
    const closureContext = { authority, participants: ['owner'] };
    const closureFinal = () => (AppResourceSyncClosureService.prototype as any).final.call({ now: clock }, tx, closureContext, guard);
    await assertAttachmentStageFinalAuthority(tx, context, clock);
    (await closureFinal())();

    binding.consent_lifetime = null;
    await assert.rejects(assertAttachmentStageFinalAuthority(tx, context, clock));
    await assert.rejects(closureFinal());
    binding.consent_expires_at = future();
    await assertAttachmentStageFinalAuthority(tx, context, clock);
    const finishFinite = await closureFinal();
    binding.consent_lifetime = 'until_revoked';
    await assert.rejects(assertAttachmentStageFinalAuthority(tx, context, clock));
    await assert.rejects(closureFinal());
    binding.consent_expires_at = null;
    now += 61_000;
    assert.throws(finishFinite);
    await assert.rejects(assertAttachmentStageFinalAuthority(tx, context, clock));
    const expiredWeb = Object.assign(async () => {}, { current_web_session_expires_at: () => new Date(now - 1) });
    await assert.rejects((AppResourceSyncClosureService.prototype as any).final.call({ now: clock }, tx, closureContext, expiredWeb));
  } finally {
    flags.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    if (priorKeyrings === undefined) delete process.env.DEFT_APP_RUN_KEYRINGS;
    else process.env.DEFT_APP_RUN_KEYRINGS = priorKeyrings;
  }
});
