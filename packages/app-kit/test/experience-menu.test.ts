import assert from 'node:assert/strict';
import test from 'node:test';
import {createDeftMenuNode} from '../src/experience-sdk.js';
import {parseDeftExperienceMenuNode} from '../src/experience-menu.js';
import {negotiateDeftExperienceCapabilities} from '../src/experience-capabilities.js';
const input={id:'actions',label:'Actions',icon:'more' as const,items:[{id:'archive',label:'Archive',icon:'archive' as const},{id:'delete',label:'Delete',icon:'trash' as const,danger:true}]};
test('generic menus are closed, flat and bounded and require explicit capability negotiation',()=>{
 const node=createDeftMenuNode(input,['menu.v1']);assert.deepEqual(node,{kind:'menu',...input});
 assert.throws(()=>createDeftMenuNode(input,[]),/CAPABILITY_UNAVAILABLE/);
 assert.throws(()=>createDeftMenuNode({...input,kind:'menu'} as any,['menu.v1']));
 const host={schema_version:'deft.experience_capabilities.v1',view_version:'deft.experience_view.v2',capabilities:[]};
 assert.throws(()=>negotiateDeftExperienceCapabilities({schema_version:host.schema_version,view_version:host.view_version,required:['menu.v1'],optional:[]},host));
 for(const patch of [{url:'https://invalid.test'},{items:[]},{items:Array.from({length:21},(_,i)=>({id:'item_'+i,label:'Item'}))},{items:[{id:'actions',label:'Collision'}]},{items:[input.items[0],input.items[0]]},{items:[{id:'child',label:'Child',items:[]}]},{items:[{id:'child',label:'Child',action_key:'send'}]},{icon:'anything'},{label:' '},{label:'x'.repeat(129)},{disabled:'true'},{items:[{id:'child',label:'Child',danger:'true'}]}])assert.equal(parseDeftExperienceMenuNode({...node,...patch}),null);
 assert.equal(createDeftMenuNode({...input,items:Array.from({length:20},(_,i)=>({id:'item_'+i,label:'Item'}))},['menu.v1']).items.length,20);
});
