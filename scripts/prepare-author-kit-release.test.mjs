import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {authorKitReleaseMetadata} from './prepare-author-kit-release.mjs';

test('released Kit metadata binds exact archive bytes, source commit and Host release',()=>{
  const input={archive:Buffer.from('packed-kit-fixture'),filename:'deft-app-kit-0.1.0-alpha.42.tgz',
    version:'0.1.0-alpha.42',host_release:'0.3.0-preview.133',source_commit:'a'.repeat(40)};
  const result=authorKitReleaseMetadata(input);
  assert.equal(result.sha256,createHash('sha256').update(input.archive).digest('hex'));
  assert.equal(result.integrity,'sha512-'+createHash('sha512').update(input.archive).digest('base64'));
  assert.equal(result.source_commit,input.source_commit);
  assert.equal(result.host_release,input.host_release);
  assert.notEqual(authorKitReleaseMetadata({...input,archive:Buffer.from('changed')}).sha256,result.sha256);
  for(const patch of [{filename:'deft-app-kit-0.1.0-alpha.41.tgz'},{source_commit:'master'},
    {host_release:'current'},{version:'latest'},{archive:Buffer.alloc(0)}])
    assert.throws(()=>authorKitReleaseMetadata({...input,...patch}),/IDENTITY_INVALID/u);
});

test('release workflow packs and records the Kit before checksums and publication',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  const pack=workflow.indexOf('- name: Package the released Author Kit');
  assert.ok(pack>workflow.indexOf('- name: Install the locked browser verifier'));
  assert.ok(pack<workflow.indexOf('- name: Generate checksums'));
  assert.ok(pack<workflow.indexOf('- name: Create GitHub release'));
  assert.match(workflow,/pnpm --dir packages\/app-kit pack --pack-destination "\$GITHUB_WORKSPACE\/dist"/u);
  assert.match(workflow,/node scripts\/prepare-author-kit-release\.mjs/u);
});
