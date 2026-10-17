import test from 'node:test';
import assert from 'node:assert/strict';
import {parseResourceRecordList} from '../src/resource-record-list.ts';
import {RuntimeObjectSchema,parseRuntimeObjectInput} from '../src/runtime-authoring.ts';
const a='00000000-0000-4000-8000-00000000000A',b='00000000-0000-4000-8000-00000000000b';
test('resource record CSV preserves exact distinct identities within the reviewed cap',()=>{
 assert.deepEqual(parseResourceRecordList(`${a},${b}`,{maxItems:2}),[a.toLowerCase(),b]);
 for(const value of ['',`${a},`,`${a}, ${b}`,`${a};${b}`,`${a},${a.toLowerCase()}`,JSON.stringify([a]),`${a}\n`])assert.throws(()=>parseResourceRecordList(value));
 assert.throws(()=>parseResourceRecordList(`${a},${b}`,{maxItems:1}));
 assert.deepEqual(parseResourceRecordList('',{maxItems:1,allowEmpty:true}),[]);
 for(const value of [' ',`${a},`,`,${a}`])assert.throws(()=>parseResourceRecordList(value,{maxItems:1,allowEmpty:true}));
});
test('resource annotation requires bounded maxItems and reviewed resourceKey only on its format',()=>{
 const contract=RuntimeObjectSchema.parse({type:'object',properties:{messages:{type:'string',minLength:1,maxLength:925,format:'resource_record_list',maxItems:25,resourceKey:'messages'}},required:['messages'],additionalProperties:false});
 assert.equal(parseRuntimeObjectInput(contract,{messages:a}).messages,a);
 assert.throws(()=>parseRuntimeObjectInput(contract,{messages:''}));
 assert.equal(parseRuntimeObjectInput({...contract,properties:{messages:{...contract.properties.messages,minLength:0}}},{messages:''}).messages,'');
 for(const field of [{...contract.properties.messages,resourceKey:undefined},{...contract.properties.messages,maxItems:26},
 {...contract.properties.messages,maxLength:926},{type:'string',maxLength:100,resourceKey:'messages'}])assert.throws(()=>RuntimeObjectSchema.parse({...contract,properties:{messages:field}}));
});

test('Stage1 Reply parent admits exactly one UUID nomination and rejects provider URLs and controls',()=>{
 const contract={type:'object',properties:{parent_record_id:{type:'string',format:'resource_record_list',minLength:1,maxLength:36,maxItems:1,resourceKey:'messages'}},required:['parent_record_id'],additionalProperties:false};
 assert.equal(parseRuntimeObjectInput(contract as never,{parent_record_id:a}).parent_record_id,a);
 for(const parent_record_id of [a+','+b,'https://gmail.googleapis.com/gmail/v1/users/me/messages/123',a+'\r\n',a+'\0'])assert.throws(()=>parseRuntimeObjectInput(contract as never,{parent_record_id}));
 for(const resourceKey of ['__proto__','constructor','messages/123','https://evil.test'])assert.throws(()=>RuntimeObjectSchema.parse({...contract,properties:{parent_record_id:{...contract.properties.parent_record_id,resourceKey}}}));
});
