import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMailboxList, MailboxListError, parseMailboxList } from '../src/mailbox-list.ts';
import { parseRuntimeObjectInput, RuntimeObjectSchema } from '../src/runtime-authoring.ts';

test('mailbox list preserves order, display names and duplicates and safely roundtrips quoted names', () => {
  const source='"Doe, Jane" <Jane@EXAMPLE.test>; "Alex \\"Quoted\\"" <alex@example.test>; JANE@example.test';
  const parsed=parseMailboxList(source,{maxItems:3});
  assert.deepEqual(parsed,[{address:'Jane@example.test',displayName:'Doe, Jane'},
    {address:'alex@example.test',displayName:'Alex "Quoted"'},{address:'JANE@example.test',displayName:''}]);
  assert.deepEqual(parseMailboxList(formatMailboxList(parsed),{maxItems:3}),parsed);
  assert.throws(()=>parseMailboxList(source,{maxItems:2}),MailboxListError);
});

test('mailbox grammar rejects injections, unsupported headers, incomplete addresses and controls', () => {
  for(const text of ['valid@example.test\r\nBcc:injected@example.test','a..b@example.test','a@-bad.test','a@bad..test',
    'Group:a@example.test;','Name <a@example.test','"unfinished <a@example.test>','"bad\nname" <a@example.test>',
    'a@example.test\r\nb@example.test','a@example.test\nb@example.test','a@example.test\0','\va@example.test','Name <a@example.test\n>','"bad\u202ename" <a@example.test>',
    '"bad\ud800name" <a@example.test>','"quoted"@example.test']) assert.throws(()=>parseMailboxList(text),MailboxListError,text);
  assert.deepEqual(parseMailboxList('',{allowEmpty:true}),[]);
  assert.throws(()=>parseMailboxList(''),MailboxListError);
  assert.throws(()=>parseMailboxList(',;',{allowEmpty:true}),MailboxListError);
  assert.throws(()=>parseMailboxList('x'.repeat(2049)),MailboxListError);
});

test('reviewed mailbox_list strings require maxItems and keep the exact admitted scalar', () => {
  const contract={type:'object',properties:{to:{type:'string',format:'mailbox_list',maxLength:2048,minLength:1,maxItems:2},
    cc:{type:'string',format:'mailbox_list',maxLength:2048,maxItems:2}},required:['to'],additionalProperties:false};
  const input={to:'"Doe, Jane" <jane@EXAMPLE.test>; bob@example.test',cc:''};
  assert.deepEqual(parseRuntimeObjectInput(contract as never,input),input);
  assert.deepEqual(parseRuntimeObjectInput(contract as never,{to:'a@example.test; A@example.test'}),{to:'a@example.test; A@example.test'});
  assert.throws(()=>parseRuntimeObjectInput(contract as never,{to:'a@example.test; b@example.test; c@example.test'}));
  assert.throws(()=>parseRuntimeObjectInput(contract as never,{to:'a@example.test\r\nBcc: b@example.test'}));
  for(const declaration of [{type:'string',format:'mailbox_list',maxLength:100},
    {type:'string',format:'mailbox_list',maxLength:100,maxItems:33},{type:'string',format:'mailbox_list',maxLength:2049,maxItems:32},{type:'string',format:'safe_html',maxLength:100},{type:'string',format:'resource_record_list',maxLength:100},{type:'string',format:'email',maxLength:100,maxItems:1},
    {type:'string',maxLength:100,maxItems:1}]) assert.equal(RuntimeObjectSchema.safeParse({...contract,properties:{to:declaration}}).success,false);
});

test('current compose bound counts duplicate entries and rejects the thirty-third recipient',()=>{
 const scalar=Array(32).fill('same@example.test').join(', ');
 assert.equal(parseMailboxList(scalar,{maxItems:32}).length,32);
 assert.throws(()=>parseMailboxList(scalar+', same@example.test',{maxItems:32}),MailboxListError);
 for(const maxItems of [0,33,1.5])assert.throws(()=>parseMailboxList('a@example.test',{maxItems}),MailboxListError);
});
