import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readCatalog,readLedger} from './lineage-catalog.mjs';

const directory=resolve(dirname(fileURLToPath(import.meta.url)),'../upgrades');
const PLAN_SHA256='e4db186f28413df556cad8e4abed24111c4c05429d7e80eeeb7973301788cc53';
const LOCK_ID=7314029421;
const FORWARD128_SHA256='07152a1224e776cbfaa310f820908303113ef63559ec4ba484e7cca532bf4a47';
const hex=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
export const canonical=v=>JSON.stringify(sort(v));
export const hash=v=>createHash('sha256').update(v).digest('hex');
const fail=code=>{throw new Error(code);};
const identity=r=>({version:r.version,description:r.description,checksum:r.checksum,kind:r.kind});
export function sameLedger(actual,expected){
 if(!Array.isArray(actual)||!Array.isArray(expected)||actual.length!==expected.length)return false;
 for(const rows of [actual,expected]){
  if(!rows.length||rows.length>512||new Set(rows.map(r=>r?.version)).size!==rows.length)return false;
  if(rows.some(r=>!r||typeof r.version!=='string'||typeof r.description!=='string'||!hex(r.checksum)||!['baseline','migration'].includes(r.kind)))return false;
 }
 const indexed=new Map(actual.map(r=>[r.version,r]));
 return expected.every(r=>canonical(identity(indexed.get(r.version)??{}))===canonical(identity(r)));
}
function selectPriorReviewedHistory(snapshot,plan){
 if(plan?.schema_version!=='deft.reviewed_release_lineages.v1'||!Array.isArray(plan.variants)||!hex(snapshot?.digest))fail('E5_REVIEWED_LINEAGE_INVALID');
 const forward=loadUpgrade128(),applied=snapshot.ledger?.filter(r=>r.version===forward.version)??[];
 if(applied.length){
  if(applied.length!==1||canonical(identity(applied[0]))!==canonical(identity(forward))||!snapshot.catalog
   ||hash(canonical(snapshot.catalog))!==snapshot.digest)fail('E5_FORWARD_UPGRADE_INVALID');
  const catalog=structuredClone(snapshot.catalog);
  for(let i=0;i<forward.after.length;i++){
   const expected=forward.after[i],matches=catalog.functions.filter(f=>f.proname===expected.proname&&f.arguments===expected.arguments);
   if(matches.length!==1||canonical(matches[0])!==canonical(expected))fail('E5_FORWARD_UPGRADE_INVALID');
   catalog.functions[catalog.functions.indexOf(matches[0])]=forward.before[i];
  }
  snapshot={...snapshot,catalog,digest:hash(canonical(catalog)),ledger:snapshot.ledger.filter(r=>r.version!==forward.version)};
 }
 const matches=plan.variants.filter(v=>['public61','demo61'].includes(v.lineage)&&['original','current'].includes(v.stage)&&Array.isArray(v.append)&&v.catalog_digest===snapshot.digest&&sameLedger(snapshot.ledger,v.ledger));
 if(matches.length!==1)fail(matches.length?'E5_REVIEWED_LINEAGE_AMBIGUOUS':'E5_REVIEWED_LINEAGE_UNRECOGNIZED');
 if(applied.length&&matches[0].append.length)fail('E5_FORWARD_UPGRADE_INVALID');
 return applied.length?matches[0]:{...matches[0],append:[...matches[0].append,forward]};
}
/** This forward migration changes one consent-transition function. Removing
 * its exact replacement must reproduce the independently reviewed prior catalog
 * and ledger; no unrelated schema or history drift is normalized. */
export function loadUpgrade130(){
 const raw=readFileSync(resolve(directory,'lineages/upgrade130-functions.json'));
 if(hash(raw)!=='a72bd9caaf8a5369f80e9256039260e24c7c4b6034a4951304addbe1155731a7')fail('E5_FORWARD_UPGRADE_ARTIFACT_MISMATCH');
 const value=JSON.parse(raw);
 if(value.schema_version!=='deft.reviewed_function_upgrade.v1'||value.version!=='0.3.0-preview.130'
  ||value.before.length!==1||value.after.length!==1||hash(readFileSync(resolve(directory,value.file)))!==value.checksum)fail('E5_FORWARD_UPGRADE_ARTIFACT_MISMATCH');
 return value;
}
export function selectReviewedHistory(snapshot,plan){
 const forward=loadUpgrade130(),applied=snapshot.ledger?.filter(row=>row.version===forward.version)??[];
 if(applied.length){
  if(applied.length!==1||canonical(identity(applied[0]))!==canonical(identity(forward))||!snapshot.catalog
   ||hash(canonical(snapshot.catalog))!==snapshot.digest)fail('E5_FORWARD_UPGRADE_INVALID');
  const catalog=structuredClone(snapshot.catalog);
  for(let index=0;index<forward.after.length;index++){
   const expected=forward.after[index],matches=catalog.functions.filter(row=>row.proname===expected.proname&&row.arguments===expected.arguments);
   if(matches.length!==1||canonical(matches[0])!==canonical(expected))fail('E5_FORWARD_UPGRADE_INVALID');
   catalog.functions[catalog.functions.indexOf(matches[0])]=forward.before[index];
  }
  snapshot={...snapshot,catalog,digest:hash(canonical(catalog)),ledger:snapshot.ledger.filter(row=>row.version!==forward.version)};
 }
 const selected=selectPriorReviewedHistory(snapshot,plan);
 if(applied.length&&selected.append.length)fail('E5_FORWARD_UPGRADE_INVALID');
 return applied.length?selected:{...selected,append:[...selected.append,forward]};
}
/** Exactly two reviewed function replacements. Projection must reproduce the
 * entire previously admitted catalog and ledger; unrelated drift still fails. */
export function loadUpgrade128(){
 const raw=readFileSync(resolve(directory,'lineages/upgrade128-functions.json'));
 if(hash(raw)!==FORWARD128_SHA256)fail('E5_FORWARD_UPGRADE_ARTIFACT_MISMATCH');
 const value=JSON.parse(raw);
 if(value.schema_version!=='deft.reviewed_function_upgrade.v1'||value.version!=='0.3.0-preview.128'
  ||value.before.length!==2||value.after.length!==2||hash(readFileSync(resolve(directory,value.file)))!==value.checksum)fail('E5_FORWARD_UPGRADE_ARTIFACT_MISMATCH');
 return value;
}
export function loadReviewedPlan(){
 const raw=readFileSync(resolve(directory,'lineages/supported-histories.json'));
 if(hash(raw)!==PLAN_SHA256)fail('E5_REVIEWED_LINEAGE_ARTIFACT_MISMATCH');
 const plan=JSON.parse(raw);
 const root=realpathSync(directory)+sep;
 if(!Array.isArray(plan.files)||plan.files.length<2||plan.files.length>512)fail('E5_REVIEWED_LINEAGE_FILES_INVALID');
 for(const item of plan.files){
  if(typeof item.file!=='string'||!hex(item.checksum)||item.file.includes('\\')||item.file.split('/').some(p=>!p||p==='.'||p==='..'))fail('E5_REVIEWED_LINEAGE_FILES_INVALID');
  const file=realpathSync(resolve(directory,item.file));
  if(!file.startsWith(root)||hash(readFileSync(file))!==item.checksum)fail('E5_REVIEWED_LINEAGE_FILE_CHANGED');
 }
 return plan;
}
async function snapshot(client){
 return {ledger:await readLedger(client),...await readCatalog(client)};
}
async function inspect(client,plan){
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{const state=await snapshot(client);const selected=selectReviewedHistory(state,plan);await client.query('COMMIT');return {state,selected};}
 catch(error){await client.query('ROLLBACK');throw error;}
}
export async function assertReviewedCurrent(client){
 const plan=loadReviewedPlan();const state=await snapshot(client);const selected=selectReviewedHistory(state,plan);
 if(selected.append.length)fail('E5_FRESH_CATALOG_NOT_COMPLETE');
 return selected;
}
// The immutable fresh bootstrap is schema117. Only this exact reviewed
// catalog/ledger may be committed before the normal forward118 convergence.
export async function assertReviewedFreshBootstrap(client){
 const plan=loadReviewedPlan();const selected=selectReviewedHistory(await snapshot(client),plan);
 if(!['fresh-current-contracts-complete-schema116-schema117','fresh-current-persistent-columns-schema117'].includes(selected.name)
  ||selected.stage!=='current'||selected.append.length!==5
  ||selected.append[0].version!=='0.3.0-preview.118'
  ||selected.append[0].file!=='0.3.0-preview.118-app-supplemental-effects.sql'
  ||selected.append[1].version!=='0.3.0-preview.119'
  ||selected.append[1].file!=='0.3.0-preview.119-app-resource-observation-continuation-receipts.sql'
  ||selected.append[2].version!=='0.3.0-preview.120'
  ||selected.append[2].file!=='0.3.0-preview.120-app-persistent-consent.sql'
  ||selected.append[3].version!=='0.3.0-preview.128'
  ||selected.append[4].version!=='0.3.0-preview.130')fail('E5_FRESH_BOOTSTRAP_UNRECOGNIZED');
 return selected;
}
export async function convergeReviewedRelease(client,{status=false,dryRun=false}={}){
 const plan=loadReviewedPlan();
 const first=await inspect(client,plan); // Selection precedes legacy checksum validation.
 if(status||dryRun){
  console.log(JSON.stringify({lineage:first.selected.lineage,stage:first.selected.stage,pending:first.selected.append.map(x=>x.version),read_only:true}));
  return first.selected;
 }
 await client.query('SELECT pg_advisory_lock($1)',[LOCK_ID]);
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try{
   const before=await snapshot(client);
   const selected=selectReviewedHistory(before,plan); // Re-select after acquiring the original migration lock.
   const forward=loadUpgrade128(),allowed=new Map([...plan.files,forward,loadUpgrade130()].map(x=>[x.file,x.checksum]));
   for(const migration of selected.append){
    if(migration.kind!=='migration'||allowed.get(migration.file)!==migration.checksum)fail('E5_REVIEWED_LINEAGE_APPEND_INVALID');
    const sql=readFileSync(resolve(directory,migration.file));
    if(hash(sql)!==migration.checksum)fail('E5_REVIEWED_LINEAGE_FILE_CHANGED');
    await client.query(sql.toString('utf8'));
    await client.query(`INSERT INTO public.deft_schema_migrations(version,description,checksum,kind) VALUES($1,$2,$3,'migration')`,[migration.version,migration.description,migration.checksum]);
   }
   const after=await snapshot(client);
   const indexed=new Map(after.ledger.map(r=>[r.version,r]));
   if(!before.ledger.every(r=>canonical(r)===canonical(indexed.get(r.version))))fail('E5_ORIGINAL_LEDGER_CHANGED');
   const final=selectReviewedHistory(after,plan);
   if(final.lineage!==selected.lineage||final.append.length||final.stage!=='current')fail('E5_FINAL_CATALOG_UNRECOGNIZED');
   await client.query('COMMIT');
   console.log(JSON.stringify({lineage:final.lineage,stage:final.stage,appended:selected.append.length,catalog_digest:after.digest,original_ledger_preserved:true}));
   return final;
  }catch(error){await client.query('ROLLBACK');throw error;}
 }finally{await client.query('SELECT pg_advisory_unlock($1)',[LOCK_ID]);}
}
