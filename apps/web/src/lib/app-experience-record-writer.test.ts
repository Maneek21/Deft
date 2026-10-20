import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperienceRecordWriter,experienceRecordSubmissionEvent,type ExperienceRecordRow} from './app-experience-record-writer';
import {validateRecordFormValue,experienceRecordFormMode} from './app-experience-record-form';
import {DeftExperienceRecordFormNodeSchema} from '../../../../packages/app-kit/src/app-data';
import {createDeftRecordFormNode} from '../../../../packages/app-kit/src/experience-sdk';
import {parseExperienceView} from './app-experience-bridge';
const id='11111111-1111-4111-8111-111111111111',digest='sha256:'+'a'.repeat(64);
const profile={schema_version:'deft.record_form_profile.v1' as const,max_record_bytes:491520,addresses:[{field:'to',label:'To',optional:false},{field:'bcc',label:'Bcc',optional:true}],
 identity:{field:'from_identity',address_field:'address',label:'From'},subject:{field:'subject',label:'Subject',max_characters:998},richtext:{html_field:'body_html',plain_field:'body',label:'Message',max_characters:262144,links:'host_validated' as const,inline_images:'host_files' as const},files:{field:'attachments',max_files:32,max_file_bytes:26214400,max_total_bytes:26214400}};
const value=()=>({to:'a@example.test',bcc:'b@example.test',subject:'subject',body:'',body_html:'',attachments:[],mode:'compose',opaque_kept:{value:'Unedited metadata'}});
function fixture(save?:(row:ExperienceRecordRow,captured:Record<string,unknown>)=>Promise<ExperienceRecordRow>){let stored:ExperienceRecordRow={record_id:id,revision:1,content_digest:digest,status:'draft',value:value()},live=true;
 const writes:Record<string,unknown>[]=[],requests:string[]=[],events:unknown[]=[];const abort=new AbortController();
 const writer=createExperienceRecordWriter({initial:stored,current:()=>live,signal:abort.signal,validate:next=>validateRecordFormValue(next,profile),read:async()=>structuredClone(stored),
 save:async(revision,captured,requestId,expected)=>{assert.equal(revision,stored.revision);assert.equal(expected,stored.content_digest);writes.push(captured);requests.push(requestId);stored=save?await save(stored,captured):{...stored,revision:revision+1,value:captured};return structuredClone(stored);},change:event=>events.push(event)});
 return {writer,writes,requests,events,abort,stored:()=>stored,revoke:()=>{live=false;}};
}
test('large native plain draft saves and reopens exact tabs, CRLF, Unicode and unedited fields',async()=>{
 const f=fixture(),plain='  leading\ttext\r\n\r\n中 🪴 '+ 'long body  '.repeat(12000)+'\ntrailing  ';
 assert.ok(plain.length>65536);f.writer.edit({...value(),body:plain});assert.equal(await f.writer.save(),true);
 assert.equal(f.writes[0].body,plain);assert.equal(f.writer.snapshot.value.body,plain);assert.deepEqual(f.writer.snapshot.value.opaque_kept,value().opaque_kept);
 f.writer.edit({...value(),body:'local edit'});assert.equal(await f.writer.reopen(),true);assert.equal(f.writer.snapshot.value.body,plain);assert.equal(f.writer.snapshot.dirty,false);
 assert.equal(f.requests.length,1);assert.match(f.requests[0],/^[a-f0-9-]{36}$/u);
});
test('rich HTML/plain pairing and full JSON budgets fail before any write',async()=>{
 const f=fixture();f.writer.edit({...value(),body_html:'<p>Hello</p>',body:'different'});assert.equal(await f.writer.save(),false);assert.equal(f.writes.length,0);
 f.writer.edit({...value(),body:'x'.repeat(262145)});assert.equal(await f.writer.save(),false);assert.equal(f.writes.length,0);
 f.writer.edit({...value(),body:'x'.repeat(250000),unmapped:'x'.repeat(250000)});assert.equal(await f.writer.save(),false);assert.equal(f.writes.length,0);
 f.writer.edit({...value(),body_html:'<p> Hello  world </p>',body:' Hello  world '});assert.equal(await f.writer.save(),true);
 assert.equal(f.writer.snapshot.value.body_html,'<p> Hello  world </p>');
});
test('large rich draft keeps exact persisted source and CID while reopening',async()=>{
 const file={file_id:'44444444-4444-4444-8444-444444444444',filename:'inline.png',media_type:'image/png',size_bytes:67,sha256:'b'.repeat(64)};
 const plain='  large\ttext  '.repeat(12000)+'\n[Image: inline.png]',html='<p>'+ '  large\ttext  '.repeat(12000)+'</p><p><img src="cid:deft-compose-44444444-4444-4444-8444-444444444444@inline" alt="inline.png"></p>';
 // Canonical CID generation is shared with the frozen native writer.
 const f=fixture();const {richtextImageReference,parseTrustedRichtextHtml}=await import('../../../../packages/app-kit/src/safe-rich-text');
 const exact=html.replace('deft-compose-44444444-4444-4444-8444-444444444444@inline',richtextImageReference(file.file_id));
 const pair=parseTrustedRichtextHtml(exact,{inlineAttachments:[file]});assert.ok(pair.html.length>65536);assert.ok(pair.plainText.length>65536);
 f.writer.edit({...value(),body:pair.plainText,body_html:pair.html,attachments:[file]});assert.equal(await f.writer.save(),true);
 assert.equal(await f.writer.reopen(),true);assert.equal(f.writer.snapshot.value.body_html,pair.html);assert.equal(f.writer.snapshot.value.body,pair.plainText);
 assert.deepEqual(f.writer.snapshot.value.attachments,[file]);assert.ok(plain.length>65536);
});
test('one CAS writer drains text changes and files wait for confirmed text',async()=>{
 let release!:(row:ExperienceRecordRow)=>void;const f=fixture(async(row,captured)=>new Promise(resolve=>{release=next=>resolve(next);queueMicrotask(()=>release({...row,revision:row.revision+1,value:captured}));}));
 f.writer.edit({...value(),body:'before file'});let calls=0;assert.equal(await f.writer.mutate(async revision=>{calls++;assert.equal(revision,2);assert.equal(f.writer.snapshot.value.body,'before file');return {...f.stored(),revision:3,value:{...f.stored().value,subject:'after file'}};}),true);
 assert.equal(calls,1);assert.equal(f.writes.length,1);assert.equal(f.writer.snapshot.row.revision,3);
});
test('unknown write blocks later mutation until explicit reopen; late revoked replies do not publish',async()=>{
 const failed=fixture(async()=>{throw Error('response lost');});failed.writer.edit({...value(),body:'kept locally'});assert.equal(await failed.writer.save(),false);assert.equal(failed.writer.snapshot.state,'blocked');
 assert.equal(failed.writer.edit(value()),false);assert.equal(await failed.writer.mutate(async()=>{throw Error('must not run');}),false);assert.equal(await failed.writer.save(),false);assert.equal(failed.writes.length,1);
 assert.equal(failed.writer.snapshot.value.body,'kept locally');assert.equal(await failed.writer.reopen(),true);
 let resolve!:(row:ExperienceRecordRow)=>void;const late=fixture(()=>new Promise(done=>{resolve=done;}));late.writer.edit({...value(),body:'late'});const pending=late.writer.save(),events=late.events.length;
 late.abort.abort();resolve({...late.stored(),revision:2,value:{...value(),body:'late'}});assert.equal(await pending,false);assert.equal(late.events.length,events);assert.equal(late.writer.snapshot.row.revision,1);
});
test('record controls require signed negotiation and declared store/action; colliding fields deny before mount',()=>{
 const node={kind:'record_form',id:'form',label:'Draft',store_key:'drafts',record_id:id,expected_revision:1,content_digest:digest,profile,action_key:'send_message'};
 const view={schema_version:'deft.experience_view.v2',capabilities:['record_form.v1'],root:node};
 assert.ok(parseExperienceView(view,{capabilities:['record_form.v1'],storeKeys:['drafts'],actionKeys:['send_message']}));
 assert.equal(parseExperienceView(view,{capabilities:[],storeKeys:['drafts'],actionKeys:['send_message']}),null);
 assert.equal(parseExperienceView(view,{capabilities:['record_form.v1'],storeKeys:[],actionKeys:['send_message']}),null);
 assert.equal(parseExperienceView(view,{capabilities:['record_form.v1'],storeKeys:['drafts'],actionKeys:[]}),null);
 assert.equal(DeftExperienceRecordFormNodeSchema.safeParse({...node,profile:{...profile,richtext:{...profile.richtext,html_field:'body'}}}).success,false);
});
test('minimized forms require negotiated presentation and reject unknown modes before mounting',()=>{
 const input={id:'form',label:'Draft',store_key:'drafts',record_id:id,expected_revision:1,content_digest:digest,profile,presentation:'minimized' as const};
 const capabilities=['record_form.v1','record_form_presentation.v1'] as const;
 const node=createDeftRecordFormNode(input,capabilities),view={schema_version:'deft.experience_view.v2',capabilities:[...capabilities],root:node};
 assert.ok(parseExperienceView(view,{capabilities,storeKeys:['drafts']}));
 assert.throws(()=>createDeftRecordFormNode(input,['record_form.v1']),/CAPABILITY_UNAVAILABLE/);
 assert.equal(parseExperienceView({...view,capabilities:['record_form.v1']},{capabilities,storeKeys:['drafts']}),null);
 for(const presentation of ['hidden','expanded',true,null]){
  assert.throws(()=>createDeftRecordFormNode({...input,presentation} as never,capabilities));
  assert.equal(parseExperienceView({...view,root:{...node,presentation}},{capabilities,storeKeys:['drafts']}),null);
 }
});

test('confirmed submission freezes writer and emits only bounded submitted record status',async()=>{
 const f=fixture();f.writer.edit({...value(),body:'PRIVATE LARGE MESSAGE '.repeat(8000)});assert.equal(await f.writer.save(),true);
 const event=experienceRecordSubmissionEvent('form',f.writer.snapshot.row);f.writer.dispose();assert.equal(f.writer.edit(value()),false);assert.equal(await f.writer.save(),false);
 assert.equal(event.record_state,'submitted');assert.equal(event.dirty,false);assert.equal(event.valid,false);assert.equal(event.record_revision,2);
 assert.ok(JSON.stringify(event).length<512);assert.equal(Object.hasOwn(event,'value'),false);assert.equal(JSON.stringify(event).includes('PRIVATE LARGE MESSAGE'),false);
});
test('author editable nomination cannot create a CAS writer for submitted or archived authoritative rows',()=>{
 for(const status of ['submitted','archived'] as const){let operations=0;
  assert.throws(()=>createExperienceRecordWriter({initial:{record_id:id,revision:8,content_digest:digest,value:value(),status},current:()=>true,signal:new AbortController().signal,
   validate:()=>{},change:()=>{},read:async()=>{operations++;throw Error('must not read');},save:async()=>{operations++;throw Error('must not save');}}),/read-only/);
  assert.equal(operations,0);
 }
});
test('fresh closed row overrides author editing and old list revision while a changed draft or foreign record fails closed',()=>{
 const node=DeftExperienceRecordFormNodeSchema.parse({kind:'record_form',id:'form',label:'Draft',store_key:'drafts',record_id:id,expected_revision:1,content_digest:digest,profile,action_key:'send_message'});
 for(const status of ['submitted','archived'] as const){const row:ExperienceRecordRow={record_id:id,revision:2,content_digest:'sha256:'+'b'.repeat(64),status,value:value()};
  assert.equal(experienceRecordFormMode(node,row),'readonly');assert.equal(experienceRecordFormMode({...node,disabled:false},row),'readonly');}
 const row:ExperienceRecordRow={record_id:id,revision:1,content_digest:digest,status:'draft',value:value()};assert.equal(experienceRecordFormMode(node,row),'editable');
 assert.throws(()=>experienceRecordFormMode(node,{...row,revision:2}),/revision/);
 assert.throws(()=>experienceRecordFormMode(node,{...row,record_id:'22222222-2222-4222-8222-222222222222',status:'submitted'}),/identity/);
});
test('closed save/read results cannot reopen or mutate a formerly editable writer',async()=>{
 const closed=fixture(async(row,captured)=>({...row,status:'submitted',revision:row.revision+1,value:captured}));
 closed.writer.edit({...value(),body:'local'});assert.equal(await closed.writer.save(),false);assert.equal(closed.writer.snapshot.state,'blocked');
 assert.equal(await closed.writer.reopen(),false);assert.equal(closed.writer.edit(value()),false);
 let mutations=0;assert.equal(await closed.writer.mutate(async()=>{mutations++;return closed.stored();}),false);assert.equal(mutations,0);assert.equal(closed.writes.length,1);
});
