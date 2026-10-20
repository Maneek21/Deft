import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalCapabilityJson } from '@deft/shared';
import { resourceSyncDueAt } from '../src/lib/app-resource-sync-cadence.js';

const created_at = new Date('2030-01-01T00:00:00Z');
const terminal_at = new Date('2030-01-01T00:00:20Z');
const page = {schema_version:'deft.app_sync_page.v1',upserts:[],tombstones:[],next_cursor:'opaque-next',has_more:true};
const digest = (value: unknown) => 'sha256:' + createHash('sha256').update(canonicalCapabilityJson(value)).digest('hex');
const input = {created_at,terminal_at,interval_seconds:900,committed:true,page_digest:digest(page),cursor:page.next_cursor,
  output:{schema_version:'deft.app_run_provider_result.v1',provider_succeeded:true,output:page}};

test('successful incomplete pages become due after a bounded continuation delay', () => {
  assert.equal(resourceSyncDueAt(input).toISOString(), '2030-01-01T00:00:21.000Z');
});
test('complete pages keep the normal cadence even with a non-null cursor', () => {
  const complete = {...page,has_more:false};
  assert.equal(resourceSyncDueAt({...input,page_digest:digest(complete),output:{...input.output,output:complete}}).toISOString(), '2030-01-01T00:15:00.000Z');
});
test('attachment-capable resource pages use the same app-neutral catch-up signal', () => {
  const attached = {...page,schema_version:'deft.app_sync_page.v2',upserts:[{id:'record',revision:'1',data:{label:'record'},attachments:[]}]};
  assert.equal(resourceSyncDueAt({...input,page_digest:digest(attached),output:{...input.output,output:attached}}).toISOString(), '2030-01-01T00:00:21.000Z');
});
test('errors, missing or uncommitted evidence and changed cursors cannot accelerate admission', () => {
  for (const changed of [
    {committed:false}, {terminal_at:null}, {output:null}, {page_digest:null}, {page_digest:'sha256:'+'0'.repeat(64)},
    {cursor:null}, {cursor:'different'}, {output:{...input.output,provider_succeeded:false}},
    {output:{...input.output,output:{...page,has_more:'true'}}},
  ]) assert.equal(resourceSyncDueAt({...input,...changed}).toISOString(), '2030-01-01T00:15:00.000Z');
});
