import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperienceFileController,selectedExperienceFilePolicy,validateExperienceRichtextEdit} from './app-experience-controls';
import {parseExperienceView} from './app-experience-bridge';
import {plainTextToRichtextHtml,parseTrustedRichtextHtml} from '../../../../packages/app-kit/src/safe-rich-text';
import {createDeftFileFieldNode,createDeftRichtextFieldNode} from '../../../../packages/app-kit/src/experience-sdk';
const record='11111111-1111-4111-8111-111111111111';
const fileNode=createDeftFileFieldNode({id:'files',label:'Attachments',state_key:'drafts',record_id:record,expected_revision:1,
  profile:{profile_version:'deft.file_field.v1',max_files:2,max_file_bytes:1024,max_total_bytes:2048,purpose:'attachment'}},['file_field.v1']);
const policy={max_file_bytes:2097152,max_files_per_record:8,max_total_bytes_per_record:8388608,allowed_media_types:['text/plain']};
const empty={schema_version:'deft.private_files.v1',draft:{record_id:record,revision:1},files:[]};
test('paired generic rich draft saves/reopens exact leading/tab/blank text and links',()=>{
  const plain='  lead\tvalue\n\ntrailing  ',html=plainTextToRichtextHtml(plain);
  const node=createDeftRichtextFieldNode({id:'body',label:'Message',profile:{profile_version:'deft.richtext_field.v1',format:'safe_compose_html',
    max_characters:4096,max_bytes:16384,links:'host_validated',inline_images:'none'},value:{html,plain_text:plain}},['richtext_field.v1']);
  const saved=JSON.stringify({body:node.value.plain_text,body_html:node.value.html});
  const reopened=JSON.parse(saved);assert.equal(reopened.body,plain);assert.equal(parseTrustedRichtextHtml(reopened.body_html).plainText,plain);
  const linked=parseTrustedRichtextHtml('<p>  <a href="https://example.test/notes">notes</a>  </p>');
  assert.deepEqual(validateExperienceRichtextEdit(node,linked),{html:linked.html,plain_text:linked.plainText});
  assert.throws(()=>validateExperienceRichtextEdit(node,{html:'<p>other</p>',plainText:plain}));
  assert.throws(()=>validateExperienceRichtextEdit(node,{html:'',plainText:'x'.repeat(4097)}));
});
test('generic nodes require their exact negotiated capability and declared state custody',()=>{
  const view={schema_version:'deft.experience_view.v2',capabilities:['file_field.v1'],root:fileNode};
  assert.ok(parseExperienceView(view,{capabilities:['file_field.v1'],stateKeys:['drafts']}));
  assert.equal(parseExperienceView(view,{capabilities:['resource_document.v1'],stateKeys:['drafts']}),null);
  assert.equal(parseExperienceView(view,{capabilities:['file_field.v1'],stateKeys:['other']}),null);
  assert.equal(parseExperienceView({...view,capabilities:['file_field.v1','file_field.v1']},{capabilities:['file_field.v1'],stateKeys:['drafts']}),null);
  assert.throws(()=>createDeftFileFieldNode({...fileNode,profile:{...fileNode.profile,purpose:'inline_raster'}},['file_field.v1']));
  assert.throws(()=>createDeftRichtextFieldNode({id:'body',label:'Message',profile:{profile_version:'deft.richtext_field.v1',format:'safe_compose_html',
    max_characters:4096,max_bytes:16384,links:'host_validated',inline_images:'host_files'},value:{html:'',plain_text:''}},['richtext_field.v1']));
});
test('file policy only lowers reviewed limits; expired/foreign draft and late work are rejected',async()=>{
  assert.equal(selectedExperienceFilePolicy(fileNode,policy).max_file_bytes,1024);
  assert.equal(selectedExperienceFilePolicy({...fileNode,profile:{...fileNode.profile,max_file_bytes:1024,max_total_bytes:2048}},
    {...policy,max_file_bytes:512}).max_file_bytes,512);
  for(const raw of [{...empty,draft:{record_id:'22222222-2222-4222-8222-222222222222',revision:1}},
    {...empty,draft:{record_id:record,revision:2}}]){
    const host=createExperienceFileController({node:fileNode,current:()=>true,signal:new AbortController().signal,policy:async()=>policy,call:async()=>raw});
    await assert.rejects(host.load());
  }
  let release!:(raw:unknown)=>void,current=true;
  const pending=new Promise<unknown>(resolve=>{release=resolve;});
  const host=createExperienceFileController({node:fileNode,current:()=>current,signal:new AbortController().signal,policy:async()=>policy,call:()=>pending});
  const load=host.load();await Promise.resolve();current=false;release(empty);await assert.rejects(load,/scope changed/);
});
test('upload checks saved exact bytes and revision; unsupported files never reach custody',async()=>{
  let calls=0;
  const host=createExperienceFileController({node:fileNode,current:()=>true,signal:new AbortController().signal,policy:async()=>policy,
    call:async()=>{calls++;return empty;}});
  await host.load();await assert.rejects(host.upload(new File(['abc'],'payload.exe',{type:'application/octet-stream'})));assert.equal(calls,1);
  await assert.rejects(host.upload(new File(['abc'],'payload.txt',{type:'text/plain'})),/upload not confirmed/);assert.equal(calls,2);
});
test('confirmed scoped upload and reopen retain the same file ID/digest; detach preserves other catalog rows',async()=>{
  const file=new File(['exact bytes\n'],'retained.txt',{type:'text/plain'}),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),byte=>byte.toString(16).padStart(2,'0')).join('');
  const fileId='22222222-2222-4222-8222-222222222222';let saved:any=empty;
  const call=async(suffix:string,options:RequestInit)=>{
    if(options.method==='POST'){const query=new URLSearchParams(suffix.slice(1));assert.equal(query.get('expected_revision'),'1');assert.equal(options.body,file);
      saved={...empty,draft:{record_id:record,revision:2},files:[{file_id:fileId,upload_operation_id:query.get('upload_operation_id'),filename:file.name,media_type:file.type,
        byte_length:file.size,digest,expires_at:new Date(Date.now()+60000).toISOString()}]};}
    if(options.method==='DELETE'){assert.equal(suffix,`/${fileId}`);assert.equal(JSON.parse(String(options.body)).expected_revision,2);saved={...empty,draft:{record_id:record,revision:3}};}
    return saved;
  };
  const host=createExperienceFileController({node:fileNode,current:()=>true,signal:new AbortController().signal,policy:async()=>policy,call});
  await host.load();const uploaded=await host.upload(file);assert.equal(uploaded.files[0].file_id,fileId);assert.equal(uploaded.files[0].digest,digest);
  const reopened=createExperienceFileController({node:{...fileNode,expected_revision:2},current:()=>true,signal:new AbortController().signal,policy:async()=>policy,call});
  assert.deepEqual((await reopened.load()).files,uploaded.files);assert.deepEqual((await reopened.remove(fileId)).files,[]);
});
