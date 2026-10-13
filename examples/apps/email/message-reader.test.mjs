import assert from 'node:assert/strict';
import {test} from 'node:test';
import {boundedEmailContent,normalizeEmailMessageDetail,createEmailMessageReader,projectLegacyEmailReaderFields,projectParsedEmailReaderFields,normalizeParsedEmailReaderBody} from './message-reader.mjs';

const part=(mimeType,content,other={})=>({mimeType,headers:[{name:'Content-Type',value:`${mimeType}; charset=utf-8`}],body:{data:Buffer.from(content).toString('base64url')},...other});
const detail=body=>({message:{account_id:'account',subject:'Untrusted subject'},body:{...body,untrusted:true}});
const ids={account_id:'account',logical_message_id:'mail_logical'};

test('multipart alternative chooses HTML, retains plain fallback and skips attachment bodies',()=>{
 const result=normalizeEmailMessageDetail(detail({format:'gmail_mime',payload:{mimeType:'multipart/mixed',parts:[part('text/html','attachment',{filename:'file.html'}),{mimeType:'multipart/alternative',parts:[part('text/plain','plain body'),part('text/html','<p>HTML body<img src="https://remote.test/pixel"></p>')]}]}}),ids);
 assert.equal(result.body.format,'html');assert.match(result.body.content,/<img/u);assert.equal(result.body.untrusted,true);assert.equal(result.body.remote_content,'blocked');assert.equal(result.body.plain_text,'plain body');assert.equal(result.source_status,'not_requested');
});
test('missing external MIME part and honest unavailable do not claim an empty body',()=>{
 const result=normalizeEmailMessageDetail(detail({format:'gmail_mime',payload:{mimeType:'text/plain',body:{attachmentId:'external'}}}),ids);
 assert.equal(result.body.format,'unavailable');assert.equal(normalizeEmailMessageDetail(detail({format:'unavailable'}),ids).body.format,'unavailable');
 assert.equal(normalizeEmailMessageDetail(detail({format:'text',content:''}),ids).body.format,'plain');
});
test('bounded UTF8 truncation preserves code points and separate fallback status',()=>{
 assert.deepEqual(boundedEmailContent('🙂🙂',5),{content:'🙂',truncated:true});
 const result=normalizeEmailMessageDetail(detail({format:'gmail_mime',payload:{mimeType:'multipart/alternative',parts:[part('text/plain','x'.repeat(17000)),part('text/html','<p>short</p>')]}}),ids);
 assert.equal(result.body.truncated,false);assert.equal(result.body.plain_text_truncated,true);assert.equal(result.body.plain_text.length,16384);
 assert.throws(()=>boundedEmailContent('x',16385),/CONTENT_INVALID/u);
});
test('Gmail MIME rejects invalid encoding, malformed headers and excess tree depth',()=>{
 for(const payload of [part('text/plain','x',{body:{data:'not+url/base64'}}),part('text/plain','x',{headers:[{name:123,value:'text/plain'}]}),part('text/plain','x',{headers:[{name:'Content-Type',value:'text/plain; charset=unsupported'}]}),part('text/plain','x',{body:{data:Buffer.from([0xff]).toString('base64url')}})])assert.throws(()=>normalizeEmailMessageDetail(detail({format:'gmail_mime',payload}),ids),/MIME_INVALID|ENCODING_UNSUPPORTED/u);
 let payload=part('text/plain','x');for(let i=0;i<18;i++)payload={mimeType:'multipart/mixed',parts:[payload]};
 assert.throws(()=>normalizeEmailMessageDetail(detail({format:'gmail_mime',payload}),ids),/MIME_INVALID/u);
});
test('Microsoft HTML remains untrusted and account identity is exact',()=>{
 assert.equal(normalizeEmailMessageDetail(detail({format:'html',content:'<svg onload=evil>body</svg>'}),ids).body.format,'html');
 assert.throws(()=>normalizeEmailMessageDetail({...detail({format:'text',content:'x'}),message:{account_id:'foreign'}},ids),/IDENTITY_INVALID/u);
 assert.throws(()=>normalizeEmailMessageDetail({...detail({format:'text',content:'x'}),body:{format:'text',content:'x',untrusted:false}},ids),/IDENTITY_INVALID/u);
});
test('lazy reader calls exact account/logical ID only and does not consume native IDs',async()=>{
 const calls=[];const reader=createEmailMessageReader({runtime:{async readMessage(...args){calls.push(args);return detail({format:'text',content:'body'});}}});
 const result=await reader.read(ids);assert.deepEqual(calls,[['account','mail_logical']]);assert.equal(result.logical_message_id,'mail_logical');
 await assert.rejects(reader.read({...ids,account_id:'bad\nowner'}),/IDENTITY_INVALID/u);assert.equal(calls.length,1);
});
test('legacy projection has exactly five reviewed fields including Reply-To/CC, with no BCC',()=>{
 const result=projectLegacyEmailReaderFields({html:'<p>body</p>',replyTo:{value:[{name:'Reply Person',address:'reply@example.test'}]},cc:{text:'CC Person <cc@example.test>\r\nInjected'},bcc:{text:'hidden@example.test'},headerLines:[{key:'reply-to',line:'Reply-To: reply@example.test'},{key:'cc',line:'Cc: cc@example.test'},{key:'bcc',line:'Bcc: hidden@example.test'}]});
 assert.deepEqual(Object.keys(result).sort(),['body_html','body_html_truncated','cc','reply_to','source_headers']);assert.equal(result.reply_to,'Reply Person <reply@example.test>');assert.equal(result.cc,'CC Person <cc@example.test>  Injected');assert.ok(!result.source_headers.includes('Bcc'));assert.equal(result.body_html_truncated,false);
});
test('legacy HTML/header truncation is explicit and scalar bounds survive UTF8',()=>{
 const result=projectLegacyEmailReaderFields({html:'🙂'.repeat(2000),headerLines:[{key:'x-long',line:'X-Long: '+'x'.repeat(5000)}]});
 assert.equal(result.body_html_truncated,true);assert.ok(Buffer.byteLength(result.body_html)<=4096);assert.ok(!result.body_html.includes('\ufffd'));assert.ok(Buffer.byteLength(result.source_headers)<=4096);assert.match(result.source_headers,/\[Headers truncated\]$/u);
 assert.deepEqual(projectLegacyEmailReaderFields({}),{body_html:'',body_html_truncated:false,reply_to:'',cc:'',source_headers:''});
 assert.match(projectLegacyEmailReaderFields({headerLines:Array.from({length:201},()=>({key:'x',line:'X: value'}))}).source_headers,/\[Headers truncated\]$/u);
});
test('parser projections reject malformed address/header containers',()=>{
 assert.throws(()=>projectLegacyEmailReaderFields({replyTo:{value:{address:'x'}}}),/HEADERS_INVALID/u);
 assert.throws(()=>projectLegacyEmailReaderFields({headerLines:[{key:'x',line:'bad\0header'}]}),/HEADERS_INVALID/u);
 const projected=projectParsedEmailReaderFields({text:'plain',html:false,subject:'x\nheading',date:new Date('2026-10-01T00:00:00Z')});
 assert.equal(projected.body_format,'plain');assert.equal(projected.subject,'x heading');assert.equal(projected.date,'2026-10-01T00:00:00.000Z');
});
test('full parsed MIME body uses the same inert 16KiB document and honest plain fallback status',()=>{
 const body=normalizeParsedEmailReaderBody({html:'<p>selected</p>',text:'x'.repeat(17000)});
 assert.equal(body.format,'html');assert.equal(body.content,'<p>selected</p>');assert.equal(body.truncated,false);assert.equal(body.plain_text_truncated,true);assert.equal(body.untrusted,true);assert.equal(body.remote_content,'blocked');
 assert.equal(normalizeParsedEmailReaderBody({html:false}).format,'unavailable');assert.equal(normalizeParsedEmailReaderBody({text:''}).format,'plain');
});
