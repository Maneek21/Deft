import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {ExperienceRecordPreview} from '../components/apps/experience-record-form';
import {DeftExperienceRecordFormNodeSchema} from '../../../../packages/app-kit/src/app-data';
import {ExperienceComposeFilesControl} from '../components/apps/experience-compose-controls';
test('saved file rows offer Download independently of attachment mutation controls',()=>{
 const html=renderToStaticMarkup(<ExperienceComposeFilesControl {...({label:'Files',files:[{key:'file',filename:'synthetic.pdf',byteCount:1840,status:'ready'}],onDownload:()=>{}} as any)}/>);
 assert.match(html,/Download synthetic.pdf/);assert.doesNotMatch(html,/Add files|Remove synthetic.pdf|unavailable for this draft/);
});
test('actual trusted submitted/archived preview offers Download with document body and no mutation or Send controls',()=>{
 const file={file_id:'22222222-2222-4222-8222-222222222222',filename:'synthetic.pdf',media_type:'application/pdf',size_bytes:1840,sha256:'a'.repeat(64)};
 const node=DeftExperienceRecordFormNodeSchema.parse({kind:'record_form',id:'form',label:'Draft',store_key:'drafts',record_id:'11111111-1111-4111-8111-111111111111',expected_revision:1,content_digest:'sha256:'+'b'.repeat(64),action_key:'send_message',disabled:false,profile:{schema_version:'deft.record_form_profile.v1',max_record_bytes:491520,addresses:[{field:'to',label:'To',optional:false}],subject:{field:'subject',label:'Subject',max_characters:998},richtext:{html_field:'body_html',plain_field:'body',label:'Message',max_characters:262144,links:'host_validated',inline_images:'host_files'},files:{field:'attachments',max_files:32,max_file_bytes:26214400,max_total_bytes:26214400}}});
 let mutations=0;const value={to:'synthetic@example.test',subject:'Synthetic',body:'  lead\ttext\n\n',body_html:'',attachments:[file],mode:'reply_all',reply_record_id:'private-origin',managed_signature:{identity_key:'internal-key'}};
 for(const status of ['submitted','archived'] as const){const row={record_id:node.record_id,revision:7,content_digest:node.content_digest,status,value,files:[{file_id:file.file_id,upload_revision:3,sha256:'sha256:'+file.sha256}]};
  const ports={readFile:async()=>new Uint8Array(),save:async()=>{mutations++;throw Error('Denied');},upload:async()=>{mutations++;throw Error('Denied');},detach:async()=>{mutations++;throw Error('Denied');},review:async()=>{mutations++;return false;}} as any;
  const html=renderToStaticMarkup(<ExperienceRecordPreview node={node} row={row} value={value} ports={ports} signal={new AbortController().signal} current={()=>true}/>);
  assert.match(html,/Download synthetic.pdf/);assert.match(html,/Download all files \(.zip\)/);assert.match(html,/role="document"/);assert.match(html,/  lead\ttext\n\n/);assert.doesNotMatch(html,/textarea|Add formatting|Use plain text|role="toolbar"|private-origin|reply record id|internal-key/);assert.doesNotMatch(html,/Add files|Remove synthetic.pdf|Review &amp; send|Save draft/);
 }assert.equal(mutations,0);
});

import {ExperienceComposeRichEditor} from '../components/apps/experience-compose-controls-rich-editor';
test('readonly rich presentation retains validated document renderer without edit controls',()=>{
 let writes=0;const html=renderToStaticMarkup(<ExperienceComposeRichEditor label="Message" value={{html:'<p><strong>Synthetic</strong></p>',plainText:'Synthetic'}} maxCharacters={262144} maxPlainCharacters={262144} nativeLinks preserveWhitespace presentationOnly onChange={()=>{writes++;}}/>);
 assert.match(html,/role="document"/);assert.doesNotMatch(html,/role="toolbar"|textarea|Use plain text|Add formatting|formatting characters/);assert.equal(writes,0);
});
test('invalid retained rich HTML is never rendered as markup or editable source in readonly presentation',()=>{
 const html=renderToStaticMarkup(<ExperienceComposeRichEditor label="Message" value={{html:'<script>private-script</script>',plainText:'  retained\ttext\n\n'}} maxCharacters={262144} maxPlainCharacters={262144} nativeLinks presentationOnly onChange={()=>{throw Error('No writes');}}/>);
 assert.match(html,/Formatting unavailable/);assert.match(html,/  retained\ttext\n\n/);assert.doesNotMatch(html,/private-script|textarea|toolbar/);
});

test('readonly headers show the stored sender object, never infer a missing sender, and reject invalid mapped data',()=>{
 const node=DeftExperienceRecordFormNodeSchema.parse({kind:'record_form',id:'view',label:'History',store_key:'drafts',record_id:'11111111-1111-4111-8111-111111111111',expected_revision:1,content_digest:'sha256:'+'b'.repeat(64),profile:{schema_version:'deft.record_form_profile.v1',max_record_bytes:491520,addresses:[{field:'to',label:'To',optional:false},{field:'cc',label:'Cc',optional:true},{field:'bcc',label:'Bcc',optional:true}],subject:{field:'subject',label:'Subject',max_characters:998},identity:{field:'from_identity',address_field:'address',label:'From'},richtext:{html_field:'body_html',plain_field:'body',label:'Message',max_characters:262144,links:'host_validated',inline_images:'host_files'},files:{field:'attachments',max_files:32,max_file_bytes:26214400,max_total_bytes:26214400}}});
 const value={to:'Synthetic recipient <recipient@example.test>',cc:'copy@example.test',bcc:'blind@example.test',subject:'Synthetic',body:'  preserved\ttext\n\n',body_html:'',attachments:[],mode:'forward',reply_record_id:'internal-source',from_identity:{address:'saved@example.test'}};
 const render=(value:Record<string,unknown>)=>renderToStaticMarkup(<ExperienceRecordPreview node={node} row={{record_id:node.record_id,revision:2,content_digest:node.content_digest,status:'submitted',value}} value={value} ports={{} as any} signal={new AbortController().signal} current={()=>true}/>);
 const html=render(value);assert.match(html,/saved@example.test/);assert.match(html,/copy@example.test/);assert.match(html,/blind@example.test/);assert.match(html,/  preserved\ttext\n\n/);assert.doesNotMatch(html,/internal-source|forward/);
 const {from_identity,...missing}=value;assert.match(render(missing),/Not recorded in this saved draft/);assert.doesNotMatch(render(missing),/saved@example.test/);
 assert.throws(()=>render({...value,from_identity:'invalid'}),/Record identity unavailable/);
 assert.throws(()=>render({...value,body_html:'<p>different</p>'}),/Record body pair changed/);
});
