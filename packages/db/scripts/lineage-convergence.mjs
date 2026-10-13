import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readCatalog,readLedger} from './lineage-catalog.mjs';

const directory=resolve(dirname(fileURLToPath(import.meta.url)),'../upgrades');
const PLAN_SHA256='f9ddcde16f1404276eaa0588ea3d264936eedaf5b10602e69f5704872700e4dc';
const LOCK_ID=7314029421;
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
export function selectReviewedHistory(snapshot,plan){
 if(plan?.schema_version!=='deft.reviewed_release_lineages.v1'||!Array.isArray(plan.variants)||!hex(snapshot?.digest))fail('E5_REVIEWED_LINEAGE_INVALID');
 const matches=plan.variants.filter(v=>['public61','demo61'].includes(v.lineage)&&['original','current'].includes(v.stage)&&Array.isArray(v.append)&&v.catalog_digest===snapshot.digest&&sameLedger(snapshot.ledger,v.ledger));
 if(matches.length!==1)fail(matches.length?'E5_REVIEWED_LINEAGE_AMBIGUOUS':'E5_REVIEWED_LINEAGE_UNRECOGNIZED');
 return matches[0];
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
   const allowed=new Map(plan.files.map(x=>[x.file,x.checksum]));
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
