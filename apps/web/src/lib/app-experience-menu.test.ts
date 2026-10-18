import assert from 'node:assert/strict';
import test from 'node:test';
import {DeftImplementedExperienceCapabilitySchema} from '../../../../packages/app-kit/src/experience-capabilities';
import {parseExperienceView} from './app-experience-bridge';
const menu={kind:'menu',id:'more',label:'More',items:[{id:'print',label:'Print',icon:'print'}]};
const view={schema_version:'deft.experience_view.v2',capabilities:['menu.v1'],root:{kind:'stack',id:'root',children:[menu,{kind:'document',id:'body',format:'plain',content:'Exact source',printable:true,print_control_id:'print'}]}};
const options={capabilities:['menu.v1'] as const};
test('menu child IDs are part of view uniqueness, print linking and the node budget',()=>{
 assert.deepEqual(parseExperienceView(view,options),view);assert.equal(parseExperienceView(view),null);
 assert.equal(parseExperienceView({...view,capabilities:[]},options),null);
 for(const extra of [{kind:'button',id:'print',label:'Duplicate'},{kind:'text',id:'more',text:'Duplicate'}])assert.equal(parseExperienceView({...view,root:{...view.root,children:[...view.root.children,extra]}},options),null);
 assert.equal(parseExperienceView({...view,navigation:[{kind:'button',id:'print',label:'Duplicate'}]},options),null);
 assert.equal(parseExperienceView({...view,preferences:{kind:'text',id:'print',text:'Duplicate'}},options),null);
 assert.equal(parseExperienceView({...view,preferences:{...menu,id:'preferences'}},options),null);
 const many=Array.from({length:13},(_,i)=>({...menu,id:'menu_'+i,items:Array.from({length:20},(_,j)=>({id:'item_'+i+'_'+j,label:'Item'}))}));
 assert.equal(parseExperienceView({...view,root:{kind:'stack',id:'root',children:many}},options),null);
});
test('keyboard targets the visible menu trigger and denies hidden portaled items',()=>{
 const capabilities=['menu.v1','keyboard_controls.v1'] as const;
 assert.ok(parseExperienceView({...view,capabilities,keyboard:{schema_version:'deft.experience_keyboard.v1',bindings:[{key:'p',target_id:'more',behavior:'activate'}]}},{capabilities}));
 assert.equal(parseExperienceView({...view,capabilities,keyboard:{schema_version:'deft.experience_keyboard.v1',bindings:[{key:'p',target_id:'print',behavior:'activate'}]}},{capabilities}),null);
 assert.equal(parseExperienceView({...view,capabilities,keyboard:{schema_version:'deft.experience_keyboard.v1',bindings:[{key:'p',target_id:'not_present',behavior:'activate'}]}},{capabilities}),null);
});

test('a menu coexists with all implemented declared capabilities within the closed enum bound',()=>{const capabilities=[...DeftImplementedExperienceCapabilitySchema.options];assert.ok(parseExperienceView({...view,capabilities},{capabilities}));});

test('native integration menu nominations bind only exact governed document IDs in the current view',()=>{
 const capabilities=['menu.v1','record_document.v1'] as const;
 const document={kind:'record_document',id:'mail_body',profile_version:'deft.record_document.v1',store_key:'drafts',resource_key:'inbox',record_id:'11111111-1111-4111-8111-111111111111',content_digest:'sha256:'+'a'.repeat(64)};
 const base={schema_version:'deft.experience_view.v2',capabilities,root:{kind:'stack',id:'root',children:[{...menu,items:[{id:'task',label:'Create task',integration:{kind:'task',document_id:'mail_body'}}]},document]}};
 const options={capabilities,storeKeys:['drafts'],resourceKeys:['inbox']};
 assert.deepEqual(parseExperienceView(base,options),base);
 assert.equal(parseExperienceView({...base,root:{...base.root,children:[base.root.children[0],{...document,printable:true,print_control_id:'task'}]}},options),null);
 for(const integration of [{kind:'unknown',document_id:'mail_body'},{kind:'task',document_id:'other'},{kind:'knowledge',document_id:'mail_body',url:'https://foreign.example'}])assert.equal(parseExperienceView({...base,root:{...base.root,children:[{...menu,items:[{id:'task',label:'Create task',integration}]},document]}},options),null);
 assert.equal(parseExperienceView({...base,root:{...base.root,children:[{...menu,items:[{id:'task',label:'Create task',integration:{kind:'task',document_id:'plain'}}]},{kind:'document',id:'plain',format:'plain',content:'untrusted nomination'}]}},options),null);
});
