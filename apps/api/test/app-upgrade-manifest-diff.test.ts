import assert from 'node:assert/strict';
import test from 'node:test';
import { diffUpgradeAuthority } from '../src/lib/app-upgrade-manifest-diff.js';
const manifest = () => ({ schema_version: '7', id: 'community.example.connection', version: '1.0.0',
  name: 'Connection', compatibility: { app_protocol: '7' },
  owner_connections: [{ key: 'account', scopes: ['read'], purposes: ['metadata'], provider: { origin: 'https://provider.example' } }],
  runtime_actions: [{ key: 'read', effects: ['read'] }],
  resources: [{ key: 'metadata', schema: { properties: { subject: { type: 'string' } } } }],
  destinations: [{ audience: 'owner', origin: 'https://host.example' }] });
const connection = () => ({ profile: { provider: 'provider', authorization_origin: 'https://provider.example',
  scopes: ['read'], action_keys: ['read'] }, transport_digest: 'sha256:unchanged' });
test('identical authority and presentation/version-only upgrades have an empty diff', () => {
  const before = manifest(), after = { ...manifest(), version: '2.0.0', name: 'New name', description: 'New copy' };
  assert.deepEqual(diffUpgradeAuthority(before, after), { requires_review: false, changed_paths: [] });
  assert.equal(diffUpgradeAuthority(before, after, { before: connection(), after: connection() }).requires_review, false);
});
for (const [name, mutate] of Object.entries({
  scope: (m: ReturnType<typeof manifest>) => m.owner_connections[0]!.scopes.push('send'),
  provider: (m: ReturnType<typeof manifest>) => { m.owner_connections[0]!.provider.origin = 'https://other.example'; },
  purpose: (m: ReturnType<typeof manifest>) => m.owner_connections[0]!.purposes.push('body'),
  destination: (m: ReturnType<typeof manifest>) => m.destinations.push({ audience: 'third_party', origin: 'https://other.example' }),
  audience: (m: ReturnType<typeof manifest>) => { m.destinations[0]!.audience = 'workspace'; },
  effect: (m: ReturnType<typeof manifest>) => m.runtime_actions[0]!.effects.push('delete'),
  action: (m: ReturnType<typeof manifest>) => m.runtime_actions.push({ key: 'organize', effects: ['write'] }),
  schema: (m: ReturnType<typeof manifest>) => { m.resources[0]!.schema.properties.subject.type = 'object'; },
  identity: (m: ReturnType<typeof manifest>) => { m.id = 'community.example.other'; },
  removal: (m: ReturnType<typeof manifest>) => m.owner_connections.pop(),
})) test(`${name} changes require review`, () => {
  const before = manifest(), after = manifest(); mutate(after);
  assert.equal(diffUpgradeAuthority(before, after).requires_review, true);
});
test('unknown fields are retained at every level, including future authority declarations', () => {
  for (const location of ['root', 'nested', 'schema', 'presentation']) {
    const before: any = manifest(), after: any = manifest();
    const left = location === 'root' ? before : location === 'nested' ? before.owner_connections[0]
      : location === 'schema' ? before.resources[0].schema : (before.name = { text: 'Name', future_authority: false });
    const right = location === 'root' ? after : location === 'nested' ? after.owner_connections[0]
      : location === 'schema' ? after.resources[0].schema : (after.name = { text: 'Name', future_authority: true });
    if (location !== 'presentation') { left.future_authority = false; right.future_authority = true; }
    assert.equal(diffUpgradeAuthority(before, after).requires_review, true, location);
  }
  const before: any = manifest(), after: any = manifest();
  after.unrecognized_scopes = ['all']; assert.equal(diffUpgradeAuthority(before, after).requires_review, true);
  before.unrecognized_scopes = ['all']; assert.equal(diffUpgradeAuthority(before, after).requires_review, false);
  delete after.unrecognized_scopes; assert.equal(diffUpgradeAuthority(before, after).requires_review, true);
});
test('transport/profile/provider scope changes require review', () => {
  for (const key of ['profile', 'transport_digest']) {
    const after: any = connection(); after[key] = key === 'profile' ? { ...after.profile, scopes: ['read', 'send'] } : 'sha256:changed';
    assert.equal(diffUpgradeAuthority(manifest(), manifest(), { before: connection(), after }).requires_review, true);
  }
});
test('object key order is irrelevant; array changes remain conservative', () => {
  const before: any = manifest(), after: any = Object.fromEntries(Object.entries(manifest()).reverse());
  assert.equal(diffUpgradeAuthority(before, after).requires_review, false);
  before.owner_connections[0].scopes = ['read', 'metadata']; after.owner_connections[0].scopes = ['metadata', 'read'];
  assert.equal(diffUpgradeAuthority(before, after).requires_review, true);
});
test('malformed/future protocols and non-JSON values fail safe', () => {
  for (const after of [null, [], {}, { ...manifest(), schema_version: '8' }, { ...manifest(), compatibility: null },
    { ...manifest(), future: undefined }, { ...manifest(), future: NaN }, { ...manifest(), future: new Date() }]) {
    assert.equal(diffUpgradeAuthority(manifest(), after).requires_review, true);
  }
});

test('invalid sparse arrays, cycles and excessive nesting fail safe', () => {
  const cyclic: any = manifest(); cyclic.future = cyclic;
  let nested: unknown = true; for (let index = 0; index < 70; index++) nested = { future: nested };
  for (const value of [Array(2), cyclic, { ...manifest(), future: nested }]) {
    const after = Array.isArray(value) ? { ...manifest(), future: value } : value;
    assert.equal(diffUpgradeAuthority(after, after).requires_review, true);
  }
});
