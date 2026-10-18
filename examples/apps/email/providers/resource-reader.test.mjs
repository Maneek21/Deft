import test from 'node:test';
import assert from 'node:assert/strict';
import {projectProviderDocument,parsedMailboxes,projectConversationCoverage} from './resource-reader.mjs';
import {LogicalMailIndex} from '../logical-mail-index.mjs';
const account={account_id:'microsoft-a',provider:'microsoft',primary_address:'owner@example.test',verified_sender_identities:['owner@example.test']};
const headers=[{name:'From',value:'peer@example.test'},{name:'To',value:'owner@example.test'},{name:'Message-ID',value:'<parent@example.test>'},{name:'References',value:'<prior@example.test>'},{name:'Subject',value:'Parent'}];
const detail={message:{account_id:account.account_id,provider:account.provider},headers,body:{format:'html',content:'<div>Hello <b>owner</b>.</div><script>bad()</script><img src="https://private.invalid/load">'}};
test('Graph HTML fallback produces local plain text with no passive loads and full bounded threading metadata',async()=>{
 const result=await projectProviderDocument({account,logical_message_id:'mail_'+'a'.repeat(64),detail,max_characters:16384});
 assert.equal(result.document.format,'plain');assert.ok(result.document.content.includes('Hello owner.'));assert.ok(!result.document.content.includes('<script'));assert.ok(!result.document.content.includes('<img'));assert.equal(result.document.truncated,false);assert.equal(result.reply.message_id,'<parent@example.test>');
});
test('reviewed HTML preserves formatting and exact metadata with bounded plain reply fallback',async()=>{
 const hostile={...detail,body:{...detail.body,untrusted:true}};
 const result=await projectProviderDocument({account,logical_message_id:'mail_'+'a'.repeat(64),detail:hostile,max_characters:16384,formats:['plain','html']});
 assert.equal(result.document.format,'html');assert.match(result.document.content,/<b>owner<\/b>/);assert.match(result.document.plain_text,/Hello owner/);assert.equal(result.reply.message_id,'<parent@example.test>');
 assert.ok(result.document.content.includes('<img'),'HTML is hostile transport until independently sanitized by host');
 const bounded=await projectProviderDocument({account,logical_message_id:'mail_'+'a'.repeat(64),detail:hostile,max_characters:16,formats:['plain','html']});assert.equal(bounded.document.truncated,true);assert.ok(Buffer.byteLength(bounded.document.content)<=16);
});
test('closed reader rejects duplicate/injected headers, excessive recipients, wrong account and unsupported body encoding',async()=>{
 for(const changed of [{...detail,headers:[...headers,{name:'From',value:'attacker@example.test'}]},{...detail,headers:headers.map(row=>row.name==='From'?{...row,value:'peer@example.test\r\nBcc: attacker@example.test'}:row)},{...detail,message:{...detail.message,account_id:'other'}}])await assert.rejects(projectProviderDocument({account,logical_message_id:'mail_'+'a'.repeat(64),detail:changed,max_characters:16384}));
 assert.throws(()=>parsedMailboxes(Array.from({length:33},(_,i)=>`a${i}@example.test`).join(', ')));
 const gmail={...account,provider:'gmail'},bad={message:{account_id:account.account_id,provider:'gmail'},body:{payload:{mimeType:'text/plain',headers:[],body:{size:1,data:Buffer.from([255]).toString('base64url')}}}};
 await assert.rejects(projectProviderDocument({account:gmail,logical_message_id:'mail_'+'a'.repeat(64),detail:bad,max_characters:16384}));
});

function coverageFixture(){
 const scope={org_id:'org',owner_id:'owner',installation_id:'installation'}, selected={...account,authority_epoch:7,resource_binding_id:'resource'},index=new LogicalMailIndex(scope);
 const row=index.upsert(scope,{account_id:selected.account_id,provider:'microsoft',locator:{kind:'microsoft',message_id:'native',conversation_id:'thread',folder_id:'inbox',id_type:'immutable'},subject:'Parent',message_id:'<parent@example.test>',date:'2026-09-30T00:00:00.000Z',folders:['inbox'],body_status:'lazy'});
 const evidence={...detail,message:{account_id:selected.account_id,provider:'microsoft',locator:row.locator}};
 const mark=(extra={})=>index.markCoverage(scope,{account_id:selected.account_id,conversation_id:row.conversation_id,complete:true,covers_folders:['inbox','sent'],observed_at:'2026-09-30T00:00:00.000Z',authority_epoch:7,resource_binding_id:'resource',...extra});
 const read=(extra={})=>projectConversationCoverage({scope,account:selected,state:index.exportState(scope),record:row,detail:evidence,now:Date.parse('2026-10-01T00:00:00.000Z'),...extra});return {scope,selected,index,row,evidence,mark,read};
}
test('coverage requires canonical drained current authority and preserves historical as-of without TTL',()=>{
 const f=coverageFixture();assert.equal(f.read().conversation_coverage_state,'unknown');f.mark();const result=f.read();assert.equal(result.conversation_coverage_state,'complete');assert.equal(result.conversation_drained,'true');assert.equal(result.conversation_exact_count,'1');assert.equal(result.conversation_observed_at,'2026-09-30T00:00:00.000Z');assert.equal(Object.keys(result).length,7);
 for(const extra of [{authority_epoch:6},{resource_binding_id:'other'}]){f.mark(extra);assert.equal(f.read().conversation_coverage_state,'stale');assert.equal(f.read().conversation_exact_count,'');}
 f.mark({authority_epoch:null,resource_binding_id:null});assert.equal(f.read().conversation_coverage_state,'unknown');
 for(const observed_at of ['2099-01-01T00:00:00.000Z','2026-09-30T00:00:00Z']){f.mark({observed_at});assert.equal(f.read().conversation_coverage_state,'unknown');assert.equal(f.read().conversation_observed_at,'');}
 f.mark({complete:false});assert.equal(f.read().conversation_coverage_state,'partial');assert.equal(f.read().conversation_drained,'false');
 f.mark();assert.equal(f.read({detail:{...f.evidence,message:{...f.evidence.message,locator:{...f.row.locator,conversation_id:'changed'}}}}).conversation_coverage_state,'stale');
 f.index.upsert(f.scope,{...f.row.summary,account_id:f.selected.account_id,provider:'microsoft',locator:f.row.locator});assert.notEqual(f.read().conversation_coverage_state,'complete');
});


test('mailbox reset remains explicit independently of a newly drained selected conversation',()=>{
 const f=coverageFixture();f.index.beginMetadataReset(f.scope,{account_id:f.selected.account_id,binding:'a'.repeat(64),folder_ids:['inbox']});assert.equal(f.read().conversation_coverage_state,'reset_required');f.mark();const result=f.read();assert.equal(result.conversation_coverage_state,'complete');assert.equal(result.mailbox_reset_required,'true');assert.equal(result.conversation_exact_count,'1');
});
