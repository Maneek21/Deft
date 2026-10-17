import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compileEmailSearch,createEmailMessageSearch} from './message-search.mjs';

test('Gmail structured query quotes values and uses exact epoch seconds rather than PST date parsing',()=>{
 const result=compileEmailSearch('gmail',{filters:{from:'person@example.test',subject:'quarterly plan',after:'2026-09-30T18:30:00Z',before:'2026-10-01T18:30:00Z',has_attachments:true,unread:true,flagged:false},label_ids:['INBOX'],include_spam_trash:false,limit:20});
 assert.equal(result.request.query,'from:"person@example.test" subject:"quarterly plan" has:attachment after:1790793000 before:1790879400 is:unread -is:starred');
 assert.deepEqual(result.request.label_ids,['INBOX']);assert.equal(result.request.limit,20);assert.equal(result.mode,'filters');
});
test('provider-native query is preserved exactly and cannot be mixed with structured fields',()=>{
 const query='(from:person@example.test OR to:other@example.test) filename:pdf -in:trash';
 assert.equal(compileEmailSearch('gmail',{provider_query:query}).request.query,query);
 assert.throws(()=>compileEmailSearch('gmail',{provider_query:query,filters:{subject:'other'}}),/REQUEST_INVALID/u);
});
test('Microsoft maps its supported KQL fields, folder scope and honest cap',()=>{
 const result=compileEmailSearch('microsoft',{filters:{cc:'person@example.test',filename:'proof.pdf',received_on:'2026-10-01',has_attachments:false},folder_id:'immutable-folder'});
 assert.equal(result.request.query,'cc:"person@example.test" AND attachment:"proof.pdf" AND hasAttachments:false AND received:10/01/2026');
 assert.equal(result.request.folder_id,'immutable-folder');assert.ok(result.limitations.includes('provider_result_cap_1000'));
 for(const filters of [{unread:true},{after:'2026-10-01T00:00:00Z'},{body:'x'}])assert.throws(()=>compileEmailSearch('microsoft',{filters}),/FILTER_UNSUPPORTED/u);
});
test('quoted typed filters reject operator injection and invalid bounds before provider IO',()=>{
 for(const input of [{filters:{subject:'x" OR from:foreign'}},{filters:{text:'x\\y'}},{filters:{has_attachments:'true'}},{filters:{after:'2026-02-30T00:00:00Z'}},{filters:{after:'2026-10-02T00:00:00Z',before:'2026-10-01T00:00:00Z'}},{filters:{received_on:'2026-10-01',after:'2026-10-01T00:00:00Z'}},{provider_query:'x'.repeat(2049)},{provider_query:'x',limit:101},{provider_query:'x',owner_id:'other'}])assert.throws(()=>compileEmailSearch('gmail',input));
 assert.throws(()=>compileEmailSearch('imap_smtp',{provider_query:'anything'}),/OPERATION_UNSUPPORTED/u);
 assert.throws(()=>compileEmailSearch('gmail',{filters:{}}));
});
test('search uses only exact nominated account and preserves partial provider coverage and cursor',async()=>{
 const calls=[];const runtime={listAccounts:()=>[{account_id:'mine',provider:'microsoft'}],async searchMessages(...args){calls.push(args);return {account_id:'mine',messages:[{account_id:'mine',logical_message_id:'mail_1'}],complete:false,has_more:true,next_cursor:'bound-cursor',count:{returned:1,exact_total:null,provider_result_cap:1000}};}};
 const result=await createEmailMessageSearch({runtime}).search({account_id:'mine',provider_query:'subject:plan',cursor:'bound-cursor'});
 assert.equal(result.complete,false);assert.equal(result.count.exact_total,null);assert.equal(result.next_cursor,'bound-cursor');assert.deepEqual(calls,[['mine',{query:'subject:plan',limit:25,cursor:'bound-cursor'}]]);
 await assert.rejects(createEmailMessageSearch({runtime}).search({account_id:'foreign',provider_query:'subject:plan'}),/ACCOUNT_NOT_FOUND/u);assert.equal(calls.length,1);
});
test('foreign returned messages or false full-Graph claims fail closed',async()=>{
 const runtime=page=>({listAccounts:()=>[{account_id:'mine',provider:'microsoft'}],searchMessages:async()=>page});
 for(const page of [{account_id:'mine',messages:[{account_id:'foreign'}],complete:false,has_more:false},{account_id:'mine',messages:[],complete:true,has_more:false}])await assert.rejects(createEmailMessageSearch({runtime:runtime(page)}).search({account_id:'mine',provider_query:'plan'}),/RUNTIME_INVALID/u);
});
