import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeTemplateApi,insertNativeTemplate,nativeTemplatePlaceholders,parseNativeTemplateContent,parseNativeEmailTemplate,renderNativeTemplate,NativeTemplateError,type NativeEmailTemplate} from './email-native-templates';
import {createNativeDraftWriter,emptyNativeDraft,type NativeDraft} from './email-native-drafts';
const id='11111111-1111-4111-8111-111111111111';
const content={title:'Hello',subject:'Hello {{name}}',body:'Dear {{name}}',body_html:'<p>Dear {{name}}</p>'};
const row:NativeEmailTemplate={template_id:id,account_id:'account',revision:2,status:'active',content,created_at:'2026-10-04T00:00:00Z',updated_at:'2026-10-04T00:00:00Z'};
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
test('template DTO is closed and account-bound, with matching safe rich/plain content and bounded fields',()=>{
 assert.deepEqual(parseNativeEmailTemplate(row,'account'),row);
 for(const value of [{...row,account_id:'other'},{...row,sender_address:'private'},{...row,revision:0},{...row,content:{...content,to:'other@example.com'}}])assert.throws(()=>parseNativeEmailTemplate(value,'account'));
 for(const value of [{...content,title:'x'.repeat(121)},{...content,subject:'two\nlines'},{...content,body_html:'<p onclick="x">Dear {{name}}</p>'},{...content,body:'Different'},{...content,body:'x'.repeat(262145),body_html:''},{...content,body:'😀'.repeat(123000),body_html:''}])assert.throws(()=>parseNativeTemplateContent(value));
});
test('placeholders are resolved only as escaped text; URLs, attributes and recursive marker values are rejected',()=>{
 assert.deepEqual(nativeTemplatePlaceholders(content),['name']);assert.deepEqual(renderNativeTemplate(content,{}).unresolved_placeholders,['name']);
 const next=renderNativeTemplate(content,{name:'<script>& "friends"'});assert.equal(next.subject,'Hello <script>& "friends"');assert.equal(next.body_html,'<p>Dear &lt;script&gt;&amp; "friends"</p>');assert.deepEqual(next.unresolved_placeholders,[]);
 for(const text of ['https://{{host}}/','http://example.com/{{path}}','mailto:{{email}}','www.{{host}}','{{invalid-name}}','{{name'])assert.throws(()=>parseNativeTemplateContent({...content,subject:text,body_html:''}));
 for(const html of ['<p title="{{name}}">Dear {{name}}</p>','<a href="https://x">Dear {{name}}</a>','<p>&#123;&#123;name&#125;&#125;</p>'])assert.throws(()=>parseNativeTemplateContent({...content,body_html:html}));
 assert.throws(()=>renderNativeTemplate(content,{name:'{{other}}'}));assert.throws(()=>renderNativeTemplate(content,{name:'a\nb'}));
});
test('default insertion appends and preserves current subject, recipients, From-independent draft fields, reply and saved files',()=>{
 const file={file_id:id,filename:'note.txt',media_type:'text/plain',size_bytes:4,sha256:'a'.repeat(64)};
 const draft={...emptyNativeDraft(),mode:'reply_all' as const,to:'to@example.com',cc:'cc@example.com',bcc:'bcc@example.com',subject:'Re: Existing',body:'Current message\nMy typed signature',reply_record_id:'mail_'+'a'.repeat(64),attachments:[file]};
 const before=structuredClone(draft),text=renderNativeTemplate({...content,body_html:''},{name:'Friend'}),next=insertNativeTemplate(draft,text,'append');
 assert.equal(next.subject,draft.subject);assert.equal(next.body,'Current message\nMy typed signature\n\nDear Friend');for(const key of ['mode','to','cc','bcc','reply_record_id','attachments'] as const)assert.deepEqual(next[key],draft[key]);assert.deepEqual(draft,before);
 const replacement=insertNativeTemplate(draft,text,'replace');assert.equal(replacement.subject,'Hello Friend');assert.equal(replacement.body,'Dear Friend');assert.deepEqual(replacement.attachments,[file]);assert.equal(replacement.reply_record_id,draft.reply_record_id);
});
test('blank compose takes template fields; append preserves rich formatting and never silently drops an oversized old message',()=>{
 const text=renderNativeTemplate(content,{name:'Friend'}),blank=insertNativeTemplate(emptyNativeDraft(),text,'append');assert.equal(blank.body_html,'<p>Dear Friend</p>');assert.equal(blank.subject,'Hello Friend');
 const current={...emptyNativeDraft(),body:'Old bold',body_html:'<p>Old <strong>bold</strong></p>'};const next=insertNativeTemplate(current,text,'append');assert.equal(next.body_html,'<p>Old <strong>bold</strong></p><p></p><p>Dear Friend</p>');assert.equal(next.body,'Old bold\n\nDear Friend');
 const large={...emptyNativeDraft(),body:'x'.repeat(262144)};assert.throws(()=>insertNativeTemplate(large,{subject:'',body:'more',body_html:''},'append'));assert.equal(large.body.length,262144);
 const ordinary=insertNativeTemplate({...emptyNativeDraft(),body:'x'.repeat(96*1024)},text,'append');assert.equal(ordinary.body,'x'.repeat(96*1024)+'\n\nDear Friend');assert.match(ordinary.body_html,/Dear Friend/);assert.throws(()=>insertNativeTemplate({...emptyNativeDraft(),body:'x'.repeat(262130)},text,'append'),/combined formatting/);
});
test('API uses scoped account paths, create UUID and exact update/archive CAS without private draft fields',async()=>{
 const calls:{path:string;init:RequestInit}[]=[];const api=createNativeTemplateApi({current:()=>true,fetch:async(path,init)=>{calls.push({path,init});const body=init.body?JSON.parse(init.body as string):null;return response({...row,revision:init.method==='POST'&&path.endsWith('/templates')?1:init.method==='PUT'?3:3,status:path.endsWith('/archive')?'archived':'active',content:body?.content??content});}});
 assert.equal((await api.save('account',id,null,content)).revision,1);assert.deepEqual(JSON.parse(calls[0]!.init.body as string),{template_id:id,content});assert.equal(calls[0]!.path,'/api/email/accounts/account/templates');
 await api.save('account',id,2,content);assert.equal(calls[1]!.init.method,'PUT');assert.deepEqual(JSON.parse(calls[1]!.init.body as string),{expected_revision:2,content});
 await api.archive(row);assert.deepEqual(JSON.parse(calls[2]!.init.body as string),{expected_revision:2});assert.equal(calls[2]!.init.cache,'no-store');api.dispose();
});
test('lost save response has no automatic retry; saved-version GET remains the explicit recovery seam',async()=>{
 let posts=0,gets=0;const api=createNativeTemplateApi({current:()=>true,fetch:async(_path,init)=>{if(init.method==='POST'){posts++;throw Error('lost response');}gets++;return response({...row,revision:1});}});
 await assert.rejects(api.save('account',id,null,content),NativeTemplateError);assert.equal(posts,1);assert.equal((await api.read('account',id)).revision,1);assert.equal(posts,1);assert.equal(gets,1);api.dispose();
});
test('held scope changes, denial, foreign acknowledgments and oversized responses cannot publish template content',async()=>{
 let active=true,resolve!:(response:Response)=>void;const held=createNativeTemplateApi({current:()=>active,fetch:()=>new Promise(done=>{resolve=done;})});const pending=held.read('account',id);active=false;resolve(response(row));await assert.rejects(pending,(error:unknown)=>error instanceof NativeTemplateError&&error.kind==='denied');held.dispose();
 for(const value of [{...row,account_id:'other'},{...row,template_id:'22222222-2222-4222-8222-222222222222'}, {...row,private_locator:'hidden'}]){const api=createNativeTemplateApi({current:()=>true,fetch:async()=>response(value)});await assert.rejects(api.read('account',id));api.dispose();}
 const denied=createNativeTemplateApi({current:()=>true,fetch:async()=>response({code:'EMAIL_TEMPLATE_ACCESS_DENIED'},403)});await assert.rejects(denied.read('account',id),(error:unknown)=>error instanceof NativeTemplateError&&error.kind==='denied');denied.dispose();
 const large=createNativeTemplateApi({current:()=>true,fetch:async()=>new Response('x'.repeat(524289))});await assert.rejects(large.read('account',id));large.dispose();
});
test('template pages are bounded, cursor-scoped and active only; stale CAS is a distinct conflict',async()=>{
 let path='';const api=createNativeTemplateApi({current:()=>true,fetch:async(url)=>{path=url;return response({items:[row],next_cursor:'sealed_cursor',has_more:true});}});assert.equal((await api.list('account','opaque')).items.length,1);assert.equal(path,'/api/email/accounts/account/templates?limit=10&cursor=opaque');api.dispose();
 for(const page of [{items:[row,row],next_cursor:null,has_more:false},{items:[{...row,status:'archived'}],next_cursor:null,has_more:false},{items:[row],next_cursor:null,has_more:true}]){const invalid=createNativeTemplateApi({current:()=>true,fetch:async()=>response(page)});await assert.rejects(invalid.list('account'));invalid.dispose();}
 const conflict=createNativeTemplateApi({current:()=>true,fetch:async()=>response({code:'EMAIL_TEMPLATE_CONFLICT'},409)});await assert.rejects(conflict.save('account',id,2,content),(error:unknown)=>error instanceof NativeTemplateError&&error.kind==='conflict');conflict.dispose();
});
test('typing during a held template read is retained when insertion joins the current real draft writer',async()=>{
 const file={file_id:id,filename:'note.txt',media_type:'text/plain',size_bytes:4,sha256:'a'.repeat(64)};
 let stored:NativeDraft={draft_id:id,revision:1,status:'draft',content:{...emptyNativeDraft(),to:'friend@example.com',body:'Earlier text',attachments:[file]},origin:{kind:'human',created_by_user_id:'owner',originating_run_id:null},last_edited_by_user_id:'owner',created_at:row.created_at,updated_at:row.updated_at};
 const writer=createNativeDraftWriter({accountId:'account',draftId:id,initial:stored,current:()=>true,change:()=>{},api:{read:async()=>stored,save:async(_account,_draft,revision,value)=>{assert.equal(revision,1);stored={...stored,content:value,revision:2};return stored;}}});
 let resolve!:(response:Response)=>void;const api=createNativeTemplateApi({current:()=>true,fetch:()=>new Promise(done=>{resolve=done;})});const held=api.read('account',id);writer.edit({...writer.snapshot().content,body:'Edited during template loading'});resolve(response(row));const template=await held;
 writer.edit(insertNativeTemplate(writer.snapshot().content,renderNativeTemplate(template.content,{name:'Friend'}),'append'));assert.equal(await writer.save(),true);assert.equal(stored.content.body,'Edited during template loading\n\nDear Friend');assert.deepEqual(stored.content.attachments,[file]);assert.equal(stored.content.to,'friend@example.com');api.dispose();writer.dispose();
});
