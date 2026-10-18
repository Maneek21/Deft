import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import {simpleParser} from 'mailparser';
import {createAppConnectionAdapter} from './connection-http.mjs';
import {createEncryptedEmailCustody} from './custody-encrypted.mjs';
import {createOAuthProvider} from './oauth-provider.mjs';
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function syntheticGraphMime({sizes=[4*1024*1024],body='Exact body',html='<p>Exact body<img src="cid:fixture-inline"></p>'}={}){
 const files=sizes.map((size,index)=>({filename:`fixture-${index}.bin`,content:Buffer.alloc(size,index+31),contentType:'application/octet-stream',...(index===0?{cid:'fixture-inline',contentDisposition:'inline'}:{contentDisposition:'attachment'})}));
 const composer=new MailComposer({from:'Verified Owner <owner@example.test>',to:'Visible <visible@example.test>',cc:'copy@example.test',bcc:'hidden@example.test',replyTo:'reply@example.test',subject:'Unicode café prepared send',text:body,html,
  messageId:'<prepared-fixture@example.test>',date:new Date('2026-10-04T10:00:00Z'),inReplyTo:'<reply-parent@example.test>',references:['<ancestor@example.test>','<reply-parent@example.test>'],attachments:files,disableFileAccess:true,disableUrlAccess:true}).compile();composer.keepBcc=true;
 const bytes=await new Promise((resolve,reject)=>composer.build((error,bytes)=>error?reject(error):resolve(bytes)));files.forEach(file=>file.content.fill(0));return {operation_id:randomUUID(),mime_bytes:bytes,mime_digest:sha(bytes),from_address:'owner@example.test'};
}
export function memoryGraphSendJournal(){const records=new Map();let busy=false;return {records,async load(_scope,id){return structuredClone(records.get(id)??null);},async create(plan){if(records.has(plan.operation_id)){assert.deepEqual(records.get(plan.operation_id).plan,plan);return structuredClone(records.get(plan.operation_id));}const value={plan:structuredClone(plan),prepare_attempts:0,create:{state:'prepared'},files:plan.files.map(file=>({index:file.index,state:'prepared',offset:0})),send:{state:'prepared'}};records.set(plan.operation_id,value);return structuredClone(value);},async change(_scope,id,work){if(busy)throw Error('BUSY');busy=true;try{return await work(structuredClone(records.get(id)??null),async value=>{records.set(id,structuredClone(value));});}finally{busy=false;}}};}
/** Synthetic transport only. The registered adapter and OAuth custody are real;
 * no token, DNS lookup, or mailbox effect leaves this process. */
export async function graphSendFixture({journal=memoryGraphSendJournal(),scope={org_id:'graph-send-org',owner_user_id:'graph-send-owner',account_id:'graph-send-account'},now=Date.now}={}){
 const oauthScope={org_id:scope.org_id,owner_id:scope.owner_user_id,installation_id:'graph-send-install'},binding={scope:oauthScope,account_id:scope.account_id,provider:'microsoft',connection_target:'graph-send-target',resource_binding_id:'graph-send-binding',action_binding_id:'graph-send-action',authority_epoch:1,capabilities:['read','modify','send']};
 const rows=new Map(),custody=createEncryptedEmailCustody({encryption_key:new Uint8Array(32).fill(58),key_id:'graph-send-synthetic',store:{async withLock({key},work){return work({async read(){return structuredClone(rows.get(key)??null);},async compareAndSwap({expected_revision,value}){const old=rows.get(key);if((old?.revision??null)!==expected_revision)return false;rows.set(key,{revision:(old?.revision??0)+1,value:structuredClone(value)});return true;}});}}});
 const client={client_id:'synthetic-client',client_secret:'synthetic-secret',redirect_uri:'https://fixture.invalid/callback',tenant:'common'},calls=[],proofs=[],files=[],sessions=new Map();let bare,parsed,version=1,creates=0,sends=0,attachmentPosts=0,sessionPosts=0,revoked=false,permit=true;
 const f={journal,scope,calls,proofs,files,sessions,loss:null,invalidUpload:false,externalEdit:false,beforeFetch:null,get creates(){return creates;},get sends(){return sends;},get attachmentPosts(){return attachmentPosts;},get sessionPosts(){return sessionPosts;},get permit(){return permit;},set permit(value){permit=value;},deny(){revoked=true;}};
 const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
 const lose=point=>{if(f.loss===point){f.loss=null;throw Error('Synthetic ACK loss');}};
 const raw=async()=>{
  assert.ok(parsed);const mailbox=field=>field?.value?.map(row=>({address:row.address,name:row.name??''}));
  const composer=new MailComposer({from:mailbox(parsed.from),to:mailbox(parsed.to),cc:mailbox(parsed.cc),bcc:mailbox(parsed.bcc),replyTo:mailbox(parsed.replyTo),subject:f.externalEdit?'Externally changed':parsed.subject,text:parsed.text,html:parsed.html||undefined,messageId:parsed.messageId,date:parsed.date,inReplyTo:parsed.inReplyTo,references:parsed.references,
   headers:{'X-Deft-Outbox-Operation':String(parsed.headers.get('x-deft-outbox-operation'))},attachments:files.map(file=>({filename:file.name,content:Buffer.from(file.bytes),contentType:file.contentType,contentDisposition:file.isInline?'inline':'attachment',...(file.contentId?{cid:file.contentId}:{})})),disableFileAccess:true,disableUrlAccess:true}).compile();composer.keepBcc=true;
  return new Promise((resolve,reject)=>composer.build((error,bytes)=>error?reject(error):resolve(bytes)));
 };
 const fetch=async(url,init)=>{
  calls.push({url,method:init.method,headers:{...init.headers},body_length:init.body?.length??0});assert.equal(init.redirect,'error');await f.beforeFetch?.(url,init);
  const target=new URL(url);if(target.origin==='https://outlook.office.com'){
   assert.equal(init.headers.Authorization,undefined);const session=sessions.get(target.href);assert.ok(session,'Only previously provider-returned sessions may be used');
   if(init.method==='GET')return json({nextExpectedRanges:[String(session.offset)]});
   assert.equal(init.method,'PUT');const match=/^bytes (\d+)-(\d+)\/(\d+)$/u.exec(init.headers['Content-Range']);assert.ok(match);const [start,end,total]=match.slice(1).map(Number);assert.equal(start,session.offset);assert.equal(total,session.size);assert.ok(init.body.length<4*1024*1024);assert.equal(init.body.length,end-start+1);assert.equal(Number(init.headers['Content-Length']),init.body.length);session.chunks.push(Buffer.from(init.body));session.offset=end+1;
   if(session.offset===total){files.push({...session.item,bytes:Buffer.concat(session.chunks)});version++;lose('last_range');return new Response(null,{status:201,headers:{Location:'https://graph.microsoft.com/v1.0/me/messages/immutable-draft/attachments/fixture'}});}
   lose('range');return json({nextExpectedRanges:[String(session.offset)]});
  }
  assert.equal(target.origin,'https://graph.microsoft.com');assert.ok(init.headers.Authorization.startsWith('Bearer '));assert.equal(init.headers.Prefer,'IdType="ImmutableId"');
  if(target.pathname==='/v1.0/me/messages'&&init.method==='POST'){creates++;bare=Buffer.from(init.body,'base64');parsed=await simpleParser(bare,{skipHtmlToText:true,skipTextToHtml:true,keepCidLinks:true});lose('create');return json({id:'immutable-draft',isDraft:true});}
  assert.ok(target.pathname.startsWith('/v1.0/me/messages/immutable-draft'));
  if(target.pathname.endsWith('/$value'))return new Response(await raw(),{headers:{'Content-Type':'message/rfc822'}});
  if(target.pathname.endsWith('/createUploadSession')){sessionPosts++;const item=JSON.parse(init.body).AttachmentItem,url=`https://outlook.office.com/api/v2.0/AttachmentSessions('fixture-${sessionPosts}')`;sessions.set(url,{item,size:item.size,offset:0,chunks:[]});lose('session');return json({uploadUrl:f.invalidUpload?'https://attacker.invalid/private':url,expirationDateTime:new Date(now()+3600000).toISOString(),nextExpectedRanges:['0']});}
  if(target.pathname.endsWith('/attachments')&&init.method==='POST'){attachmentPosts++;const item=JSON.parse(init.body);files.push({...item,bytes:Buffer.from(item.contentBytes,'base64')});version++;lose('attachment');return json({id:`attachment-${attachmentPosts}`});}
  if(target.pathname.endsWith('/send')){sends++;lose('send');return new Response(null,{status:202});}
  assert.equal(init.method,'GET');return json({id:'immutable-draft',isDraft:true,changeKey:`change-${version}`});
 };
 await custody.withAccount(binding,async tx=>tx.write({health:'connected',secret:{access_token:'synthetic-token',refresh_token:'synthetic-refresh',expires_at:now()+3600000,scopes:['offline_access','User.Read','Mail.Read','Mail.ReadWrite','Mail.Send'],client_fingerprint:createOAuthProvider({provider:'microsoft',client,fetch}).client_fingerprint,identity:{provider_subject:'synthetic-principal',primary_address:'owner@example.test',display_label:'Fixture',verified_sender_identities:['owner@example.test']}}}));
 const {scope:ignored,...options}=binding;const make=()=>createAppConnectionAdapter({options:{...options,origin:'https://fixture.invalid',clients:{microsoft:client}},custody,fetch,now,host:{resolveContext:async()=>assert.fail('No Experience'),assertCurrent:async()=>assert.fail('No Experience')}});
 const core={org_id:scope.org_id,owner_user_id:scope.owner_user_id,installation_id:oauthScope.installation_id,account_id:scope.account_id,resource_binding_id:binding.resource_binding_id,authority_version:'current-human-or-service',expires_at:now()+60000,recheck:async()=>{if(revoked)throw Error('REVOKED');}};
 const proof=async input=>{proofs.push(input);return permit;};
 return Object.assign(f,{adapter:await make(),restart:make,context:{...core,send_upload_journal:journal,send_prepare_before_effect:proof},sendContext:{...core,send_upload_journal:journal,send_before_reserve:proof},raw,inspect:async()=>simpleParser(await raw(),{skipHtmlToText:true,skipTextToHtml:true,keepCidLinks:true}),binding,custody,async close(){bare?.fill(0);files.forEach(file=>file.bytes.fill(0));for(const session of sessions.values())session.chunks.forEach(bytes=>bytes.fill(0));}});
}
