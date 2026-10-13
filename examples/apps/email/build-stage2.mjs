import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {prepareDeftExperienceArtifact,buildDeftAppPackage} from '@deft/app-kit';

// Build on the exact currently reviewed package, preserving its metadata,
// private-file quotas and all declarations outside the explicit Stage2 delta.
const baselinePath=process.argv[2],out=resolve(process.argv[3]||'package-stage2.2');
assert.ok(baselinePath,'Exact reviewed baseline package is required');
const baseline=JSON.parse(readFileSync(baselinePath,'utf8'));
assert.equal(baseline.manifest.id,'io.deft.email');
assert.ok(['1.6.0-stage1.6','1.6.0-stage2.1'].includes(baseline.manifest.version),'Reviewed Stage1.6 or current UI2.1 baseline required');
assert.equal(baseline.artifacts.length,1);
mkdirSync(out,{recursive:true});
const bundle=await build({entryPoints:[fileURLToPath(new URL('./worker.mjs',import.meta.url))],outfile:resolve(out,'worker.bundle.js'),bundle:true,minify:true,format:'iife',platform:'browser',target:'es2022',metafile:true});
assert.ok(!Object.keys(bundle.metafile.inputs).some(path=>path.endsWith('/dist/index.js')||path.includes('/node_modules/zod/')));
const worker=readFileSync(resolve(out,'worker.bundle.js'));
const actions=['permanent_delete_message','send_message','triage_message'];
const before=JSON.parse(baseline.artifacts[0].content);
const artifact=await prepareDeftExperienceArtifact(baseline.artifacts[0].path,{...before,worker_source:worker.toString(),action_keys:actions,state_keys:['drafts','preferences','requests']});
const manifest=structuredClone(baseline.manifest);
manifest.version='1.6.0-stage2.2';manifest.experiences[0].artifact_digest=artifact.digest;
const string=maxLength=>({type:'string',maxLength});
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const send=manifest.private_capabilities.find(row=>row.key==='send_message');
send.input_schema.properties.bcc={...string(2048),format:'mailbox_list',maxItems:32,title:'Bcc'};
send.input_schema.properties.body={...send.input_schema.properties.body,readOnly:true};
send.input_schema.properties.body_html={...string(16384),format:'safe_html',plainTextKey:'body',title:'Message'};
send.input_schema.required.push('bcc','body_html');
const triageInput=object({record_ids:{...string(925),minLength:36,format:'resource_record_list',maxItems:25,resourceKey:'inbox',readOnly:true,title:'Selected messages'},operation:{...string(32),format:'single_line'},destination:{...string(256),format:'single_line'},add_labels:{...string(4096),format:'single_line'},remove_labels:{...string(4096),format:'single_line'}});
const triageOutput=object({operation_id:string(120),succeeded_count:{type:'number',minimum:0,maximum:25},failed_count:{type:'number',minimum:0,maximum:25},unknown_count:{type:'number',minimum:0,maximum:25},undo_available:{type:'boolean'},automatic_retry:{type:'boolean'},items:string(4096)});
for(const key of actions.filter(key=>key!=='send_message')){
 manifest.private_capabilities.push({key,version:'1',input_schema:triageInput,output_schema:triageOutput});
 manifest.runtime_actions.push({key,label:key==='permanent_delete_message'?'Permanently delete messages':'Change mailbox',capability_key:key,runtime_requirement_key:'mail_provider'});
}
const inbox=manifest.resource_content.find(row=>row.resource_key==='inbox');
inbox.document.formats=['plain','html'];
inbox.source={media_type:'message/rfc822',filename:'message.eml',max_bytes:8388608};
inbox.triage_options={max_options:100};
inbox.search_filters=['text','from','to','cc','bcc','subject','filename','has_attachments','received_on','after','before','unread','flagged'];
manifest.owner_connections.find(row=>row.resource_key==='inbox').action_keys=actions;
const drafts=manifest.private_state.find(row=>row.key==='drafts');
drafts.schema.properties.bcc=string(2048);drafts.schema.properties.body_html=string(16384);
// Legacy values remain readable after explicit host adoption; opening saves the new empty optional fields before any capture.

manifest.private_state.push({key:'preferences',label:'Private email preferences',schema:object({signature:string(2048)}),max_record_bytes:4096,max_records:1,max_total_bytes:4096,retention_days:30});
manifest.private_state.sort((a,b)=>a.key.localeCompare(b.key));
const pkg=await buildDeftAppPackage({manifest,artifacts:[artifact]});
writeFileSync(resolve(out,'app.deft.json'),pkg.json);
writeFileSync(resolve(out,'artifact.json'),JSON.stringify(artifact));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const proof={version:manifest.version,package_digest:pkg.digest,artifact_digest:artifact.digest,worker_sha256:sha(worker),baseline_sha256:sha(readFileSync(baselinePath)),normalBundler:true,permission_changes:['triage and separately confirmed permanent deletion','reviewed HTML document and original EML read up to 8 MiB','up to 100 current triage options and 13 typed provider search filters','Bcc and paired rich/plain private draft fields','one encrypted signature preference up to 2048 characters with 30-day retention'],unchanged_file_limits:drafts.files,staged:false,activated:false};
writeFileSync(resolve(out,'build-proof.json'),JSON.stringify(proof,null,2));
console.log(JSON.stringify(proof));
