import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readMailboxSyncPage} from './mailbox-sync.mjs';

const source=Buffer.from('From: Sender <sender@example.test>\r\nTo: owner@example.test\r\nSubject: Healthy message\r\nMessage-ID: <healthy@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHealthy body');
async function page(t,firstSource,inspect){
 const directory=mkdtempSync(join(tmpdir(),'deft-email-sync-isolation-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));let released=false;
 const client={mailbox:{uidValidity:3001,uidNext:3},list:async()=>[{path:'INBOX'}],getMailboxLock:async()=>({release(){released=true;}}),fetch:async function*(){for(const uid of [1,2])yield{uid,size:source.byteLength,flags:new Set(),envelope:{subject:uid===1?'Failed message':'Healthy metadata'},bodyStructure:{type:'text/plain'}};},fetchOne:async uid=>uid===1?firstSource(uid):{uid,source}};
 const options={request:{cursor:null,max_items:10},cachePath:join(directory,'cache.json'),cacheScope:'synthetic-test'};const result=await readMailboxSyncPage(client,options);assert.equal(released,true);await inspect?.(result,client,options);return result;
}
test('failed fetched message retains unavailable metadata and does not abort healthy sync page',async t=>{
 const result=await page(t,async()=>{throw Error('Synthetic source unavailable');});assert.equal(result.upserts.length,2);assert.equal(result.upserts[0].data.body_status,'unavailable');assert.equal(result.upserts[0].data.subject,'Failed message');assert.equal(result.upserts[1].data.body,'Healthy body');assert.equal(result.upserts[1].data.subject,'Healthy message');assert.equal(JSON.parse(result.next_cursor).folder,1);
});
test('malformed fetched source cannot abort healthy messages or enter its revision hash',async t=>{
 const result=await page(t,uid=>({uid,source:{byteLength:source.byteLength}}));assert.equal(result.upserts.length,2);assert.equal(result.upserts[0].data.body_status,'unavailable');assert.equal(result.upserts[0].attachments.length,0);assert.equal(result.upserts[1].data.body,'Healthy body');
});
test('unavailable message remains retryable after a committed page and the next sync round',async t=>{
 let available=false,fetches=0;await page(t,uid=>{fetches++;if(!available)throw Error('Synthetic source unavailable');return{uid,source};},async(first,client,options)=>{
  first.commit();available=true;const cursor=JSON.stringify({v:1,round:1,folder:0,after:0,validity:null,highwater:null});const retried=await readMailboxSyncPage(client,{...options,request:{cursor,max_items:10}});
  assert.equal(fetches,2);assert.equal(retried.upserts.length,1,'Healthy cached message is skipped while failed message is fetched again');assert.equal(retried.upserts[0].id,'inbox:3001:1');assert.equal(retried.upserts[0].data.body_status,'available');assert.equal(retried.upserts[0].data.body,'Healthy body');assert.notEqual(retried.upserts[0].revision,first.upserts[0].revision);
 });
});
