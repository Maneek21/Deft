import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {eq} from 'drizzle-orm';
import {emailAccounts,jobQueue} from '@deft/db/schema';
import {PostgresEmailMailboxRefresh} from '../src/lib/email-mailbox-refresh.js';
import type {EmailAuthorityDatabase} from '../src/lib/email-mailbox-authority.js';
import {EMAIL_MAILBOX_QUEUE,EMAIL_MAILBOX_SYNC_JOB,emailMailboxSyncDedupeKey} from '../src/lib/email-mailbox-scheduler.js';
import {EmailMailboxError} from '../src/lib/email-mailbox-service.js';

const target='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_fresh_65';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
test('PG Refresh deduplicates, advances pending work, preserves running lease and rolls back late denial',
  {skip:!safe,timeout:30000},async t=>{
    const namespace='refresh_'+randomUUID().replaceAll('-','');
    const admin=new pg.Pool({connectionString:target,max:1});
    await admin.query(`CREATE SCHEMA ${namespace}`);
    const pool=new pg.Pool({connectionString:target,max:4,options:`-c search_path=${namespace},public`});
    t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();});
    await pool.query(`CREATE TABLE email_accounts (LIKE public.email_accounts INCLUDING ALL);
      CREATE TABLE job_queue (LIKE public.job_queue INCLUDING ALL);
      ALTER TABLE email_accounts ADD COLUMN provider_draft_sync_enabled boolean NOT NULL DEFAULT false;`);
    const db=drizzle(pool,{schema:{emailAccounts,jobQueue}}),now=Date.now();
    const scope={org_id:randomUUID(),owner_user_id:randomUUID(),account_id:'test-account'};
    const actor={user_id:scope.owner_user_id,web_session_id:randomUUID(),access_expires_at:now+60000};
    const binding=randomUUID();
    await db.insert(emailAccounts).values({...scope,provider:'gmail',resource_binding_id:binding,principal_digest:'a'.repeat(64),
      state:'active',authority_revision:1,consented_at:new Date(now)});
    let sqlCalls=0,denyAt=Infinity;
    const authority={inspect:async(host:any,selected:any,operation:any,tx:any)=>{
      assert.deepEqual(host,actor);assert.deepEqual(selected,scope);assert.equal(operation,'human_sync');assert.equal(tx,undefined);
      return {capability:{scope,resource_binding_id:binding,authority_version:'current',expires_at:now+60000},
        account:{principal_digest:'a'.repeat(64)}} as any;
    }};
    const sqlAuthority={current:async(host:any,selected:any,operation:any,tx:any)=>{
      assert.deepEqual(host,actor);assert.deepEqual(selected,scope);assert.equal(operation,'human_sync');
      if(++sqlCalls===denyAt)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
      return {scope,resource_binding_id:binding,authority_version:'sql-current',expires_at:now+60000} as any;
    }};
    // This test covers queue transactions, not AppGraph or provider authentication.
    const queue=async(_q:any,_n:any,payload:any,options:any)=>{
      await options.executor.insert(jobQueue).values({id:randomUUID(),org_id:scope.org_id,queue:_q,name:_n,data:payload,
        dedupe_key:options.dedupeKey,max_attempts:options.maxAttempts,run_at:new Date(now+10000)}).onConflictDoNothing();
    };
    const service=new PostgresEmailMailboxRefresh(db as unknown as EmailAuthorityDatabase,async()=>({authority,sqlAuthority}),queue,()=>now);
    assert.deepEqual(await service.request(actor,scope.org_id,scope.account_id),{account_id:scope.account_id,state:'queued'});
    await service.request(actor,scope.org_id,scope.account_id);
    let rows=await db.select().from(jobQueue);assert.equal(rows.length,1);assert.equal(rows[0]!.run_at.getTime(),now);
    const jobId=rows[0]!.id,token=randomUUID();
    await db.update(jobQueue).set({status:'running',lock_token:token,locked_by:'existing-worker',attempts:2,
      lock_expires_at:new Date(now+30000)}).where(eq(jobQueue.id,jobId));
    assert.equal((await service.request(actor,scope.org_id,scope.account_id)).state,'syncing');
    rows=await db.select().from(jobQueue);assert.equal(rows[0]!.lock_token,token);assert.equal(rows[0]!.attempts,2);
    await db.update(jobQueue).set({status:'pending',run_at:new Date(now+10000),lock_token:null,locked_by:null,
      lock_expires_at:null}).where(eq(jobQueue.id,jobId));
    denyAt=sqlCalls+3;
    await assert.rejects(service.request(actor,scope.org_id,scope.account_id),error=>error instanceof EmailMailboxError&&error.code==='EMAIL_ACCESS_DENIED');
    rows=await db.select().from(jobQueue);assert.equal(rows[0]!.run_at.getTime(),now+10000);assert.equal(rows[0]!.attempts,2);
    denyAt=Infinity;
    await db.update(jobQueue).set({status:'failed',error:'EMAIL_ACCESS_DENIED'}).where(eq(jobQueue.id,jobId));
    assert.equal((await service.request(actor,scope.org_id,scope.account_id)).state,'needs_attention');
    await db.update(jobQueue).set({error:'EMAIL_SYNC_UNAVAILABLE'}).where(eq(jobQueue.id,jobId));
    assert.equal((await service.request(actor,scope.org_id,scope.account_id)).state,'queued');
    rows=await db.select().from(jobQueue);assert.equal(rows[0]!.attempts,0);assert.equal(rows[0]!.error,null);
  });

test('refresh status inspection does not wait on custody while holding a job-queue row',
  {skip:!safe,timeout:30000},async t=>{
    const namespace='refresh_order_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:target,max:1});
    await admin.query(`CREATE SCHEMA ${namespace}`);
    const pool=new pg.Pool({connectionString:target,max:4,options:`-c search_path=${namespace},public`});
    t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();});
    await pool.query(`CREATE TABLE email_accounts (LIKE public.email_accounts INCLUDING ALL);
      CREATE TABLE job_queue (LIKE public.job_queue INCLUDING ALL);
      ALTER TABLE email_accounts ADD COLUMN provider_draft_sync_enabled boolean NOT NULL DEFAULT false;`);
    const db=drizzle(pool,{schema:{emailAccounts,jobQueue}}),now=Date.now(),scope={org_id:randomUUID(),owner_user_id:randomUUID(),account_id:'custody-order-account'};
    const actor={user_id:scope.owner_user_id,web_session_id:randomUUID(),access_expires_at:now+60000},binding=randomUUID();
    await db.insert(emailAccounts).values({...scope,provider:'gmail',resource_binding_id:binding,principal_digest:'d'.repeat(64),state:'active',authority_revision:1,consented_at:new Date(now)});
    const payload={...scope,authority_revision:1},dedupeKey=emailMailboxSyncDedupeKey(payload),jobId=randomUUID();
    await db.insert(jobQueue).values({id:jobId,org_id:scope.org_id,queue:EMAIL_MAILBOX_QUEUE,name:EMAIL_MAILBOX_SYNC_JOB,data:payload,dedupe_key:dedupeKey,max_attempts:5,run_at:new Date(now+60000)});
    let release!:()=>void,markFinal!:()=>void;const released=new Promise<void>(resolve=>{release=resolve;}),finalStatus=new Promise<void>(resolve=>{markFinal=resolve;});
    let statusCalls=0;
    const authority={inspect:async()=>{
      if(++statusCalls===2){markFinal();await released;}
      return {capability:{scope,resource_binding_id:binding,authority_version:'stable',expires_at:now+60000},account:{principal_digest:'d'.repeat(64)}} as any;
    }};
    const sqlAuthority={current:async()=>({scope,resource_binding_id:binding,authority_version:'stable-sql',expires_at:now+60000}) as any};
    const service=new PostgresEmailMailboxRefresh(db as unknown as EmailAuthorityDatabase,async()=>({authority,sqlAuthority}),async()=>{},()=>now);
    const request=service.request(actor,scope.org_id,scope.account_id);
    const worker=finalStatus.then(async()=>{
      await db.transaction(async tx=>{await tx.update(jobQueue).set({error:'worker-advanced-after-status'}).where(eq(jobQueue.id,jobId));});
      release();
    });
    const observed=await Promise.race([Promise.all([request,worker]).then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),300))]);
    if(!observed)release();
    await Promise.all([request,worker]);
    assert.equal(observed,true,'status custody wait and worker queue lock must make progress without circular waiting');
  });
