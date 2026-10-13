import assert from 'node:assert/strict';import test from 'node:test';
import {DeftExperienceRecordFormV2NodeSchema,type DeftExperienceRecordFormV2Node} from '../../../../packages/app-kit/src/app-data';
import {createDeftRecordFormV2Node} from '../../../../packages/app-kit/src/experience-sdk';
import {parseExperienceView} from './app-experience-bridge';
import {recordFieldsMode,validateRecordFields,recordChoiceValue,recordChoiceEdit} from './app-experience-record-fields';
import {createExperienceRecordWriter,type ExperienceRecordRow} from './app-experience-record-writer';
const id='11111111-1111-4111-8111-111111111111',digest='sha256:'+'a'.repeat(64);
export const settingsNode:DeftExperienceRecordFormV2Node={kind:'record_form',id:'settings',label:'Template',store_key:'templates',record_id:id,expected_revision:1,content_digest:digest,
 profile:{schema_version:'deft.record_form_profile.v2',max_record_bytes:491520,fields:[{kind:'text',field:'title',label:'Title',required:true,max_characters:120},{kind:'text',field:'subject',label:'Subject',required:false,max_characters:998}],richtext:{html_field:'body_html',plain_field:'body',label:'Template text',max_html_characters:262144,max_plain_characters:262144,links:'host_validated',inline_images:'none'}}};
const values={title:'Synthetic',subject:'Testing',body_html:'<p>  saved\ttext  </p>',body:'  saved\ttext  ',opaque:{kept:true}};
const row:ExperienceRecordRow={record_id:id,revision:1,content_digest:digest,status:'draft',value:values};
test('public v2 helper, strict schema and actual view parser admit references only under negotiated store capability',()=>{
 const {kind,...input}=settingsNode,node=createDeftRecordFormV2Node(input,['record_form.v2']);assert.deepEqual(DeftExperienceRecordFormV2NodeSchema.parse(node),settingsNode);
 const view={schema_version:'deft.experience_view.v2',capabilities:['record_form.v2'],root:node};assert.ok(parseExperienceView(view,{capabilities:['record_form.v2'],storeKeys:['templates']}));
 assert.equal(parseExperienceView(view,{capabilities:['record_form.v1'],storeKeys:['templates']}),null);assert.equal(parseExperienceView(view,{capabilities:['record_form.v2'],storeKeys:['other']}),null);
 assert.throws(()=>createDeftRecordFormV2Node(input,['record_form.v1']));assert.equal('value' in node,false);assert.equal(Object.isFrozen(node.profile.fields),true);
});
test('malformed scalar/profile/source/action and duplicate pairs denied by both public helper and host parser',()=>{
 const {kind,...input}=settingsNode;
 const bad=[{...input,value:values},{...input,action_key:'send'},{...input,source_refs:[]},{...input,profile:{...input.profile,fields:[]} , extra:true},
 {...input,profile:{...input.profile,fields:[...input.profile.fields,input.profile.fields[0]]}},
 {...input,profile:{...input.profile,richtext:{...input.profile.richtext,plain_field:'title'}}},
 {...input,profile:{...input.profile,fields:[{kind:'verified_identity',field:'address',label:'Identity',editable:true}]}},
 {...input,profile:{...input.profile,fields:[{kind:'choice',field:'mode',label:'Mode',options:[{value:'a',label:'A'},{value:'a',label:'B'}]}]}},
 {...input,profile:{...input.profile,fields:[{kind:'text',field:'__proto__',label:'Bad',max_characters:10,required:false}]}}];
 for(const input of bad){assert.throws(()=>createDeftRecordFormV2Node(input as any,['record_form.v2']));assert.equal(DeftExperienceRecordFormV2NodeSchema.safeParse({kind,...input}).success,false);}
});
test('typed scalar values and exact paired rich text validate without coercion or trimming',()=>{
 validateRecordFields(values,settingsNode.profile);for(const value of [{...values,title:1},{...values,title:'   '},{...values,body:'changed'},{...values,body_html:'<img src="https://example.test/x">'},{...values,huge:'x'.repeat(491520)}])assert.throws(()=>validateRecordFields(value,settingsNode.profile));
 const profile={schema_version:'deft.record_form_profile.v2' as const,max_record_bytes:65536,fields:[{kind:'boolean' as const,field:'enabled',label:'Enabled'},{kind:'choice' as const,field:'placement',label:'Placement',options:[{value:'both',label:'Both'}]}]};
 validateRecordFields({enabled:false,placement:'both'},profile);assert.throws(()=>validateRecordFields({enabled:'false',placement:'both'},profile));assert.throws(()=>validateRecordFields({enabled:true,placement:'none'},profile));
});
test('fresh authority enforces readonly status, exact draft revision and immutable verified identity',()=>{
 assert.deepEqual(recordFieldsMode(settingsNode,row,[]),{readonly:false,unavailable:false});for(const status of ['submitted','archived'] as const)assert.equal(recordFieldsMode(settingsNode,{...row,status,revision:9},[]).readonly,true);
 assert.throws(()=>recordFieldsMode(settingsNode,{...row,revision:2},[]));assert.equal(recordFieldsMode({...settingsNode,disabled:true},row,[]).readonly,true);
 const profile={...settingsNode.profile,fields:[{kind:'verified_identity' as const,field:'address',label:'Identity',editable:false as const}]},node={...settingsNode,profile},value={...values,address:'own@example.test'};
 assert.equal(recordFieldsMode(node,{...row,value},[]).unavailable,true);assert.equal(recordFieldsMode(node,{...row,value},[{address:value.address,label:'Own'}]).readonly,false);
 assert.throws(()=>validateRecordFields({...value,address:'other@example.test'},profile,value));
});
test('lost save status reconciles original CAS request exactly once; reopen clears old uncertain attempt',async()=>{
 let stored=structuredClone(row),writes=0,requestId='',reads=0;const abort=new AbortController();
 const writer=createExperienceRecordWriter({initial:stored,current:()=>true,signal:abort.signal,validate:value=>validateRecordFields(value,settingsNode.profile),read:async()=>stored,
 save:async(revision,value,id,hash)=>{writes++;requestId=id;assert.equal(revision,1);assert.equal(hash,digest);stored={...stored,revision:2,value};throw Error('lost response');},
 recoverSave:async(revision,value,id,hash)=>{reads++;assert.equal(id,requestId);assert.equal(revision,1);assert.equal(hash,digest);assert.deepEqual(value,stored.value);return stored;},change:()=>{}});
 writer.edit({...values,title:'  preserved  '});assert.equal(await writer.save(),false);assert.equal(await writer.save(),false);assert.equal(await writer.reconcileSave(),true);assert.equal(writer.snapshot.value.title,'  preserved  ');assert.equal(writer.snapshot.state,'saved');assert.equal(writes,1);assert.equal(reads,1);
 const uncertain=createExperienceRecordWriter({initial:row,current:()=>true,signal:abort.signal,validate:()=>{},read:async()=>row,save:async()=>{throw Error('lost');},recoverSave:async()=>{throw Error('old status must not run');},change:()=>{}});
 uncertain.edit({...values,title:'edit'});await uncertain.save();assert.equal(await uncertain.reopen(),true);assert.equal(await uncertain.reconcileSave(),false);
});
test('expired/current-false save replies and mismatched status never publish or resume mutations',async()=>{
 let live=true,release!:(row:ExperienceRecordRow)=>void,changes=0;const writer=createExperienceRecordWriter({initial:row,current:()=>live,signal:new AbortController().signal,validate:()=>{},read:async()=>row,save:()=>new Promise(resolve=>release=resolve),change:()=>changes++});
 writer.edit({...values,title:'changed'});const result=writer.save(),before=changes;live=false;release({...row,revision:2,value:writer.snapshot.value});assert.equal(await result,false);assert.equal(changes,before);
 const wrong=createExperienceRecordWriter({initial:row,current:()=>true,signal:new AbortController().signal,validate:()=>{},read:async()=>row,save:async()=>{throw Error('lost');},recoverSave:async()=>({...row,revision:2,value:{...values,title:'different'}}),change:()=>{}});
 wrong.edit({...values,title:'changed'});await wrong.save();assert.equal(await wrong.reconcileSave(),false);assert.equal(wrong.snapshot.state,'blocked');assert.equal(await wrong.save(),false);
});

test('legacy saved placement remains manual until actual trusted choice, independent of other edits',()=>{
 const field={kind:'choice' as const,field:'placement',label:'Automatically use for',activation:{field:'automatic',schema_version:'deft.signature_automatic.v1',inactive_value:'none'},options:[{value:'none',label:'Manual'},{value:'both',label:'New and replies'}]};
 const value={placement:'both',plain:'saved manual'};assert.equal(recordChoiceValue(value,field),'none');assert.equal(recordChoiceValue({...value,plain:'human edit'},field),'none');
 const next=recordChoiceEdit(value,field,'both');assert.deepEqual(next.automatic,{schema_version:'deft.signature_automatic.v1',enabled:true});assert.equal(recordChoiceValue(next,field),'both');
 assert.throws(()=>recordChoiceEdit(value,field,'unknown'));assert.equal(recordChoiceValue({...value,automatic:{schema_version:'deft.signature_automatic.v1',enabled:false}},field),'none');
});


test('activation mapping is negotiated and frozen by the public helper and actual trusted parser',()=>{
 const profile={schema_version:'deft.record_form_profile.v2' as const,max_record_bytes:65536,fields:[{kind:'choice' as const,field:'placement',label:'Automatically use for',options:[{value:'none',label:'Manual'},{value:'new',label:'New'}],activation:{field:'automatic',schema_version:'deft.signature_automatic.v1',inactive_value:'none'}}]};
 const {kind,...input}={...settingsNode,profile};assert.throws(()=>createDeftRecordFormV2Node(input,['record_form.v2']));
 const caps=['record_form.v2','record_initial_change.v1'] as const,node=createDeftRecordFormV2Node(input,caps);assert.equal(Object.isFrozen(node.profile.fields[0].kind==='choice'&&node.profile.fields[0].activation),true);
 assert.equal(parseExperienceView({schema_version:'deft.experience_view.v2',capabilities:caps,root:node},{capabilities:['record_form.v2'],storeKeys:['templates']}),null);
 assert.ok(parseExperienceView({schema_version:'deft.experience_view.v2',capabilities:caps,root:node},{capabilities:caps,storeKeys:['templates']}));
});
