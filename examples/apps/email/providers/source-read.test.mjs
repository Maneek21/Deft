import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {createGmailSourceAdapter,createMicrosoftSourceAdapter} from './source-read.mjs';
import {PROVIDER_LIMITS} from './contract.mjs';
const account=provider=>({account_id:'account',provider,display_label:'Personal',primary_address:'person@example.test',verified_sender_identities:[],capabilities:['read'],connection_target:'personal',resource_binding_id:'resource',action_binding_id:null,authority_epoch:3,health:'connected'});
const mime=Buffer.from('From: sender@example.test\r\nTo: person@example.test\r\nSubject: source\r\nContent-Type: text/plain\r\n\r\nOriginal body\r\n');
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const options=(provider,fetch,extra={})=>({account:account(provider),fetch,getAccessToken:async()=> 'private-token',assertAuthority:async()=>true,...extra});

test('Gmail raw read preserves exact RFC bytes and stays fixed to authenticated users/me GET',async()=>{
 const calls=[],checks=[];const adapter=createGmailSourceAdapter(options('gmail',async(url,init)=>{calls.push({url,init});return json({id:'message',raw:mime.toString('base64url')});},{assertAuthority:async value=>{checks.push(value);return true;}}));
 const result=await adapter.readSource({kind:'gmail',message_id:'message'});
 assert.deepEqual(Buffer.from(result.mime_bytes),mime);assert.equal(result.source_kind,'provider_original');assert.equal(result.media_type,'message/rfc822');assert.equal(result.digest,createHash('sha256').update(mime).digest('hex'));assert.equal(checks.length,3);assert.ok(checks.every(row=>row.account_id==='account'&&row.operation==='read'&&row.authority_epoch===3));
 const {url,init}=calls[0];assert.equal(url,'https://www.googleapis.com/gmail/v1/users/me/messages/message?format=raw');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer private-token');assert.equal(calls.length,1);
});
test('Graph original MIME uses /me immutable ID /$value and never a bearer URL or mutation',async()=>{
 let call;const result=await createMicrosoftSourceAdapter(options('microsoft',async(url,init)=>{call={url,init};return new Response(mime,{headers:{'Content-Type':'text/plain; charset=utf-8'}});})).readSource({kind:'microsoft',id_type:'immutable',message_id:'id/a?b'});
 assert.deepEqual(Buffer.from(result.mime_bytes),mime);assert.equal(call.url,'https://graph.microsoft.com/v1.0/me/messages/id%2Fa%3Fb/$value');assert.equal(call.init.headers.Prefer,'IdType="ImmutableId"');assert.equal(call.init.method,'GET');
});
test('revocation during token acquisition blocks IO; during response blocks source disclosure',async()=>{
 let allowed=true,calls=0;
 const first=createGmailSourceAdapter(options('gmail',async()=>{calls++;assert.fail('no fetch after revoke');},{assertAuthority:async()=>allowed,getAccessToken:async()=>{allowed=false;return 'token';}}));
 await assert.rejects(first.readSource({kind:'gmail',message_id:'m'}),error=>error.code==='EMAIL_ACCOUNT_AUTHORITY_DENIED');assert.equal(calls,0);
 allowed=true;const second=createGmailSourceAdapter(options('gmail',async()=>{calls++;allowed=false;return json({id:'m',raw:mime.toString('base64url')});},{assertAuthority:async()=>allowed}));
 await assert.rejects(second.readSource({kind:'gmail',message_id:'m'}),error=>error.code==='EMAIL_ACCOUNT_AUTHORITY_DENIED');assert.equal(calls,1);
});
test('source response identity, canonical encoding, content type and decoded byte bound are strict',async()=>{
 for(const data of [{id:'other',raw:mime.toString('base64url')},{id:'m',raw:'invalid+/base64'},{id:'m',raw:'Zh'},{id:'m',raw:Buffer.alloc(PROVIDER_LIMITS.mime_bytes+1).toString('base64url')}])await assert.rejects(createGmailSourceAdapter(options('gmail',async()=>json(data))).readSource({kind:'gmail',message_id:'m'}),error=>['EMAIL_SOURCE_RESPONSE_INVALID','EMAIL_PROVIDER_RESPONSE_LIMIT'].includes(error.code));
 await assert.rejects(createMicrosoftSourceAdapter(options('microsoft',async()=>new Response('<html>not MIME</html>',{headers:{'Content-Type':'text/html'}}))).readSource({kind:'microsoft',id_type:'immutable',message_id:'m'}),error=>error.code==='EMAIL_SOURCE_RESPONSE_INVALID');
});
test('streaming size limit cancels without waiting for a noncooperative cancel',async()=>{
 let canceled=0;const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(PROVIDER_LIMITS.mime_bytes+1));},cancel(){canceled++;return new Promise(()=>{});}});
 const adapter=createMicrosoftSourceAdapter(options('microsoft',async()=>new Response(body,{headers:{'Content-Type':'message/rfc822'}})));
 await assert.rejects(adapter.readSource({kind:'microsoft',id_type:'immutable',message_id:'m'}),error=>error.code==='EMAIL_PROVIDER_RESPONSE_LIMIT');assert.equal(canceled,1);
});
test('captured short deadline races stalled read and stalled noncooperative fetch',async()=>{
 let canceled=0;const body=new ReadableStream({cancel(){canceled++;return new Promise(()=>{});}});
 const stalled=createGmailSourceAdapter(options('gmail',async()=>new Response(body)));
 await assert.rejects(stalled.readSource({kind:'gmail',message_id:'m'},{deadline:Date.now()+25}),error=>error.code==='EMAIL_SOURCE_ABORTED');assert.equal(canceled,1);
 const fetch=createGmailSourceAdapter(options('gmail',()=>new Promise(()=>{})));
 await assert.rejects(fetch.readSource({kind:'gmail',message_id:'m'},{deadline:Date.now()+25}),error=>error.code==='EMAIL_SOURCE_ABORTED');
});
test('request abort combines with read deadline and invalid authority/locator fails before fetch',async()=>{
 const controller=new AbortController();let fetched=0;
 const adapter=createGmailSourceAdapter(options('gmail',async()=>{fetched++;controller.abort();return json({id:'m',raw:mime.toString('base64url')});}));
 await assert.rejects(adapter.readSource({kind:'gmail',message_id:'m'},{signal:controller.signal}),error=>error.code==='EMAIL_SOURCE_ABORTED');
 await assert.rejects(adapter.readSource({kind:'gmail',message_id:'m'},{signal:controller.signal}),error=>error.code==='EMAIL_SOURCE_ABORTED');assert.equal(fetched,1);
 await assert.rejects(adapter.readSource({kind:'gmail',message_id:'..'}),error=>error.code==='EMAIL_PROVIDER_INPUT_INVALID');
 const denied=createGmailSourceAdapter(options('gmail',async()=>assert.fail('authority denial must prevent IO'),{assertAuthority:async()=>false}));await assert.rejects(denied.readSource({kind:'gmail',message_id:'m'}),error=>error.code==='EMAIL_ACCOUNT_AUTHORITY_DENIED');
});
test('provider error output stays structured and never reveals provider response body',async()=>{
 await assert.rejects(createGmailSourceAdapter(options('gmail',async()=>new Response('secret provider detail',{status:403}))).readSource({kind:'gmail',message_id:'m'}),error=>error.code==='EMAIL_PROVIDER_PERMISSION_DENIED'&&error.status===403&&!error.message.includes('secret'));
});
