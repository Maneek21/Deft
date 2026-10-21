import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { diffUpgradeAuthority, UPGRADE_NON_AUTHORITY_STRING_PATHS, UPGRADE_NON_AUTHORITY_DIGEST_PATHS } from '../src/lib/app-upgrade-manifest-diff.js';
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

const release = (version: number | string, kind: 'manifest' | 'connection') => JSON.parse(readFileSync(
  new URL('./fixtures/upgrade-authority-releases/' + version + '.' + kind + '.json', import.meta.url), 'utf8'));
for (const [from,to] of [[17,18],[18,19],[19,20],[20,'main-pr14']] as const) test('published consecutive release ' + from + ' -> ' + to + ' preserves raw authority', () => {
  const before=release(from,'manifest'),after=release(to,'manifest');
  assert.deepEqual(diffUpgradeAuthority(before,after,{before:release(from,'connection'),after:release(to,'connection')}),{requires_review:false,changed_paths:[]});
});
function setLeaf(value: any, pointer: string, leaf: unknown) {
  const parts=pointer.slice(1).split('/').map(part=>part==='*'?'0':part);
  let at=value;
  for(let index=0;index<parts.length-1;index++)at=at[parts[index]!]??=(parts[index+1]==='0'?[]:{});
  at[parts.at(-1)!]=leaf;
}
for(const path of [...UPGRADE_NON_AUTHORITY_STRING_PATHS,...UPGRADE_NON_AUTHORITY_DIGEST_PATHS])test('only the exact typed code/compatibility leaf is free: '+path,()=>{
  const before:any=manifest(),after:any=manifest(),digest=path.endsWith('_digest');
  setLeaf(before,path,digest?'sha256:'+'a'.repeat(64):'old');setLeaf(after,path,digest?'sha256:'+'b'.repeat(64):'new');
  assert.deepEqual(diffUpgradeAuthority(before,after).changed_paths,[]);
  setLeaf(after,path,{future_authority:true});assert.equal(diffUpgradeAuthority(before,after).requires_review,true,'objects are not presentation or code pins');
  setLeaf(after,path,null);assert.equal(diffUpgradeAuthority(before,after).requires_review,true,'JSON null is not a missing leaf');
  if(digest){setLeaf(after,path,'not-a-digest');assert.equal(diffUpgradeAuthority(before,after).requires_review,true);}
});
for(const [name,mutate]of Object.entries({
  scope:(m:any)=>{m.owner_connections[0].oauth_scopes=['delete'];},
  destination:(m:any)=>{m.destinations=[{origin:'https://new.example',audience:'public'}];},
  effect:(m:any)=>{m.runtime_actions.push({key:'delete',capability_key:'delete',runtime_requirement_key:'mail_provider'});},
  origin:(m:any)=>{m.owner_connections[0].authorization_origin='https://new.example';},
  unknown:(m:any)=>{m.future_authority={scopes:['all']};},
  compatibilityUnknown:(m:any)=>{m.compatibility.future_permission='all';},
  digestLookalike:(m:any)=>{m.experiences[0].future_digest='sha256:'+'a'.repeat(64);},
  protocol:(m:any)=>{m.compatibility.app_protocol='6';},
  artifactPath:(m:any)=>{m.experiences[0].artifact_path='other.json';},
  resourceKey:(m:any)=>{m.sync_descriptors[0].key='new';},
  order:(m:any)=>{m.owner_connections.reverse();},
  resourceSchema:(m:any)=>{m.sync_descriptors[0].record_schema.properties.future={type:'string'};},
}))test('real raw release requires review for '+name,()=>{
 const before=release(20,'manifest'),after=release(20,'manifest');mutate(after);
 assert.equal(diffUpgradeAuthority(before,after).requires_review,true);
});
test('real connection profile and transport remain strict even when keys resemble code pins',()=>{
 for(const change of [(c:any)=>{c.profile.authorization_origin='https://new.example';},(c:any)=>{c.profile.action_keys.push('delete');},
  c=>{c.endpoint='https://new.example/v1/connections';},(c:any)=>{c.profile.version='new';},(c:any)=>{c.runtime_auth_token='changed';}]){
  const before=release(20,'connection'),after=release(20,'connection');change(after);
  const result=diffUpgradeAuthority(release(20,'manifest'),release('main-pr14','manifest'),{before,after});
  assert.equal(result.requires_review,true);assert.ok(result.changed_paths.every(path=>path.startsWith('/connection/')));
 }
});
test('allowlist does not hide container addition/removal, unknown nested fields or numeric object keys',()=>{
 const before:any=manifest(),after:any=manifest();after.compatibility.host={version:'new'};
 assert.deepEqual(diffUpgradeAuthority(before,after).changed_paths,['/manifest/compatibility/host']);
 before.compatibility.host={version:'old',permissions:['read']};after.compatibility.host.permissions=['all'];
 assert.equal(diffUpgradeAuthority(before,after).requires_review,true);
 const left={...manifest(),experiences:{'0':{artifact_digest:'sha256:'+'a'.repeat(64)}}};
 const right={...manifest(),experiences:{'0':{artifact_digest:'sha256:'+'b'.repeat(64)}}};
 assert.equal(diffUpgradeAuthority(left,right).requires_review,true);
});

test('raw release fixture bytes retain the recorded source evidence hashes',()=>{
 const provenance=JSON.parse(readFileSync(new URL('./fixtures/upgrade-authority-releases/sources.json',import.meta.url),'utf8'));
 for(const entry of provenance.releases)for(const kind of ['manifest','connection']){
  const raw=readFileSync(new URL('./fixtures/upgrade-authority-releases/'+entry.id+'.'+kind+'.json',import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'),entry[kind+'_fixture_sha256']);
 }
});
