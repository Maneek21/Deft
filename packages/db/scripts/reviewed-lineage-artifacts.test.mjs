import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {hash,loadReviewedPlan} from './lineage-convergence.mjs';

test('all 179 reviewed lineage artifacts preserve their exact raw checksums',()=>{
 const plan=loadReviewedPlan();
 assert.equal(plan.files.length,179);
 for(const item of plan.files){
  const raw=readFileSync(fileURLToPath(new URL('../upgrades/'+item.file,import.meta.url)));
  assert.equal(hash(raw),item.checksum,item.file);
  const tampered=Buffer.from(raw);
  tampered[0]^=1;
  assert.notEqual(hash(tampered),item.checksum,item.file+' content change must fail');
 }
});
