import test from 'node:test';import assert from 'node:assert/strict';
import {verifyPreparedRecordChange} from '../src/lib/app-data-record-change-guards';
import {fixture,digest} from './app-data-record-changes-test-fixture';
test('host independently binds initial invocation mode to the immutable prepared acknowledgement',()=>{
 const f=fixture(),manual=f.prepare(),initialInput={...f.input,invocation_mode:'initial' as const};
 const {prepared_digest,...snapshot}=manual,initialSnapshot={...snapshot,invocation_mode:'initial' as const},initial={...initialSnapshot,prepared_digest:digest(initialSnapshot)};
 assert.ok(verifyPreparedRecordChange(manual,f.destination as any,f.source as any,f.input));
 assert.ok(verifyPreparedRecordChange(initial,f.destination as any,f.source as any,initialInput));
 assert.throws(()=>verifyPreparedRecordChange(manual,f.destination as any,f.source as any,initialInput));
 assert.throws(()=>verifyPreparedRecordChange(initial,f.destination as any,f.source as any,f.input));
});
