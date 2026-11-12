/** Content-pinned reviewed false positives; preserve raw SARIF and fail unknown/changed paths. */
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync,mkdirSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,relative,join,isAbsolute,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
const hash=value=>createHash('sha256').update(value).digest('hex');
const need=(value,reason)=>{if(!value)throw Error(reason);};
const safePath=value=>typeof value==='string'&&/^[A-Za-z0-9_.\/-]+$/u.test(value)&&!value.startsWith('/')&&!value.includes(String.fromCharCode(92))&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
 return value;
}
function sourceReader(repositoryRoot){
 const root=realpathSync(repositoryRoot),files=new Map();
 return (uri,region)=>{
  need(safePath(uri),'INVALID_SOURCE_PATH');
  if(!files.has(uri)){
   // Reject directory symlinks/junctions as well as symlink files, even inside root.
   let path=root;
   for(const part of uri.split('/')){path=join(path,part);need(!lstatSync(path).isSymbolicLink(),'SYMLINK_SOURCE');}
   const rel=relative(root,realpathSync(path));
   need(rel!== '..'&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel)&&lstatSync(path).isFile(),'OUTSIDE_OR_INVALID_SOURCE');
   const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(readFileSync(path));
   const lines=text===''?[]:text.split(/\r\n|\n|\r/u);
   if(text.endsWith('\n')||text.endsWith('\r'))lines.pop();
   files.set(uri,lines);
  }
  const lines=files.get(uri),start=region?.startLine,end=region?.endLine??start;
  need(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>0&&end>=start&&end<=lines.length,'INVALID_SOURCE_REGION');
  return lines.slice(start-1,end).map(line=>line.trimEnd()).join('\n');
 };
}
function fingerprintV2(result,readSource){
 need(typeof result.ruleId==='string'&&typeof result.message?.text==='string'&&(result.level===undefined||typeof result.level==='string'),'INVALID_RESULT');
 const location=loc=>{
  const physical=loc?.physicalLocation,uri=physical?.artifactLocation?.uri;
  need(loc?.message===undefined||typeof loc.message.text==='string','INVALID_LOCATION_MESSAGE');
  return {uri,...(loc.message===undefined?{}:{message:loc.message.text}),code:readSource(uri,physical?.region)};
 };
 const primary=location(result.locations?.[0]);
 const lineHash=result.partialFingerprints?.primaryLocationLineHash;
 need(lineHash===undefined||typeof lineHash==='string','INVALID_LINE_HASH');
 // Only independent outer flows are unordered; retain every inner path, step and duplicate.
 const codeFlows=(result.codeFlows??[]).map(flow=>({threadFlows:flow.threadFlows.map(thread=>({locations:thread.locations.map(step=>location(step.location))}))})).map(canonical).sort((a,b)=>{const x=JSON.stringify(a),y=JSON.stringify(b);return x<y?-1:x>y?1:0;});
 return hash(JSON.stringify(canonical({rule:result.ruleId,level:result.level??'warning',message:result.message.text,uri:primary.uri,...(lineHash===undefined?{}:{primaryLocationLineHash:lineHash}),primary,codeFlows})));
}
export function findingFingerprint(result,repositoryRoot=process.cwd()){
 return fingerprintV2(result,sourceReader(repositoryRoot));
}
export function reviewSarif(original,review,repositoryRoot){
 need(original?.version==='2.1.0'&&Array.isArray(original.runs)&&original.runs.length>0,'INVALID_SARIF');
 need(review?.schema_version==='deft.codeql_false_positives.v2'&&Array.isArray(review.findings)&&typeof review.review_source_commit==='string'&&typeof review.review_original_sarif_sha256==='string'&&/^[a-f0-9]{40}$/u.test(review.review_source_commit)&&/^[a-f0-9]{64}$/u.test(review.review_original_sarif_sha256)&&Object.keys(review).every(key=>['schema_version','review_source_commit','review_original_sarif_sha256','findings'].includes(key)),'INVALID_REVIEW');
 const readSource=sourceReader(repositoryRoot),ids=new Set(),fingerprints=new Set();
 for(const entry of review.findings){
  need(entry&&typeof entry.id==='string'&&entry.id.length>0&&entry.disposition==='false_positive'&&typeof entry.rule==='string'&&entry.rule.length>0&&safePath(entry.path)&&Number.isSafeInteger(entry.line)&&entry.line>0&&typeof entry.fingerprint_v2==='string'&&/^[a-f0-9]{64}$/u.test(entry.fingerprint_v2)&&typeof entry.justification==='string'&&entry.justification.length>=80&&Object.keys(entry).every(key=>['id','rule','path','line','fingerprint_v2','disposition','justification'].includes(key)),'INVALID_REVIEW');
  need(!ids.has(entry.id)&&!fingerprints.has(entry.fingerprint_v2),'DUPLICATE_REVIEW');ids.add(entry.id);fingerprints.add(entry.fingerprint_v2);
 }
 const sarif=structuredClone(original),used=new Set(),findings=[];
 for(const run of sarif.runs){
  need(run.tool?.driver?.name==='CodeQL'&&Array.isArray(run.results),'CODEQL_RESULTS_REQUIRED');
  for(const result of run.results){
   const path=result.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
   let fingerprint=null;
   try{fingerprint=fingerprintV2(result,readSource);}catch{/* Invalid/missing source or region cannot inherit a review. */}
   const entry=review.findings.find(row=>row.rule===result.ruleId&&row.path===path&&row.fingerprint_v2===fingerprint);
   // Incoming suppressions never authorize a disposition. Only this content review does.
   result.suppressions=[];
   let reason=fingerprint===null?'reviewed_source_changed':'unreviewed_finding';
   if(entry&&used.has(entry.id))reason='duplicate_finding';
   else if(entry){
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
