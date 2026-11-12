import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,copyFileSync,existsSync,symlinkSync,lstatSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {reviewSarif,findingFingerprint,main} from './codeql-reviewed-findings.mjs';

const repositoryRoot=fileURLToPath(new URL('..',import.meta.url));
// The full master SARIF is a CI artifact (canonical-codeql-<run>), not checked
// in. Set CODEQL_MASTER_SARIF to run those cases locally; in CI the gate step
// right after these tests checks the fresh SARIF against the manifest anyway.
const masterPath=process.env.CODEQL_MASTER_SARIF??'';
const masterOptions={skip:masterPath&&existsSync(masterPath)?false:'Set CODEQL_MASTER_SARIF to a canonical-codeql javascript.sarif'};
const sha=value=>createHash('sha256').update(value).digest('hex');
function tempRoot(t){
 const root=mkdtempSync(join(repositoryRoot,'.codeql-test-'));
 t.after(()=>{assert.ok(root.startsWith(join(repositoryRoot,'.codeql-test-')));rmSync(root,{recursive:true,force:true});});
 return root;
}
const loc=(uri,line,endLine)=>({physicalLocation:{artifactLocation:{uri,index:0},region:{startLine:line,startColumn:1,...(endLine===undefined?{}:{endLine})}}});
const flow=uri=>({threadFlows:[{locations:[{location:loc(uri,1)},{location:loc(uri,2)}]},{locations:[{location:loc(uri,3)}]}]});
function fixture(t){
 const root=tempRoot(t);mkdirSync(join(root,'src'));writeFileSync(join(root,'src/identity.js'),'export const identity = 1;\nconst guard = true;\nuse(identity);\n// unrelated\n');
 const result={ruleId:'js/insufficient-password-hash',level:'warning',message:{text:'Synthetic idempotency digest'},locations:[loc('src/identity.js',1)],partialFingerprints:{primaryLocationLineHash:'fixture'},codeFlows:[flow('src/identity.js')]};
 const sarif={version:'2.1.0',runs:[{tool:{driver:{name:'CodeQL'}},results:[result]}]};
 const entry={id:'FP-001',disposition:'false_positive',rule:result.ruleId,path:'src/identity.js',line:1,fingerprint_v2:findingFingerprint(result,root),justification:'This synthetic reviewed digest identifies a request, not a password verifier. Source lines and result fingerprints must still match.'};
 const review={schema_version:'deft.codeql_false_positives.v2',review_source_commit:'0'.repeat(40),review_original_sarif_sha256:sha(JSON.stringify(sarif)),findings:[entry]};return {root,sarif,review};
}
function masterFixture(t){
 const root=tempRoot(t),bytes=readFileSync(masterPath),sarif=JSON.parse(bytes),review=JSON.parse(readFileSync(join(repositoryRoot,'.github/codeql-reviewed-false-positives.json'))),paths=new Set();
 for(const run of sarif.runs)for(const result of run.results){paths.add(result.locations[0].physicalLocation.artifactLocation.uri);for(const f of result.codeFlows??[])for(const thread of f.threadFlows)for(const step of thread.locations)paths.add(step.location.physicalLocation.artifactLocation.uri);}
 for(const path of paths){mkdirSync(dirname(join(root,path)),{recursive:true});copyFileSync(join(repositoryRoot,path),join(root,path));}return {root,sarif,review,bytes};
}
function shiftRegions(value,path,amount){
 if(!value||typeof value!=='object')return;
 if(value.artifactLocation?.uri===path&&value.region){value.region.startLine+=amount;if(value.region.endLine!==undefined)value.region.endLine+=amount;}
 for(const child of Object.values(value))shiftRegions(child,path,amount);
}
function changeLine(root,path,line){
 const file=join(root,path),lines=readFileSync(file,'utf8').split('\n');assert.ok(lines[line-1].length>0);lines[line-1]=(lines[line-1][0]==='X'?'Y':'X')+lines[line-1].slice(1);writeFileSync(file,lines.join('\n'));
}
test('repository-wide dispositions receive full CodeQL analysis on pull requests',()=>{
 const workflow=readFileSync(new URL('../.github/workflows/security.yml',import.meta.url),'utf8'),job=workflow.slice(workflow.indexOf('  codeql:'));
 assert.match(job,/CODEQL_ACTION_DIFF_INFORMED_QUERIES: 'false'/);assert.match(job,/CODEQL_OVERLAY_DATABASE_MODE: none/);assert.ok(job.indexOf('CODEQL_ACTION_DIFF_INFORMED_QUERIES')<job.indexOf('github/codeql-action/init@'));
 assert.match(job,/node scripts\/codeql-reviewed-findings\.mjs \.ci-codeql-diagnostics/);assert.match(job,/sarif_file: \.ci-codeql-diagnostics\/javascript\.sarif/);
});
test('reviewed result retains raw finding and accepted external suppression only in the clone',t=>{
 const f=fixture(t),before=structuredClone(f.sarif),r=reviewSarif(f.sarif,f.review,f.root);assert.equal(r.passed,true);assert.deepEqual(r.summary,{raw_findings:1,reviewed_false_positives:1,unresolved_findings:0,unused_reviews:[]});assert.deepEqual(f.sarif,before);
 const suppression=r.sarif.runs[0].results[0].suppressions[0];assert.equal(suppression.kind,'external');assert.equal(suppression.status,'accepted');assert.equal(suppression.justification,f.review.findings[0].justification);
});
test('drift and unrelated edits preserve a review; informational line is ignored',t=>{
 const f=fixture(t),file=join(f.root,'src/identity.js');writeFileSync(file,'\n'.repeat(5)+readFileSync(file,'utf8').replace('// unrelated','// changed outside the path'));shiftRegions(f.sarif,'src/identity.js',5);f.review.findings[0].line=999;assert.equal(reviewSarif(f.sarif,f.review,f.root).passed,true);
});
test('one character on a primary or flow-only line invalidates a review',t=>{
 const f=fixture(t),file=join(f.root,'src/identity.js'),before=readFileSync(file);for(const line of [1,2,3]){writeFileSync(file,before);changeLine(f.root,'src/identity.js',line);const r=reviewSarif(f.sarif,f.review,f.root);assert.equal(r.passed,false);assert.equal(r.summary.unresolved_findings,1);assert.deepEqual(r.summary.unused_reviews,['FP-001']);}
});
test('new findings and incoming accepted suppressions cannot bypass review',t=>{
 const f=fixture(t);f.sarif.runs[0].results.push({...structuredClone(f.sarif.runs[0].results[0]),ruleId:'js/xss',suppressions:[{kind:'external',status:'accepted',justification:'not trusted'}]});const r=reviewSarif(f.sarif,f.review,f.root);assert.equal(r.passed,false);assert.equal(r.summary.unresolved_findings,1);assert.deepEqual(r.sarif.runs[0].results[1].suppressions,[]);
});
test('changed message, line hash, rule, level, path, or step message requires renewed review',t=>{
 const f=fixture(t);for(const change of [r=>r.message.text+=' changed',r=>r.partialFingerprints.primaryLocationLineHash='changed',r=>r.ruleId='js/xss',r=>r.level='error',r=>r.locations[0].physicalLocation.artifactLocation.uri='src/foreign.js',r=>r.codeFlows[0].threadFlows[0].locations[0].location.message={text:'new source'}]){const s=structuredClone(f.sarif);change(s.runs[0].results[0]);const r=reviewSarif(s,f.review,f.root);assert.equal(r.passed,false);assert.equal(r.summary.unresolved_findings,1);}
});
test('missing source and out-of-range or malformed primary/flow regions fail closed',t=>{
 const f=fixture(t);for(const location of [r=>r.locations[0],r=>r.codeFlows[0].threadFlows[0].locations[1].location])for(const region of [{startLine:0},{startLine:99},{startLine:1,endLine:99},{startLine:2,endLine:1},{startLine:1.5},undefined]){const s=structuredClone(f.sarif);location(s.runs[0].results[0]).physicalLocation.region=region;const r=reviewSarif(s,f.review,f.root);assert.equal(r.passed,false);assert.equal(r.summary.unresolved_findings,1);}
 rmSync(join(f.root,'src/identity.js'));assert.equal(reviewSarif(f.sarif,f.review,f.root).passed,false);
});
test('symlink sources and directory ancestors fail closed',t=>{
 const f=fixture(t),file=join(f.root,'src/identity.js'),target=join(f.root,'identity-target.js');copyFileSync(file,target);rmSync(file);
 try{symlinkSync(target,file,'file');}catch(error){if(process.platform!=='win32'||error.code!=='EPERM')throw error;t.diagnostic('File symlink privilege unavailable; exercising a directory junction source instead.');copyFileSync(target,file);}
 if(lstatSync(file).isSymbolicLink())assert.equal(reviewSarif(f.sarif,f.review,f.root).passed,false);
 rmSync(join(f.root,'src'),{recursive:true,force:true});mkdirSync(join(f.root,'real-src'));copyFileSync(target,join(f.root,'real-src/identity.js'));symlinkSync(join(f.root,'real-src'),join(f.root,'src'),process.platform==='win32'?'junction':'dir');assert.equal(reviewSarif(f.sarif,f.review,f.root).passed,false);
});
test('unsafe primary and flow paths cannot inherit review',t=>{
 const f=fixture(t);for(const path of ['../private','/absolute','C:/absolute','src\\..\\private','src//identity.js','src/./identity.js','src/%69dentity.js']){assert.throws(()=>reviewSarif(f.sarif,{...f.review,findings:[{...f.review.findings[0],path}]},f.root),/INVALID_REVIEW/);const s=structuredClone(f.sarif);s.runs[0].results[0].codeFlows[0].threadFlows[0].locations[1].location.physicalLocation.artifactLocation.uri=path;assert.equal(reviewSarif(s,f.review,f.root).passed,false);}
});
test('missing flow-only source, outside-root junction and invalid UTF-8 fail closed',t=>{
 const f=fixture(t),result=f.sarif.runs[0].results[0],other=join(f.root,'src/flow.js');
 copyFileSync(join(f.root,'src/identity.js'),other);
 result.codeFlows=[flow('src/flow.js')];f.review.findings[0].fingerprint_v2=findingFingerprint(result,f.root);
 assert.equal(reviewSarif(f.sarif,f.review,f.root).passed,true);
 rmSync(other);assert.equal(reviewSarif(f.sarif,f.review,f.root).passed,false);
 writeFileSync(other,Buffer.from([0xff,0x0a]));assert.equal(reviewSarif(f.sarif,f.review,f.root).passed,false);
 rmSync(other);
 const outside=tempRoot(t);writeFileSync(join(outside,'flow.js'),'outside');
 symlinkSync(outside,join(f.root,'external'),process.platform==='win32'?'junction':'dir');
 result.codeFlows=[flow('external/flow.js')];assert.equal(reviewSarif(f.sarif,f.review,f.root).passed,false);
});
test('duplicate findings, duplicate reviews and removed findings fail closed',t=>{
 const f=fixture(t),repeated=structuredClone(f.sarif);repeated.runs[0].results.push(structuredClone(repeated.runs[0].results[0]));const duplicate=reviewSarif(repeated,f.review,f.root);assert.equal(duplicate.passed,false);assert.equal(duplicate.findings[1].disposition,'duplicate_finding');assert.throws(()=>reviewSarif(f.sarif,{...f.review,findings:[...f.review.findings,f.review.findings[0]]},f.root),/DUPLICATE_REVIEW/);const empty=structuredClone(f.sarif);empty.runs[0].results=[];const stale=reviewSarif(empty,f.review,f.root);assert.equal(stale.passed,false);assert.deepEqual(stale.summary.unused_reviews,['FP-001']);
});
test('only well-formed v2 false-positive manifests and CodeQL SARIF are accepted',t=>{
 const f=fixture(t);assert.throws(()=>reviewSarif({...f.sarif,version:'unknown'},f.review,f.root),/INVALID_SARIF/);for(const change of [v=>v.schema_version='deft.codeql_false_positives.v1',v=>v.sources={},v=>v.review_source_commit='bad',v=>v.findings=[null],v=>v.findings[0].disposition='risk_accepted',v=>v.findings[0].fingerprint_v2='bad',v=>v.findings[0].sources=[],v=>v.findings[0].line=0,v=>v.findings[0].justification='too short']){const review=structuredClone(f.review);change(review);assert.throws(()=>reviewSarif(f.sarif,review,f.root),/INVALID_REVIEW/);}
});
test('manifest metadata cannot pass validation by string coercion',t=>{
 const f=fixture(t);
 for(const key of ['review_source_commit','review_original_sarif_sha256']){
  const review=structuredClone(f.review);review[key]=[review[key]];
  assert.throws(()=>reviewSarif(f.sarif,review,f.root),/INVALID_REVIEW/);
 }
});
test('CLI preserves original bytes and artifact fields; helper prints matching v2 fingerprints',t=>{
 const f=fixture(t);mkdirSync(join(f.root,'.github'));writeFileSync(join(f.root,'.github/codeql-reviewed-false-positives.json'),JSON.stringify(f.review));const dir=join(f.root,'output');mkdirSync(dir);const raw=JSON.stringify(f.sarif);writeFileSync(join(dir,'javascript.sarif'),raw);assert.equal(main(dir,f.root).passed,true);assert.equal(readFileSync(join(dir,'javascript.sarif'),'utf8'),raw);assert.equal(JSON.parse(readFileSync(join(dir,'disposition.json'),'utf8')).gate,'passed');
 const findings=JSON.parse(readFileSync(join(dir,'findings.json'),'utf8'));assert.equal(findings.length,1);assert.deepEqual(Object.keys(findings[0]),['rule','level','locations','fingerprint','disposition','review_id']);assert.equal(findings[0].fingerprint,f.review.findings[0].fingerprint_v2);assert.equal(JSON.parse(readFileSync(join(dir,'reviewed/javascript.sarif'),'utf8')).runs[0].results[0].suppressions[0].status,'accepted');
 const helper=spawnSync(process.execPath,[join(repositoryRoot,'scripts/codeql-reviewed-findings-fingerprint.mjs'),join(dir,'javascript.sarif'),f.root],{encoding:'utf8'});assert.equal(helper.status,0,helper.stderr);assert.equal(JSON.parse(helper.stdout)[0].fingerprint_v2,f.review.findings[0].fingerprint_v2);
});
test('outer flow permutation is stable; thread order, step order, duplicates and URIs stay pinned',t=>{
 const f=fixture(t);writeFileSync(join(f.root,'src/b.js'),readFileSync(join(f.root,'src/identity.js')));const a=flow('src/identity.js'),b=flow('src/b.js'),result={...f.sarif.runs[0].results[0],codeFlows:[a,b,a]},hash=findingFingerprint(result,f.root);assert.equal(findingFingerprint({...result,codeFlows:[b,a,a]},f.root),hash);
 for(const flows of [[a,b],[a,b,a,a],[a,{threadFlows:[...b.threadFlows].reverse()},a],[a,{threadFlows:[{locations:[...b.threadFlows[0].locations].reverse()},b.threadFlows[1]]},a]])assert.notEqual(findingFingerprint({...result,codeFlows:flows},f.root),hash);
});
test('multiline regions pin whole lines, ignore columns and trim only trailing whitespace',t=>{
 const f=fixture(t),r=f.sarif.runs[0].results[0],file=join(f.root,'src/identity.js');r.locations=[loc('src/identity.js',1,2)];const before=findingFingerprint(r,f.root);r.locations[0].physicalLocation.region.startColumn=12;r.locations[0].physicalLocation.region.endColumn=13;assert.equal(findingFingerprint(r,f.root),before);writeFileSync(file,readFileSync(file,'utf8').replaceAll('\n',' \t\r\n'));assert.equal(findingFingerprint(r,f.root),before);changeLine(f.root,'src/identity.js',2);assert.notEqual(findingFingerprint(r,f.root),before);
});
test('master SARIF matches all 26 v2 reviews',masterOptions,t=>{
 const f=masterFixture(t);assert.equal(sha(f.bytes),f.review.review_original_sarif_sha256);const r=reviewSarif(f.sarif,f.review,f.root);assert.equal(r.passed,true);assert.deepEqual(r.summary,{raw_findings:26,reviewed_false_positives:26,unresolved_findings:0,unused_reviews:[]});
});
test('master passes 26/26 after five blank lines shift every region in a flagged file',masterOptions,t=>{
 const f=masterFixture(t),path=f.review.findings.find(entry=>entry.id==='FP-003').path,file=join(f.root,path);writeFileSync(file,'\n'.repeat(5)+readFileSync(file,'utf8'));shiftRegions(f.sarif,path,5);const r=reviewSarif(f.sarif,f.review,f.root);assert.equal(r.passed,true);assert.equal(r.summary.reviewed_false_positives,26);assert.equal(r.summary.unresolved_findings,0);
});
test('master flow-line mutation makes its finding unresolved',masterOptions,t=>{
 const f=masterFixture(t),result=f.sarif.runs[0].results.find(r=>r.codeFlows?.[0]?.threadFlows?.[0]?.locations?.length),physical=result.codeFlows[0].threadFlows[0].locations[0].location.physicalLocation;changeLine(f.root,physical.artifactLocation.uri,physical.region.startLine);const r=reviewSarif(f.sarif,f.review,f.root);assert.equal(r.passed,false);assert.ok(r.summary.unresolved_findings>=1);assert.equal(r.findings[f.sarif.runs[0].results.indexOf(result)].review_id,null);
});
