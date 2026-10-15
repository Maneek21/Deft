import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {hash,loadReviewedPlan,selectReviewedHistory} from './lineage-convergence.mjs';

test('all 180 reviewed lineage artifacts preserve their exact raw checksums',()=>{
 const plan=loadReviewedPlan();
 assert.equal(plan.files.length,180);
 for(const item of plan.files){
  const raw=readFileSync(fileURLToPath(new URL('../upgrades/'+item.file,import.meta.url)));
  assert.equal(hash(raw),item.checksum,item.file);
  const tampered=Buffer.from(raw);
  tampered[0]^=1;
  assert.notEqual(hash(tampered),item.checksum,item.file+' content change must fail');
 }
});

// Captured from the immutable public baseline and ordinary first upgrade, not
// synthesized from the admission plan. The second supported invocation is a no-op.
test('canonical preview1 upgrade output is recognized exactly and drift is denied',()=>{
 const plan=loadReviewedPlan();
 const raw=readFileSync(new URL('../upgrades/lineages/canonical-preview1-schema118.json',import.meta.url));
 assert.equal(hash(raw),plan.source_provenance.canonical_preview1_schema118.snapshot_fixture_sha256);
 const {snapshot}=JSON.parse(raw);
 const selected=selectReviewedHistory(snapshot,plan);
 assert.equal(selected.name,'canonical-preview1-current-schema118');
 assert.deepEqual(selected.append.map(row=>row.version),['0.3.0-preview.119']);
 const wrongCatalog=structuredClone(snapshot);wrongCatalog.digest='0'.repeat(64);
 assert.throws(()=>selectReviewedHistory(wrongCatalog,plan),/E5_REVIEWED_LINEAGE_UNRECOGNIZED/);
 const wrongLedger=structuredClone(snapshot);wrongLedger.ledger[0].checksum='0'.repeat(64);
 assert.throws(()=>selectReviewedHistory(wrongLedger,plan),/E5_REVIEWED_LINEAGE_UNRECOGNIZED/);
 const missingRow=structuredClone(snapshot);missingRow.ledger.pop();
 assert.throws(()=>selectReviewedHistory(missingRow,plan),/E5_REVIEWED_LINEAGE_UNRECOGNIZED/);
});
