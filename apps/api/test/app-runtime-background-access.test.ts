import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { BackgroundAccessPorts } from '../src/lib/app-runtime-background-access.js';

const owner = randomUUID(), org = randomUUID();
const scope = (consent: Record<string, unknown>) => ({ org_id: org, owner_user_id: owner, operator_user_id: owner, installation_id: randomUUID(),
  app_version_id: randomUUID(), runtime_registration_id: randomUUID(), runtime_epoch: 1, resource_binding_id: randomUUID(),
  target_key: 'fresh_mailbox', resource_key: 'inbox', profile_digest: 'sha256:' + 'a'.repeat(64), ...consent }) as never;
const actor = { kind: 'human', actor_id: owner, org_id: org, role: 'owner', source: 'ui' } as never;
const caller = { org_id: org, user_id: owner, sid: randomUUID(), access_expires_at: Date.now() + 600_000 };
const guard = (async () => {}) as never;
process.env.DEFT_PUBLIC_URL = 'https://demo.example';
// Runtime configuration is read at import, so load the service after setting it.
const { backgroundChannelUrls, backgroundRenewalRequest, reestablishBackgroundAccess } = await import('../src/lib/app-runtime-background-access.js');

function ports(currentScope: never, overrides: Partial<BackgroundAccessPorts> = {}) {
  const sent: Record<string, unknown>[] = [], issued: unknown[] = [];
  const port: BackgroundAccessPorts = {
    currentAuthority: async () => ({ scope: currentScope, profile: {} }),
    actionBindings: async () => [{ id: randomUUID(), runtime_registration_id: randomUUID(), runtime_epoch: 1 }],
    issueAction: async (_actor, _binding, _guard, renewal) => { issued.push(renewal); return { session_id: randomUUID(), session_token: 'S'.repeat(43),
      expires_at: new Date(Date.now() + 900_000), ...('renewal_lifetime' in renewal ? { renewable_until: null, renewal_lifetime: 'until_revoked' as const } : { renewable_until: renewal.requested_until! }) }; },
    issueObservation: async () => ({ session_id: randomUUID(), session_token: 'O'.repeat(43), expires_at: new Date(Date.now() + 900_000), renewable_until: null, renewal_lifetime: 'until_revoked' }),
    install: async (_scope, _profile, input) => { sent.push(input); return { schema_version: 'deft.app_runtime_channel_install_result.v1',
      installed: (input.channels as { kind: 'action' | 'observation'; channel: { credential: { session_id: string }; registration: { runtime_registration_id: string } } }[])
        .map(entry => ({ kind: entry.kind, runtime_registration_id: entry.channel.registration.runtime_registration_id, session_id: entry.channel.credential.session_id, expires_at: new Date().toISOString() })) }; },
    ...overrides };
  return { port, sent, issued };
}
const run = (port: BackgroundAccessPorts) => reestablishBackgroundAccess(port, actor, caller, { installation_id: randomUUID(), target_key: 'fresh_mailbox' }, guard, AbortSignal.timeout(5000));

test('a date-limited permission re-establishes actions with finite renewal and explains the observation skip', async () => {
  const expiry = new Date(Date.now() + 86_400_000).toISOString(), { port, sent, issued } = ports(scope({ consent_expires_at: expiry }));
  const result = await run(port);
  assert.equal(result.installed.length, 1);
  assert.deepEqual(result.skipped, [{ kind: 'observation', reason: 'permission_not_until_revoked' }]);
  assert.equal(JSON.stringify(result).includes('SSSS'), false);
  assert.ok((issued[0] as { requested_until: Date }).requested_until.getTime() < Date.parse(expiry));
  const channel = (sent[0]!.channels as { channel: { channel_url: string } }[])[0]!.channel;
  assert.equal(channel.channel_url, 'https://demo.example/api/app-runtime/channel');
});

test('an until-revoked permission also re-establishes background refresh with its exact registration', async () => {
  const current = scope({ consent_expires_at: null, consent_lifetime: 'until_revoked' }), { port, sent } = ports(current);
  const result = await run(port);
  assert.deepEqual(result.installed.map(item => item.kind), ['action', 'observation']);
  const observation = (sent[0]!.channels as { kind: string; channel: { registration: Record<string, unknown> } }[]).find(entry => entry.kind === 'observation')!;
  assert.deepEqual(Object.keys(observation.channel.registration).sort(), ['operator_user_id', 'org_id', 'profile_digest', 'resource_key', 'runtime_epoch', 'runtime_registration_id', 'target_key']);
});

test('only the reviewed owner operator can re-establish, and a mismatched Runtime reply fails', async () => {
  const expiry = new Date(Date.now() + 86_400_000).toISOString();
  const other = ports({ ...(scope({ consent_expires_at: expiry }) as object), operator_user_id: randomUUID() } as never);
  await assert.rejects(run(other.port), { code: 'APP_ACCESS_DENIED' });
  const lying = ports(scope({ consent_expires_at: expiry }), { install: async () => ({ schema_version: 'deft.app_runtime_channel_install_result.v1',
    installed: [{ kind: 'action', runtime_registration_id: randomUUID(), session_id: randomUUID(), expires_at: new Date().toISOString() }] }) });
  await assert.rejects(run(lying.port), { code: 'APP_ACCESS_DENIED' });
  const refused = ports(scope({ consent_expires_at: expiry }), { issueAction: async () => null });
  await assert.rejects(run(refused.port), { code: 'APP_ACCESS_DENIED' });
});

test('channel URLs and renewal requests are bounded', () => {
  assert.throws(() => backgroundChannelUrls('http://demo.example'), { code: 'APP_ACCESS_DENIED' });
  assert.equal(backgroundChannelUrls('https://demo.example/app').observation_authority, 'https://demo.example/api/app-resource-observations/runtime');
  assert.throws(() => backgroundRenewalRequest({ consent_expires_at: new Date(Date.now() + 30_000).toISOString() } as never), { code: 'APP_ACCESS_DENIED' });
  assert.deepEqual(backgroundRenewalRequest({ consent_expires_at: null, consent_lifetime: 'until_revoked' } as never), { renewal_lifetime: 'until_revoked', requested_until: null });
});
