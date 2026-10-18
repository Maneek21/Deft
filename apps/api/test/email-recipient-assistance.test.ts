import assert from 'node:assert/strict';
import test from 'node:test';
import {EmailRecipientAssistance,EmailRecipientError} from '../src/lib/email-recipient-assistance.js';
import {GovernedEmailRecipientContacts} from '../src/lib/email-recipient-contacts.js';
import type {EmailAuthority} from '../src/lib/email-mailbox-service.js';
import type {ModuleInstallationView,ModuleRecordPage} from '../src/lib/module-service.js';
const actor={user_id:'owner',web_session_id:'sid',access_expires_at:10000},scope={org_id:'org',owner_user_id:'owner',account_id:'account'};
function fixture(){
 const state={epoch:'one',now:1000,checks:0,after:()=>{}};
 const authority:EmailAuthority={current:async()=>{state.checks++;return {scope,resource_binding_id:'binding',authority_version:state.epoch,expires_at:10000};}};
 const contacts={search:async(_a:unknown,_s:unknown,input:{limit:number})=>{assert.equal(input.limit,20);return {items:[{address:'ADA@Example.test',name:'Ada'},{address:'bad\n@example.test',name:'Bad'}],status:'available' as const,has_more:false};}};
 const recent={list:async(_a:unknown,_s:unknown,input:{limit:number})=>{assert.equal(input.limit,50);state.after();return {items:[{account_id:'account',state:'accepted',to:'"Ada Lovelace" <ada@example.test>, other@example.test',cc:'',bcc:''},{account_id:'account',state:'cancelled',to:'cancelled@example.test',cc:'',bcc:''}],has_more:false};}};
 return {state,contacts,recent,service:new EmailRecipientAssistance(authority,contacts,recent,()=>state.now)};
}
test('bounded projections merge canonical addresses and exclude malformed and unsent recipients',async()=>{
 const f=fixture(),page=await f.service.query(actor,scope,{query:'a'});assert.equal(f.state.checks,2);
 assert.deepEqual(page.items,[{address:'ADA@example.test',name:'Ada',provenance:['contacts','recent']},{address:'other@example.test',name:'',provenance:['recent']}]);
 assert.deepEqual(Object.keys(page.items[0]!).sort(),['address','name','provenance']);assert.doesNotMatch(JSON.stringify(page),/binding|owner|operation|subject|body/);
});
test('late revocation or expired human session after source waits denies suggestions',async()=>{
 for(const change of ['epoch','expiry']){const f=fixture();f.state.after=()=>{if(change==='epoch')f.state.epoch='two';else f.state.now=10000;};await assert.rejects(f.service.query(actor,scope,{query:'a'}),error=>error instanceof EmailRecipientError&&error.code==='EMAIL_RECIPIENT_ACCESS_DENIED');}
});
test('scope and query errors cannot enter source reads; aborted queries do not publish',async()=>{
 const f=fixture();await assert.rejects(f.service.query({...actor,user_id:'other'},scope,{query:'a'}));assert.equal(f.state.checks,0);
 await assert.rejects(f.service.query(actor,scope,{query:'a',account_id:'other'}));assert.equal(f.state.checks,0);
 const abort=new AbortController();f.state.after=()=>abort.abort(Error('Stopped'));await assert.rejects(f.service.query(actor,scope,{query:'a'},abort.signal),/Stopped/);
});
test('unavailable Contacts never discloses rows and accepted receipt scope is exact',async()=>{
 const f=fixture();f.contacts.search=async()=>({items:[],status:'available',has_more:false});f.recent.list=async()=>({items:[{account_id:'other',state:'accepted',to:'a@example.test',cc:'',bcc:''}],has_more:false});await assert.rejects(f.service.query(actor,scope,{query:'a'}));
});
function contactsFixture(){
 const installation={id:'installation',module_id:'com.deft.contacts',enabled:true,active_version_id:'v1',manifest_digest:'digest',manifest:{id:'com.deft.contacts',collections:[{key:'contacts',fields:[{key:'email',type:'email'},{key:'name',type:'text'}],search:{title_field:'name',fields:['name','email']}}]}} as ModuleInstallationView;
 const record={resource_id:'resource',id:'record',installation_id:'installation',module_id:'com.deft.contacts',collection_key:'contacts',manifest_digest:'digest',data:{email:'Ada@EXAMPLE.test',name:'Ada',private_notes:'private'},relations:[],members:[],revision:1,created_at:'2026-10-04T00:00:00.000Z',updated_at:'2026-10-04T00:00:00.000Z',archived_at:null};
 let reads=0;const state={installation,record,after:()=>{}};
 const service=new GovernedEmailRecipientContacts({list:async()=>{if(reads++)state.after();return [state.installation];},query:async(_a,_s,input)=>{assert.equal(input.module_id,'com.deft.contacts');assert.equal(input.collection_key,'contacts');assert.equal(input.limit,20);return {records:[state.record],next_cursor:null} as ModuleRecordPage;}});
 return {service,state};
}
test('Contacts uses exact verified installation and schema, returning only name and mailbox',async()=>{
 const f=contactsFixture();assert.deepEqual((await f.service.search(actor,scope,{query:'Ada',limit:20})).items,[{address:'Ada@example.test',name:'Ada'}]);
});
test('Contacts refuses foreign record and changed manifest or disabled module after query',async()=>{
 const foreign=contactsFixture();foreign.state.record.installation_id='foreign';await assert.rejects(foreign.service.search(actor,scope,{query:'a',limit:20}),/CONTACTS_SCOPE/);
 for(const change of ['digest','disabled']){const f=contactsFixture();f.state.after=()=>{f.state.installation={...f.state.installation,...(change==='digest'?{manifest_digest:'changed'}:{enabled:false})};};await assert.rejects(f.service.search(actor,scope,{query:'a',limit:20}),/CONTACTS_AUTHORITY_CHANGED/);}
});
