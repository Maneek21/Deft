/** Exact reviewed false positives; preserve raw SARIF and fail unknown/changed findings. */
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync,mkdirSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,relative,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const hash=value=>createHash('sha256').update(value).digest('hex');
const need=(value,reason)=>{if(!value)throw Error(reason);};
const safePath=value=>typeof value==='string'&&/^[A-Za-z0-9_.\/-]+$/u.test(value)&&!value.startsWith('/')&&!value.includes(String.fromCharCode(92))&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(key=>!(key==='index'&&('uri' in value||'uriBaseId' in value))).map(key=>[key,canonical(value[key])]));
 return value;
}
export function findingFingerprint(result){
 // Only independent outer flows are unordered; retain every inner path, step and duplicate.
 const codeFlows=(result.codeFlows??[]).map(canonical).sort((a,b)=>{const x=JSON.stringify(a),y=JSON.stringify(b);return x<y?-1:x>y?1:0;});
 return hash(JSON.stringify(canonical({rule:result.ruleId,level:result.level??'warning',message:result.message,locations:result.locations,partialFingerprints:result.partialFingerprints??{},codeFlows})));
}
export function reviewSarif(original,review,repositoryRoot){
 need(original.version==='2.1.0'&&Array.isArray(original.runs)&&original.runs.length>0,'INVALID_SARIF');
 need(review.schema_version==='deft.codeql_false_positives.v1'&&Array.isArray(review.findings)&&review.sources&&typeof review.sources==='object','INVALID_REVIEW');
 const root=realpathSync(repositoryRoot),ids=new Set(),fingerprints=new Set();
 for(const entry of review.findings){
  need(typeof entry.id==='string'&&!ids.has(entry.id)&&!fingerprints.has(entry.fingerprint),'DUPLICATE_REVIEW');ids.add(entry.id);fingerprints.add(entry.fingerprint);
  need(entry.disposition==='false_positive'&&typeof entry.rule==='string'&&safePath(entry.path)&&Number.isSafeInteger(entry.line)&&entry.line>0&&/^[a-f0-9]{64}$/u.test(entry.fingerprint)&&typeof entry.justification==='string'&&entry.justification.length>=80&&Array.isArray(entry.sources)&&entry.sources.includes(entry.path),'INVALID_REVIEW');
  for(const source of entry.sources)need(safePath(source)&&/^[a-f0-9]{64}$/u.test(review.sources[source]??''),'INVALID_REVIEW_SOURCE');
 }
 const sourceHashes=new Map(),sourceMatches=source=>{
  if(!sourceHashes.has(source)){
   let digest=null;try{const path=join(root,source);if(lstatSync(path).isFile()&&!lstatSync(path).isSymbolicLink()&&!relative(root,realpathSync(path)).startsWith('..'))digest=hash(readFileSync(path));}catch{/* Missing source cannot carry an accepted disposition. */}
   sourceHashes.set(source,digest);
  }return sourceHashes.get(source)===review.sources[source];
 };
 const sarif=structuredClone(original),used=new Set(),findings=[];
 for(const run of sarif.runs){
  need(run.tool?.driver?.name==='CodeQL'&&Array.isArray(run.results),'CODEQL_RESULTS_REQUIRED');
  for(const result of run.results){
   const location=result.locations?.[0]?.physicalLocation,path=location?.artifactLocation?.uri,line=location?.region?.startLine,fingerprint=findingFingerprint(result);
   const entry=review.findings.find(row=>row.rule===result.ruleId&&row.path===path&&row.line===line&&row.fingerprint===fingerprint);
   // Incoming suppressions never authorize a disposition. Only this exact source review does.
   result.suppressions=[];
   let reason=entry?'reviewed_source_changed':'unreviewed_finding';
   if(entry&&used.has(entry.id))reason='duplicate_finding';
   else if(entry&&entry.sources.every(sourceMatches)){
    used.add(entry.id);reason='reviewed_false_positive';
    result.suppressions=[{kind:'external',status:'accepted',justification:entry.justification,location:{physicalLocation:{artifactLocation:{uri:'.github/codeql-reviewed-false-positives.json'}}},properties:{review_id:entry.id}}];
   }
   findings.push({rule:result.ruleId,level:result.level??'warning',locations:result.locations,fingerprint,disposition:reason,review_id:reason==='reviewed_false_positive'?entry.id:null});
  }
 }
 const unused=review.findings.filter(entry=>!used.has(entry.id)).map(entry=>entry.id),unresolved=findings.filter(row=>row.disposition!=='reviewed_false_positive');
 return {sarif,findings,summary:{raw_findings:findings.length,reviewed_false_positives:used.size,unresolved_findings:unresolved.length,unused_reviews:unused},passed:unresolved.length===0&&unused.length===0};
}
export function main(directory,repositoryRoot=process.cwd()){
 const review=JSON.parse(readFileSync(join(repositoryRoot,'.github/codeql-reviewed-false-positives.json'),'utf8'));
 const files=readdirSync(directory).filter(name=>name.endsWith('.sarif'));need(files.length===1,'EXACT_CODEQL_SARIF_REQUIRED');
 const file=files[0],originalBytes=readFileSync(join(directory,file)),result=reviewSarif(JSON.parse(originalBytes),review,repositoryRoot);
 const output=join(directory,'reviewed');mkdirSync(output,{recursive:true});
 writeFileSync(join(output,file),JSON.stringify(result.sarif,null,2)+'\n');writeFileSync(join(directory,'findings.json'),JSON.stringify(result.findings,null,2)+'\n');
 const summary={...result.summary,raw_sarif_sha256:hash(originalBytes),review_manifest_sha256:hash(readFileSync(join(repositoryRoot,'.github/codeql-reviewed-false-positives.json'))),gate:result.passed?'passed':'failed'};
 writeFileSync(join(directory,'disposition.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));
 need(readFileSync(join(directory,file)).equals(originalBytes),'RAW_SARIF_CHANGED');if(!result.passed)process.exitCode=1;return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){need(process.argv[2],'SARIF_DIRECTORY_REQUIRED');main(process.argv[2]);}
