import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createAppConnectionAdapter} from './connection-http.mjs';
import {createEncryptedEmailCustody} from './custody-encrypted.mjs';
import {createOAuthProvider} from './oauth-provider.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const copy=value=>structuredClone(value);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const file=(id,name,bytes,{inline=false,cid=''}={})=>({id,name,bytes:Buffer.from(bytes),type:inline?'image/png':'text/plain',inline,cid});
const initial=()=>({subject:'Baseline subject',body:'Baseline body',to:['before@example.test'],cc:[],bcc:['blind@example.test'],files:[file('keep-id','keep.txt','Keep exact'),file('remove-id','remove.txt','Remove old'),file('change-id','change.txt','Old changed'),file('cid-id','inline.txt',png,{inline:true,cid:'logo'})]});
const desired=()=>({subject:'Updated résumé',body:'Updated body',to:['new@example.test'],cc:['cc@example.test'],bcc:['blind@example.test'],files:[file('ignored','keep.txt','Keep exact'),file('ignored','change.txt','New changed'),file('ignored','add.txt','Added exact ✓'),file('ignored','inline.txt',png,{inline:true,cid:'logo'})]});
function mime(state){let raw='From: owner@example.test\r\nTo: '+state.to.join(', ')+'\r\n'+(state.cc.length?'Cc: '+state.cc.join(', ')+'\r\n':'')+(state.bcc.length?'Bcc: '+state.bcc.join(', ')+'\r\n':'')+'Subject: '+state.subject+'\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=saga\r\n\r\n--saga\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'+state.body+'\r\n';
 for(const part of state.files)raw+='--saga\r\nContent-Type: '+part.type+'\r\nContent-Disposition: '+(part.inline?'inline':'attachment')+'; filename="'+part.name+'"\r\n'+(part.cid?'Content-ID: <'+part.cid+'>\r\n':'')+'Content-Transfer-Encoding: base64\r\n\r\n'+Buffer.from(part.bytes).toString('base64')+'\r\n';
 return Buffer.from(raw+'--saga--\r\n');
}
function memoryJournal(){const values=new Map();return {values,async create(plan){const prior=values.get(plan.operation_id);if(prior)return copy(prior);const next={plan,steps:plan.steps.map(step=>({step_id:step.step_id,state:'prepared'}))};values.set(plan.operation_id,copy(next));return copy(next);},async load(_scope,id){return copy(values.get(id)??null);},async change(_scope,id,work){let current=copy(values.get(id)??null);return work(current,async next=>{values.set(id,copy(next));});}};}
export async function createGraphDraftSagaFixture({journal:providedJournal,scope:providedScope}={}){
 const scope={org_id:providedScope?.org_id??'org-graph-saga',owner_id:providedScope?.owner_user_id??'owner-graph-saga',installation_id:'installation-graph-saga'},binding={scope,account_id:providedScope?.account_id??'graph-saga',provider:'microsoft',connection_target:'graph-saga-target',resource_binding_id:providedScope?.resource_binding_id??'graph-saga-binding',action_binding_id:'graph-saga-action',authority_epoch:1,capabilities:['read','modify']};
 const rows=new Map(),custody=createEncryptedEmailCustody({encryption_key:new Uint8Array(32).fill(73),key_id:'saga-fixture',store:{async withLock({key},work){return work({async read(){return copy(rows.get(key)??null);},async compareAndSwap({expected_revision,value}){const old=rows.get(key);if((old?.revision??null)!==expected_revision)return false;rows.set(key,{revision:(old?.revision??0)+1,value:copy(value)});return true;}});}}});
 const client={client_id:'synthetic-saga-client',client_secret:'synthetic-saga-secret',redirect_uri:'https://fixture.invalid/email/connections/callback',tenant:'common'},journal=providedJournal??memoryJournal();
 let state=initial(),version=1,nextId=1,readsBlocked=false,losePost='',externalAfterPatch=false,nonFile=false,corruptCatalog=false,catalogCount=0,activeOperation;const effects=[],reservations=[],calls=[];
 const fetch=async(url,init)=>{assert.equal(init.redirect,'error');assert.ok(init.headers.Authorization.startsWith('Bearer '));const target=new URL(url);assert.equal(target.origin,'https://graph.microsoft.com');calls.push({url,method:init.method});
  if(init.method==='GET'){if(readsBlocked)throw Error('Synthetic read unavailable');if(target.pathname.endsWith('/$value'))return new Response(mime(state),{headers:{'content-type':'message/rfc822'}});
   if(target.pathname.endsWith('/attachments')){catalogCount++;return json({value:state.files.map(part=>({'@odata.type':nonFile?'#microsoft.graph.itemAttachment':'#microsoft.graph.fileAttachment',id:part.id,name:part.name,contentType:part.type,contentBytes:Buffer.from(corruptCatalog?'Wrong catalog bytes':part.bytes).toString('base64'),isInline:part.inline,contentId:part.cid||null}))});}
   return json({id:'immutable-mapped-draft',isDraft:true,changeKey:'version-'+version});
  }
  const retained=await journal.load({org_id:scope.org_id,owner_user_id:scope.owner_id,account_id:binding.account_id},activeOperation);assert.ok(retained?.steps.some(step=>step.state==='started'),'Started journal marker precedes provider effect');effects.push(init.method+':'+target.pathname.split('/').at(-1));
  if(init.method==='PATCH'){const patch=JSON.parse(init.body);if(patch.subject!==undefined)state.subject=patch.subject;if(patch.body)state.body=patch.body.content;if(patch.toRecipients)state.to=patch.toRecipients.map(row=>row.emailAddress.address);if(patch.ccRecipients)state.cc=patch.ccRecipients.map(row=>row.emailAddress.address);if(patch.bccRecipients)state.bcc=patch.bccRecipients.map(row=>row.emailAddress.address);version++;if(externalAfterPatch){state.subject='External edit preserved';version++;}return json({id:'immutable-mapped-draft',isDraft:true,changeKey:'version-'+version});}
  if(init.method==='DELETE'){const id=decodeURIComponent(target.pathname.split('/').at(-1));state.files=state.files.filter(part=>part.id!==id);version++;return new Response(null,{status:204});}
  const mode=losePost;losePost='';if(mode==='before'){readsBlocked=true;throw Error('Synthetic add failed before provider effect');}
  const row=JSON.parse(init.body),part=file('added-'+nextId++,row.name,Buffer.from(row.contentBytes,'base64'),{inline:row.isInline,cid:row.contentId??''});part.type=row.contentType;state.files.push(part);version++;
  if(mode==='after'){readsBlocked=true;throw Error('Synthetic add committed with lost response');}
  return json({id:part.id,'@odata.type':'#microsoft.graph.fileAttachment'});
 };
 await custody.withAccount(binding,async tx=>tx.write({health:'connected',secret:{access_token:'synthetic-saga-access',refresh_token:'synthetic-saga-refresh',expires_at:Date.now()+3600000,scopes:['offline_access','User.Read','Mail.Read','Mail.ReadWrite'],client_fingerprint:createOAuthProvider({provider:'microsoft',client,fetch}).client_fingerprint,identity:{provider_subject:'graph-saga-principal',primary_address:'owner@example.test',display_label:'Saga owner',verified_sender_identities:[]}}}));
 const {scope:ignored,...options}=binding,open=()=>createAppConnectionAdapter({options:{...options,origin:'https://fixture.invalid',clients:{microsoft:client}},custody,fetch,host:{resolveContext:async()=>assert.fail('No Experience projection'),assertCurrent:async()=>assert.fail('No Experience authority')}});
 const context={org_id:scope.org_id,owner_user_id:scope.owner_id,installation_id:scope.installation_id,account_id:binding.account_id,resource_binding_id:binding.resource_binding_id,authority_version:'graph-saga-human',expires_at:Date.now()+60000,recheck:async()=>{},draft_sync_journal:journal,draft_sync_before_effect:async value=>{reservations.push(value);return true;}};
 const adapter=await open(),baseline=await adapter.nativeEmailDraftSync({operation:'inspect',operation_id:randomUUID(),provider_draft_ref:'immutable-mapped-draft'},context),bytes=mime(desired());
 const input={operation:'update',operation_id:randomUUID(),provider_draft_ref:'immutable-mapped-draft',baseline_digest:baseline.baseline_digest,provider_version:baseline.provider_version,desired:{mime_bytes:bytes,mime_digest:hash(bytes)}};activeOperation=input.operation_id;
 return {adapter,open,context,input,journal,effects,reservations,calls,get state(){return state;},get catalogCount(){return catalogCount;},set losePost(value){losePost=value;},set externalAfterPatch(value){externalAfterPatch=value;},set nonFile(value){nonFile=value;},set corruptCatalog(value){corruptCatalog=value;},unblock(){readsBlocked=false;},replaceDesired(value){input.desired={mime_bytes:value,mime_digest:hash(value)};}};
}

export {mime as graphDraftFixtureMime};
