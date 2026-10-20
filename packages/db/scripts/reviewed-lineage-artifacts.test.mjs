import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {hash,canonical,loadReviewedPlan,loadUpgrade128,selectReviewedHistory} from './lineage-convergence.mjs';

test('all 181 reviewed lineage artifacts preserve their exact raw checksums',()=>{
 const plan=loadReviewedPlan();
 assert.equal(plan.files.length,181);
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
 assert.deepEqual(selected.append.map(row=>row.version),['0.3.0-preview.119','0.3.0-preview.120','0.3.0-preview.128']);
 const wrongCatalog=structuredClone(snapshot);wrongCatalog.digest='0'.repeat(64);
 assert.throws(()=>selectReviewedHistory(wrongCatalog,plan),/E5_REVIEWED_LINEAGE_UNRECOGNIZED/);
 const wrongLedger=structuredClone(snapshot);wrongLedger.ledger[0].checksum='0'.repeat(64);
 assert.throws(()=>selectReviewedHistory(wrongLedger,plan),/E5_REVIEWED_LINEAGE_UNRECOGNIZED/);
 const missingRow=structuredClone(snapshot);missingRow.ledger.pop();
 assert.throws(()=>selectReviewedHistory(missingRow,plan),/E5_REVIEWED_LINEAGE_UNRECOGNIZED/);
});

test('forward function upgrade preserves exact prior catalog and ledger admission, rejects drift',()=>{
 const forward=loadUpgrade128(),row={version:'0.2.0-preview.1',description:'fixture',checksum:'a'.repeat(64),kind:'baseline'};
 const old={functions:forward.before,unrelated:[{name:'retained'}]},catalog={...old,functions:forward.after};
 const plan={schema_version:'deft.reviewed_release_lineages.v1',variants:[{name:'fixture',lineage:'public61',stage:'current',catalog_digest:hash(canonical(old)),ledger:[row],append:[]}]};
 const snapshot={catalog,digest:hash(canonical(catalog)),ledger:[row,forward]};
 assert.equal(selectReviewedHistory(snapshot,plan).append.length,0);
 for(const change of [s=>s.catalog.functions[0].definition+=' ',s=>s.catalog.unrelated[0].name='drift',s=>s.ledger[1]={...forward,checksum:'b'.repeat(64)},s=>s.ledger.shift()]){
  const bad=structuredClone(snapshot);change(bad);bad.digest=hash(canonical(bad.catalog));assert.throws(()=>selectReviewedHistory(bad,plan));
 }
});

test('function upgrade pins are derived from immutable source bodies and candidate SQL',()=>{
 const value=loadUpgrade128(),candidate=readFileSync(new URL('../upgrades/'+value.file,import.meta.url),'utf8');
 for(let i=0;i<value.before.length;i++){
  const prior=value.before[i],guard=prior.proname==='deft_app_connection_session_guard';
  const source=readFileSync(new URL('../upgrades/'+(guard?'0.3.0-preview.117-app-connection-uncertain-exchange.sql':'0.3.0-preview.108-app-connection-upgrade-expiry.sql'),import.meta.url),'utf8');
  const body=(sql,name)=>sql.slice(sql.indexOf('FUNCTION '+name)).split('$$')[1];
  assert.equal(prior.definition.split('$function$')[1],body(source,(guard?'public.':'')+prior.proname));
  assert.equal(value.after[i].definition.split('$function$')[1],body(candidate,(guard?'public.':'')+prior.proname));
 }
});
