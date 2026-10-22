import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {readFileSync} from 'node:fs';
import {parseAttachmentAppManifest,digestResourceSyncDescriptorV2} from '@deft/app-kit/core';
const manifest=parseAttachmentAppManifest(JSON.parse(readFileSync(new URL('./fixtures/runtime-security-manifest.json',import.meta.url),'utf8')));
const reviewed={installation:{id:'installation'},version:{id:'version'},grant:{id:'grant'},manifest};
let reads=0;
mock.module(new URL('../src/lib/app-attachment-authority.ts',import.meta.url).href,{namedExports:{
 attachmentStale:()=>Error('stale'),loadReviewedAttachmentApp:async()=>{reads++;return reviewed;},
}});
const {loadReviewedAttachmentSyncDescriptor}=await import('../src/lib/app-attachment-sync-reviewed.js');
test('a sync descriptor preserves the exact already validated transaction-local manifest for downstream owner/current readers',async()=>{
 const descriptor=manifest.sync_descriptors[0]!;
 const result=await loadReviewedAttachmentSyncDescriptor({} as never,'organization','installation',descriptor.key);
 assert.equal(reads,1);assert.strictEqual(result.manifest,manifest);assert.strictEqual(result.descriptor,descriptor);
 assert.equal(result.descriptor_digest,await digestResourceSyncDescriptorV2(descriptor));
 assert.strictEqual(result.installation,reviewed.installation);assert.strictEqual(result.version,reviewed.version);assert.strictEqual(result.grant,reviewed.grant);
});
