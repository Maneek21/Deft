import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { emailAccounts, emailDrafts, emailProviderDraftMirrors } from '@deft/db/schema';
import { EmailMailboxCrypto } from '../src/lib/email-mailbox-crypto.js';
import { EmailDraftService, type EmailDraftContent } from '../src/lib/email-draft-service.js';
import { EmailDraftStore } from '../src/lib/email-draft-store.js';

const target='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_upgrade';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
const content=(index:number):EmailDraftContent=>({mode:'compose',to:'private-recipient@example.test',cc:'',bcc:'',subject:`${String(index).padStart(2,'0')} ${'S'.repeat(990)}`,
 body:'P'.repeat(160*1024),body_html:'',reply_record_id:'',attachments:[]});

test('draft summary pagination keysets before decrypt, protects cursor by scope, and returns bounded fields',
 {skip:!safe,timeout:60000},async t=>{
 const admin=new pg.Pool({connectionString:target,max:1}),schema='email_draft_summary_'+randomUUID().replaceAll('-','');
 await admin.query(`CREATE SCHEMA "${schema}"`);
 const pool=new pg.Pool({connectionString:target,max:8,options:`-c search_path=${schema},public`});
 const database=drizzle(pool,{schema:{emailAccounts,emailDrafts,emailProviderDraftMirrors}});
 t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();});
 await pool.query('CREATE TABLE email_accounts(org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,PRIMARY KEY(org_id,owner_user_id,account_id))');
 await pool.query(readFileSync(new URL('../../../packages/db/upgrades/0.3.0-preview.66-email-native-drafts.sql',import.meta.url),'utf8'));
 await pool.query(readFileSync(new URL('../../../packages/db/upgrades/0.3.0-preview.70-email-provider-draft-mirrors.sql',import.meta.url),'utf8'));
 const scope={org_id:'summary-org-'+randomUUID(),owner_user_id:'summary-owner-'+randomUUID(),account_id:'summary-account-'+randomUUID()};
 await pool.query('INSERT INTO email_accounts(org_id,owner_user_id,account_id) VALUES($1,$2,$3)',[scope.org_id,scope.owner_user_id,scope.account_id]);
 let clock=Date.parse('2026-10-04T12:00:00.000Z');
 const keys={current:()=>({key_id:'draft-summary-fixture',key:Buffer.alloc(32,52)}),read:(_purpose:unknown,key:string)=>key==='draft-summary-fixture'?{key_id:key,key:Buffer.alloc(32,52)}:null,
  keyIds:()=>['draft-summary-fixture']};
 const crypto=new EmailMailboxCrypto(keys),store=new EmailDraftStore(database,crypto,()=>new Date(clock));
 const actor={user_id:scope.owner_user_id,web_session_id:'summary-session',access_expires_at:clock+60*60_000},binding='summary-binding';
 const authority={async current(actual:any,selected:any,operation:string,transaction?:any){
  assert.equal(actual.user_id,scope.owner_user_id);assert.equal(operation,'human_draft');
  const select=async(tx:any)=>{const [row]=await tx.select({account_id:emailAccounts.account_id}).from(emailAccounts).where(and(
    eq(emailAccounts.org_id,selected.org_id),eq(emailAccounts.owner_user_id,selected.owner_user_id),eq(emailAccounts.account_id,selected.account_id))).limit(1).for('share');
    if(!row)throw Error('not current owner account');};
  if(transaction)await select(transaction);else await database.transaction(select);
  return {scope:selected,resource_binding_id:binding,authority_version:'summary-auth',expires_at:actor.access_expires_at};
 }} as any;
 const service=new EmailDraftService(authority,store,()=>clock);
 for(let index=1;index<=52;index++){
  const draftId=`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
  await store.create(scope,draftId,content(index),{kind:'human',created_by_user_id:scope.owner_user_id,originating_run_id:null},async tx=>{await authority.current(actor,scope,'human_draft',tx);});
 }
 const first=await service.listSummaries(actor,scope,null,50);
 assert.equal(first.items.length,50);assert.equal(first.has_more,true);assert.equal(typeof first.next_cursor,'string');
 assert.deepEqual(first.items.map(item=>item.draft_id),Array.from({length:50},(_,index)=>`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`));
 assert.equal(first.items[0]?.subject,content(1).subject);assert.equal(first.items[0]?.updated_at,'2026-10-04T12:00:00.000Z');
 for(const item of first.items){assert.deepEqual(Object.keys(item).sort(),['account_id','content_revision','draft_id','revision','status','subject','updated_at']);}
 const body=JSON.stringify(first);assert.equal(body.includes('private-recipient@example.test'),false);assert.equal(body.includes('P'.repeat(1000)),false);assert.ok(Buffer.byteLength(body)<100_000);
 const second=await service.listSummaries(actor,scope,first.next_cursor,50);
 assert.equal(second.items.length,2);assert.equal(second.items[0]?.draft_id,'00000000-0000-4000-8000-000000000051');assert.equal(second.items[1]?.draft_id,'00000000-0000-4000-8000-000000000052');
 assert.equal(second.has_more,false);assert.equal(second.next_cursor,null);
 await assert.rejects(service.listSummaries(actor,{...scope,account_id:'foreign-summary-account'},first.next_cursor,50),error=>String(error).includes('EMAIL_DRAFT_ACCESS_DENIED'));
 await assert.rejects(service.listSummaries(actor,scope,first.next_cursor!.slice(0,-1)+'A',50),error=>String(error).includes('EMAIL_DRAFT_INVALID'));
 clock+=16*60_000;
 await assert.rejects(service.listSummaries(actor,scope,first.next_cursor,50),error=>String(error).includes('EMAIL_DRAFT_INVALID'));
});
