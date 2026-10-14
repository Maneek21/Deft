import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {sql} from 'drizzle-orm';
import {emailAccounts,emailDrafts,emailProviderDraftMirrors,emailOutbox,emailOutboxEvents,jobQueue} from '@deft/db/schema';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {EmailOutboxCrypto} from '../src/lib/email-outbox-crypto.js';
import {EmailOutboxStore} from '../src/lib/email-outbox-store.js';
import {EmailOutboxService} from '../src/lib/email-outbox-service.js';
import {EmailDraftStore} from '../src/lib/email-draft-store.js';
import {createEmailNativeOutgoingSnapshotBuilder} from '../src/lib/email-native-outgoing-snapshot.js';
import {PostgresEmailSentCopyJournal} from '../src/lib/email-sent-copy-journal.js';
import {EmailSentCopyService,readEmailSentCopyStatus,reconcileEmailSentCopy} from '../src/lib/email-sent-copy-service.js';
import {createEmailSentCopyJobHandler} from '../src/lib/email-sent-copy-job.js';
import {RegisteredEmailSentCopyProvider} from '../src/lib/email-sent-copy-provider.js';
import type {EmailSentCopyLease,EmailSentCopyPlan} from '../src/lib/email-sent-copy-contract.js';
import {canonicalCapabilityJson} from '@deft/shared';
import {createHash} from 'node:crypto';
const target='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_fresh_65';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
test('actual PG Outbox immutable serializer custody, cancel/claim races, lost response and restart',{skip:!safe,timeout:45000},async t=>{
 const namespace='email_outbox_'+randomUUID().replaceAll('-','');assert.match(namespace,/^email_outbox_[a-f0-9]{32}$/u);
 const admin=new pg.Pool({connectionString:target});await admin.query(`CREATE SCHEMA "${namespace}"`);
 const pool=new pg.Pool({connectionString:target,options:`-c search_path=${namespace},public`,max:8});t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${namespace}" CASCADE`);await admin.end();});
 await pool.query('CREATE TABLE email_accounts(org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,authority_revision integer NOT NULL DEFAULT 7,provider_draft_sync_enabled boolean NOT NULL DEFAULT false,state text NOT NULL DEFAULT \'active\',PRIMARY KEY(org_id,owner_user_id,account_id))');
 await pool.query('CREATE TABLE job_queue (LIKE public.job_queue INCLUDING ALL)');
 const migration=(name:string)=>readFileSync(new URL('../../../packages/db/upgrades/'+name,import.meta.url),'utf8');
 await pool.query(migration('0.3.0-preview.66-email-native-drafts.sql'));await pool.query(migration('0.3.0-preview.70-email-provider-draft-mirrors.sql'));
 const ddl=migration('0.3.0-preview.72-email-outbox.sql');await pool.query(ddl);await pool.query(ddl);
 const hardened=migration('0.3.0-preview.73-email-outbox-attempt-markers.sql');await pool.query(hardened);await pool.query(hardened);
 await pool.query(migration('0.3.0-preview.67-email-native-operations.sql'));const copyDDL=migration('0.3.0-preview.79-email-smtp-sent-copy.sql');await pool.query(copyDDL);await pool.query(copyDDL);
 const database=drizzle(pool,{schema:{emailAccounts,emailDrafts,emailProviderDraftMirrors,emailOutbox,emailOutboxEvents,jobQueue}}),scope={org_id:'outbox-org',owner_user_id:'outbox-owner',account_id:'outbox-account'};
 await pool.query('INSERT INTO email_accounts(org_id,owner_user_id,account_id) VALUES($1,$2,$3)',[scope.org_id,scope.owner_user_id,scope.account_id]);
 const keys={current:()=>({key_id:'outbox-key',key:Buffer.alloc(32,31)}),read:(_p:unknown,id:string)=>id==='outbox-key'?{key_id:id,key:Buffer.alloc(32,31)}:null,keyIds:()=>['outbox-key']};
 const metadata=new EmailMailboxCrypto(keys),binary=new EmailOutboxCrypto(keys);let clock=Date.parse('2026-10-04T10:00:00Z'),revoked=false,denyCommittedEnqueue=false;
 const now=()=>new Date(clock),store=()=>new EmailOutboxStore(database,metadata,binary,now),drafts=new EmailDraftStore(database,metadata,now);
 const actor={user_id:scope.owner_user_id,web_session_id:'real-fixture-session',access_expires_at:clock+86400000},cap={scope,resource_binding_id:'outbox-binding',authority_version:'outbox-cap',expires_at:clock+86400000};
 const guard=async(tx?:unknown)=>{if(revoked)throw Error('REVOKED');if(tx){const rows=await (tx as typeof database).execute(sql`SELECT state FROM email_accounts WHERE org_id=${scope.org_id} AND owner_user_id=${scope.owner_user_id} AND account_id=${scope.account_id} FOR SHARE`);assert.equal(rows.rows[0]?.state,'active');if(denyCommittedEnqueue){const rows=await(tx as typeof database).execute(sql`SELECT 1 FROM email_outbox WHERE state='queued'`);if(rows.rows.length)throw Error('FINAL_FENCE');}}};
 const human={current:async(_actor:unknown,_scope:unknown,_op:unknown,tx?:unknown)=>{await guard(tx);return cap;}};
 const serviceAuthority={current:async(_scope:unknown,lease:any,tx?:unknown)=>{await guard(tx);const result=await (tx?tx as typeof database:database).execute(sql`SELECT * FROM job_queue WHERE id=${lease.job_id} AND org_id=${scope.org_id}${tx?sql` FOR SHARE`:sql``}`);const row=result.rows[0];if(!row||row.status!=='running'||row.lock_token!==lease.lock_token||row.name!=='native-email-outbox'||new Date(String(row.lock_expires_at)).getTime()<=clock)throw Error('LEASE_DENIED');const payload=row.data as any;assert.equal(payload.outbox_id,lease.outbox_id);assert.equal(payload.operation_id,lease.operation_id);assert.equal(payload.authority_revision,7);return cap;}};
 let connectionRevision=2,providerKind:'gmail'|'imap_smtp'='gmail',effects=0,lose=false,holdEffect:Promise<void>|null=null,enteredEffect:(()=>void)|null=null,implementationDigest:string|undefined;
 const sendIdentity=()=>({account_id:scope.account_id,provider:providerKind,resource_binding_id:'outbox-binding',authority_epoch:19,connection_revision:connectionRevision,principal_digest:'a'.repeat(64),health:'connected' as const,capabilities:['read','send'],primary_address:'sender@example.test',display_label:'Synthetic mailbox',org_id:scope.org_id,owner_user_id:scope.owner_user_id,installation_id:'outbox-install',connection_target:'outbox-target',action_binding_id:'outbox-action',verified_sender_identities:['sender@example.test','verified-alias@example.test'],...(implementationDigest?{implementation_digest:implementationDigest}:{})});
 const delivered:Array<{mime:Buffer;envelope:unknown}>=[],providerByteRefs:Uint8Array[]=[];
 const provider={getSendIdentity:async()=>sendIdentity(),send:async(input:any,host:any)=>{
  assert.equal(await host.send_before_reserve({operation_id:input.operation_id,account_id:scope.account_id,authority_epoch:19,mime_digest:input.mime_digest}),true);
  const committed=await pool.query('SELECT state,attempt_id FROM email_outbox WHERE operation_id=$1',[input.operation_id]);assert.equal(committed.rows[0].state,'submitting');assert.ok(committed.rows[0].attempt_id);
  effects++;providerByteRefs.push(input.mime_bytes);delivered.push({mime:Buffer.from(input.mime_bytes),envelope:input.envelope});enteredEffect?.();if(holdEffect)await holdEffect;if(lose)throw Error('LOST_ACCEPTANCE');
  return {schema_version:'deft.email_send_result.v1',account_id:scope.account_id,provider:providerKind,operation_id:input.operation_id,provider_message_id:providerKind==='gmail'?'private-accepted-id':null,transport_outcome:'provider_accepted',sent_copy_outcome:'pending',delivery_status:'unknown'};
 }};
 const {createOutgoingSnapshotService}=await import(new URL('../../../examples/apps/email/outgoing-snapshot.mjs',import.meta.url).href);
 const snapshots=createEmailNativeOutgoingSnapshotBuilder({accounts:provider,attachments:{readForSend:async()=>{throw Error('NO_FILES');}},replies:async()=>{throw Error('NO_REPLY');},createOutgoingSnapshotService:(ports:any)=>createOutgoingSnapshotService({...ports,profile:'native'}),now});
 const make=()=>new EmailOutboxService(human,serviceAuthority,drafts,store(),snapshots,provider,()=>clock);
 const content={mode:'compose',to:'Visible <visible@example.test>',cc:'',bcc:'hidden@example.test',subject:'Exact queued subject',body:'Immutable body',body_html:'',reply_record_id:'',attachments:[]};
 const createDraft=async(from_address?:string)=>{const id=randomUUID();await drafts.create(scope,id,{...content,...(from_address?{from_identity:{address:from_address}}:{})},{kind:'human',created_by_user_id:scope.owner_user_id,originating_run_id:null},async tx=>guard(tx));return id;};
 const enqueue=async(delay=0)=>make().enqueue(actor,scope,{draft_id:await createDraft(),expected_revision:1,request_id:randomUUID(),undo_delay_seconds:delay});
 const running=async(outbox:any,token=randomUUID())=>{const rows=await pool.query('SELECT job_id FROM email_outbox WHERE outbox_id=$1',[outbox.outbox_id]);const jobId=rows.rows[0].job_id;await pool.query("UPDATE job_queue SET status='running',attempts=attempts+1,locked_by='synthetic-worker',lock_token=$2,lock_expires_at=$3 WHERE id=$1",[jobId,token,new Date(clock+120000)]);return {job_id:jobId,lock_token:token,job_name:'native-email-outbox' as const,outbox_id:outbox.outbox_id,operation_id:outbox.operation_id};};
 await t.test('encrypted atomic queue commit, exact replay, reschedule and cancellation restore draft',async()=>{
  const draftId=await createDraft(),request={draft_id:draftId,expected_revision:1,request_id:randomUUID(),undo_delay_seconds:30},first=await make().enqueue(actor,scope,request);assert.equal(first.state,'queued');assert.equal(effects,0);
  const raw=(await pool.query('SELECT * FROM email_outbox WHERE outbox_id=$1',[first.outbox_id])).rows[0];assert.equal(JSON.stringify(raw).includes('hidden@example.test'),false);assert.equal(raw.ciphertext.includes(Buffer.from('Immutable body')),false);assert.equal(raw.earliest_dispatch_at.toISOString(),'2026-10-04T10:00:30.000Z');
  for(const state of ['accepted','submitting','uncertain','unsupported'])for(const markers of [[null,null],[randomUUID(),null],[null,'a'.repeat(64)]]){
   const invalid={...raw,outbox_id:randomUUID(),request_id:randomUUID(),operation_id:randomUUID(),draft_revision:99,state,attempt_id:markers[0],attempt_lock_hash:markers[1],started_at:new Date(clock)};
   const columns=Object.keys(invalid);await assert.rejects(pool.query(`INSERT INTO email_outbox(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(invalid)),/email_outbox_state_check/);
  }
  assert.equal((await make().enqueue(actor,scope,request)).outbox_id,first.outbox_id);await assert.rejects(make().enqueue(actor,scope,{...request,undo_delay_seconds:20}),/CONFLICT/);
  assert.equal((await make().readRequest(actor,scope,request.request_id))?.outbox_id,first.outbox_id);assert.equal(await make().readRequest(actor,scope,randomUUID()),null);assert.equal(effects,0);
  assert.equal((await make().readDraft(actor,scope,draftId,1))?.outbox_id,first.outbox_id);assert.equal(await make().readDraft(actor,scope,draftId,2),null);
  assert.equal((await drafts.read(scope,draftId,async tx=>guard(tx)))?.status,'submitted');
  const later=await make().reschedule(actor,scope,{outbox_id:first.outbox_id,expected_revision:1,schedule:{wall_time:'2026-10-04T16:00',zone:'Asia/Kolkata',ambiguity:'reject',missed_policy:'send_when_available'}});assert.equal(later.earliest_dispatch_at,'2026-10-04T10:30:00.000Z');
  const unchanged=(await pool.query('SELECT ciphertext,snapshot_envelope FROM email_outbox WHERE outbox_id=$1',[first.outbox_id])).rows[0];assert.deepEqual(unchanged.ciphertext,raw.ciphertext);assert.deepEqual(unchanged.snapshot_envelope,raw.snapshot_envelope);
  const cancelled=await make().cancel(actor,scope,{outbox_id:first.outbox_id,expected_revision:2});assert.equal(cancelled.state,'cancelled');assert.equal((await drafts.read(scope,draftId,async tx=>guard(tx)))?.revision,3);assert.equal((await drafts.read(scope,draftId,async tx=>guard(tx)))?.status,'draft');
  await assert.rejects(pool.query('UPDATE email_outbox SET mime_digest=$2,revision=revision+1 WHERE outbox_id=$1',[first.outbox_id,'b'.repeat(64)]),/immutable/);await assert.rejects(pool.query('DELETE FROM email_outbox_events WHERE outbox_id=$1',[first.outbox_id]),/append only/);
  await assert.rejects(make().read(actor,{...scope,owner_user_id:'foreign'},first.outbox_id),/ACCESS_DENIED/);
 });
 await t.test('final authority failure rolls back MIME, draft pin and job together',async()=>{
  // Isolate assertion from older queued rows by making the fence inspect the
  // exact newly inserted request, not preexisting unrelated intent history.
  const draftId=await createDraft(),requestId=randomUUID(),priorCount=Number((await pool.query('SELECT count(*) FROM job_queue')).rows[0].count);
  const rejectingHuman={current:async(a:any,s:any,op:any,tx?:unknown)=>{await guard(tx);if(tx){const found=await(tx as typeof database).execute(sql`SELECT 1 FROM email_outbox WHERE request_id=${requestId}`);if(found.rows.length)throw Error('FINAL_FENCE');}return cap;}};
  const rejected=new EmailOutboxService(rejectingHuman,serviceAuthority,drafts,store(),snapshots,provider,()=>clock);
  await assert.rejects(rejected.enqueue(actor,scope,{draft_id:draftId,expected_revision:1,request_id:requestId,undo_delay_seconds:0}),/FINAL_FENCE/);
  assert.equal((await pool.query('SELECT count(*) FROM email_outbox WHERE request_id=$1',[requestId])).rows[0].count,'0');assert.equal(Number((await pool.query('SELECT count(*) FROM job_queue')).rows[0].count),priorCount);assert.equal((await drafts.read(scope,draftId,async tx=>guard(tx)))?.status,'draft');
 });
 await t.test('lost provider acceptance stays uncertain across new worker/service and never sends again',async()=>{
  const item=await enqueue(),lease=await running(item);lose=true;const before=effects;assert.equal((await make().dispatch(scope,lease)).state,'uncertain');lose=false;assert.equal(effects,before+1);
  assert.equal((await make().dispatch(scope,await running(item))).state,'uncertain');assert.equal(effects,before+1);await assert.rejects(make().cancel(actor,scope,{outbox_id:item.outbox_id,expected_revision:3}),/CONFLICT/);
  const events=await pool.query('SELECT revision,envelope FROM email_outbox_events WHERE outbox_id=$1 ORDER BY revision',[item.outbox_id]);assert.equal(events.rows.length,3);assert.equal(JSON.stringify(events.rows).includes('Immutable body'),false);
 });
 await t.test('committed started marker fences restart, stale lease and cancel boundary before acceptance',async()=>{
  const item=await enqueue(),lease=await running(item);let release!:()=>void,entered!:()=>void;holdEffect=new Promise<void>(resolve=>release=resolve);const ready=new Promise<void>(resolve=>entered=resolve);enteredEffect=entered;
  const sending=make().dispatch(scope,lease);await ready;const nowPublic=await make().read(actor,scope,item.outbox_id);assert.equal(nowPublic?.state,'submitting');await assert.rejects(make().cancel(actor,scope,{outbox_id:item.outbox_id,expected_revision:2}),/CONFLICT/);
  const replacement=await running(item);assert.equal((await make().dispatch(scope,replacement)).state,'uncertain');const count=effects;release();await assert.rejects(sending,/RECONCILIATION_REQUIRED/);holdEffect=null;enteredEffect=null;assert.equal(effects,count);assert.equal((await make().read(actor,scope,item.outbox_id))?.state,'uncertain');
 });
 await t.test('cancel and dispatch race has one durable winner with no duplicate effect',async()=>{
  const item=await enqueue(),lease=await running(item),before=effects;const result=await Promise.allSettled([make().dispatch(scope,lease),make().cancel(actor,scope,{outbox_id:item.outbox_id,expected_revision:1})]);
  const current=await make().read(actor,scope,item.outbox_id);assert.ok(['cancelled','accepted'].includes(current!.state));assert.equal(effects-before,current!.state==='accepted'?1:0);assert.ok(result.some(r=>r.status==='fulfilled'));
 });
 await t.test('actual queue stale cleanup query permits one read-only started recovery delivery',async()=>{
  const item=await enqueue(),lease=await running(item),before=effects;const claimed=await store().claim(scope,item.outbox_id,lease,async tx=>{await serviceAuthority.current(scope,lease,tx);});assert.equal(claimed.kind,'dispatch');if(claimed.kind==='dispatch')claimed.bytes.fill(0);
  await pool.query('UPDATE job_queue SET lock_expires_at=$2 WHERE id=$1',[lease.job_id,new Date(0)]);
  // Execute the actual cleanupStaleJobs UPDATE against this isolated namespace;
  // importing queues.ts would connect the production singleton instead.
  const queueSource=readFileSync(new URL('../src/lib/queues.ts',import.meta.url),'utf8');const cleanup=queueSource.slice(queueSource.indexOf('export async function cleanupStaleJobs()'));const query=cleanup.match(/sql`([\s\S]*?)`/u)![1]!;assert.equal(query.includes('${'),false);
  const recovered=await pool.query(query);const row=recovered.rows.find(value=>value.data.outbox_id===item.outbox_id);assert.equal(row.status,'pending');assert.equal((await pool.query('SELECT max_attempts FROM job_queue WHERE id=$1',[lease.job_id])).rows[0].max_attempts,2);
  assert.equal((await make().dispatch(scope,await running(item))).state,'uncertain');assert.equal(effects,before);assert.equal((await make().read(actor,scope,item.outbox_id))?.state,'uncertain');
 });
 await t.test('fresh sender/custody change pauses without provider effect and revoked authority exposes no cache',async()=>{
  const item=await enqueue(),lease=await running(item),before=effects;connectionRevision++;assert.equal((await make().dispatch(scope,lease)).state,'paused');assert.equal(effects,before);connectionRevision--;
  revoked=true;await assert.rejects(make().read(actor,scope,item.outbox_id),/REVOKED/);await assert.rejects(make().dispatch(scope,lease),/REVOKED/);revoked=false;
 });
 await t.test('persisted queued Outbox pauses before any provider effect after reviewed implementation change',async()=>{
  for(const old of [undefined,'b'.repeat(64)]){implementationDigest=old;const item=await enqueue(),before=effects,lease=await running(item);const stored=await store().read(scope,item.outbox_id,async tx=>guard(tx));assert.equal(stored!.snapshot.identity.implementation_digest,old);implementationDigest='c'.repeat(64);assert.equal((await make().dispatch(scope,lease)).state,'paused');assert.equal(effects,before);const row=(await pool.query('SELECT state,started_at FROM email_outbox WHERE outbox_id=$1',[item.outbox_id])).rows[0];assert.equal(row.state,'paused');assert.equal(row.started_at,null);}implementationDigest=undefined;
 });
 await t.test('saved deadline and missed policy survive restart; SMTP exact envelope retains Bcc outside MIME',async()=>{
  const wait=await enqueue(60),lease=await running(wait);assert.deepEqual(await make().dispatch(scope,lease),{state:'waiting',delay_ms:60000});await make().cancel(actor,scope,{outbox_id:wait.outbox_id,expected_revision:1});
  const scheduled=await make().enqueue(actor,scope,{draft_id:await createDraft(),expected_revision:1,request_id:randomUUID(),undo_delay_seconds:0,schedule:{wall_time:'2026-10-04T10:01',zone:'UTC',ambiguity:'reject',missed_policy:'pause_if_late'}});clock+=7*60000;assert.equal((await make().dispatch(scope,await running(scheduled))).state,'paused');
  providerKind='imap_smtp';const smtp=await enqueue();assert.equal((await make().dispatch(scope,await running(smtp))).state,'accepted');providerKind='gmail';const sent=delivered.at(-1)!;assert.deepEqual(sent.envelope,{from:'sender@example.test',to:['visible@example.test','hidden@example.test']});assert.doesNotMatch(sent.mime.toString(),/^Bcc:/mu);assert.match(sent.mime.toString(),/Immutable body/);
  assert.equal((await make().read(actor,scope,smtp.outbox_id))?.delivery_status,'unknown');assert.equal('provider_message_id' in (await make().read(actor,scope,smtp.outbox_id))!,false);
 });
 await t.test('bounded list cursor preserves tied ordering and is scoped to exact account; event cap reserves cancellation',async()=>{
  const expected=(await pool.query('SELECT outbox_id FROM email_outbox ORDER BY created_at DESC,outbox_id DESC')).rows.map(row=>row.outbox_id),seen:string[]=[];let cursor:string|null=null,pages=0;
  do{const page=await make().list(actor,scope,{limit:2,cursor});seen.push(...page.items.map(row=>row.outbox_id));cursor=page.next_cursor;pages++;if(cursor)await assert.rejects(store().list({...scope,account_id:'foreign-account'},2,cursor,async()=>{}),/CURSOR_INVALID/);}while(cursor);
  assert.deepEqual(seen,expected);assert.ok(pages>=3);
  const bounded=await enqueue(),schedule={wall_time:'2026-10-04T12:00',zone:'UTC',ambiguity:'reject',missed_policy:'send_when_available'};let value=bounded;
  for(let i=1;i<120;i++)value=await make().reschedule(actor,scope,{outbox_id:value.outbox_id,expected_revision:value.revision,schedule});assert.equal(value.revision,120);
  await assert.rejects(make().reschedule(actor,scope,{outbox_id:value.outbox_id,expected_revision:120,schedule}),/CONFLICT/);
  assert.equal((await make().cancel(actor,scope,{outbox_id:value.outbox_id,expected_revision:120})).state,'cancelled');assert.equal((await pool.query('SELECT count(*) FROM email_outbox_events WHERE outbox_id=$1',[value.outbox_id])).rows[0].count,'121');
 });
 await t.test('verified alias is immutable From through enqueue and dispatch; unverified From never queues',async()=>{
  const item=await make().enqueue(actor,scope,{draft_id:await createDraft('verified-alias@example.test'),expected_revision:1,request_id:randomUUID(),undo_delay_seconds:0});assert.equal(item.from_address,'verified-alias@example.test');assert.equal((await make().dispatch(scope,await running(item))).state,'accepted');assert.match(delivered.at(-1)!.mime.toString(),/^From: verified-alias@example.test$/mu);
  const count=(await pool.query('SELECT count(*) FROM email_outbox')).rows[0].count,before=effects;
  await assert.rejects(make().enqueue(actor,scope,{draft_id:await createDraft('unverified@example.test'),expected_revision:1,request_id:randomUUID(),undo_delay_seconds:0}),/SENDER|FROM/);assert.equal((await pool.query('SELECT count(*) FROM email_outbox')).rows[0].count,count);assert.equal(effects,before);
 });
 await t.test('accepted SMTP queues a distinct exact leased copy, survives APPEND loss/restart and cannot resend',async()=>{
  providerKind='imap_smtp';const item=await enqueue(),sendLease=await running(item);await make().dispatch(scope,sendLease);providerKind='gmail';const sends=effects;
  const jobs=(await pool.query("SELECT * FROM job_queue WHERE name='native-email-sent-copy' AND data->>'outbox_id'=$1",[item.outbox_id])).rows;assert.equal(jobs.length,1);assert.equal(jobs[0].max_attempts,2);
  const copyLease:EmailSentCopyLease={job_id:jobs[0].id,lock_token:randomUUID(),job_name:'native-email-sent-copy',outbox_id:item.outbox_id,operation_id:item.operation_id};
  await pool.query("UPDATE job_queue SET status='running',attempts=1,lock_token=$2,lock_expires_at=$3 WHERE id=$1",[copyLease.job_id,copyLease.lock_token,new Date(clock+120000)]);
  const copyAuthority={current:async(s:any,l:EmailSentCopyLease,tx?:unknown)=>{assert.deepEqual(s,scope);await guard(tx);const row=(await(tx?tx as typeof database:database).execute(sql`SELECT * FROM job_queue WHERE id=${l.job_id}`)).rows[0] as any;if(!row||row.status!=='running'||row.name!==l.job_name||row.lock_token!==l.lock_token||new Date(row.lock_expires_at).getTime()<=clock)throw Error('COPY_LEASE_DENIED');return cap;}};
  const current=async(tx?:unknown)=>{await copyAuthority.current(scope,copyLease,tx);};const sqlJournal=()=>new PostgresEmailSentCopyJournal(database as never,metadata,scope,current,()=>clock);
  const {sentCopyFixture}=await import(new URL('../../../examples/apps/email/providers/native-imap-sent-copy-fixture.mjs',import.meta.url).href),f=sentCopyFixture();t.after(()=>f.dispose());
  Object.assign(f.descriptor,sendIdentity(),{provider:'imap_smtp',capabilities:['read','modify','send']});const source=await store().readAcceptedCopy(scope,copyLease,current);Object.assign(f.input,{operation_id:item.operation_id,mime_digest:source.snapshot.mime_digest,mime_bytes:source.bytes});f.lose=true;
  const {createAppConnectionAdapter}=await import(new URL('../../../examples/apps/email/providers/native-imap-connection.mjs',import.meta.url).href);
  const create=async()=>{const adapter=await createAppConnectionAdapter({host:{nativeEmailImapHost:async()=>f.host}});const journal=sqlJournal(),mirror={load:async(s:any,id:string)=>{const value=await journal.load(s,id);if(value)f.ledger.set(id,value);return value;},create:async(plan:EmailSentCopyPlan)=>{const value=await journal.create(plan);f.ledger.set(plan.operation_id,value);return value;},change:async(s:any,id:string,work:any)=>journal.change(s,id,async(value,write)=>work(value,async(next:any)=>{await write(next);f.ledger.set(id,next);} ))};
   return new EmailSentCopyService(copyAuthority,store(),new RegisteredEmailSentCopyProvider(async(s,c,recheck,signal,purpose)=>{assert.equal(purpose,'sent_copy');return {adapter,context:{...s,installation_id:'outbox-install',resource_binding_id:c.resource_binding_id,authority_version:c.authority_version,expires_at:c.expires_at,recheck,signal,sent_copy_journal:mirror}};},()=>clock),()=>clock);};
  const handler=()=>createEmailSentCopyJobHandler({enabled:()=>true,defer:message=>Error(message),dispatch:async(s,l,signal)=>(await create()).dispatch(s,l,signal)});
  const deliver=async()=>handler()({id:copyLease.job_id,name:'native-email-sent-copy',lockToken:copyLease.lock_token,data:jobs[0].data,attempts:1});
  const read=()=>readEmailSentCopyStatus(human,store(),actor,scope,item.outbox_id);
  const reconcile=()=>reconcileEmailSentCopy(human,store(),actor,scope,item.outbox_id);
  await deliver();assert.equal(f.calls.append,1);assert.equal(effects,sends);assert.equal((await read()).outcome,'unknown');
  await assert.rejects(reconcile(),/CONFLICT/);await pool.query("UPDATE job_queue SET status='failed',lock_token=NULL,lock_expires_at=NULL WHERE id=$1",[copyLease.job_id]);
  assert.equal((await reconcile()).outcome,'pending');await assert.rejects(reconcile(),/CONFLICT/);
  Object.assign(copyLease,{lock_token:randomUUID()});await pool.query("UPDATE job_queue SET status='running',lock_token=$2,lock_expires_at=$3 WHERE id=$1",[copyLease.job_id,copyLease.lock_token,new Date(clock+120000)]);
  f.descriptor.authority_epoch=20;f.descriptor.connection_revision=3;f.mode='server_managed';
  await deliver();assert.equal(f.calls.append,1);assert.equal(effects,sends);assert.equal((await read()).outcome,'copied');
  await assert.rejects(readEmailSentCopyStatus(human,store(),actor,{...scope,account_id:'foreign-account'},item.outbox_id));revoked=true;await assert.rejects(read());await assert.rejects(deliver(),/REVOKED/);revoked=false;
  assert.equal((await make().read(actor,scope,item.outbox_id))?.state,'accepted');await assert.rejects(store().readAcceptedCopy({...scope,account_id:'foreign'},copyLease,current),/DENIED/);
  await assert.rejects(store().readAcceptedCopy(scope,{...copyLease,lock_token:randomUUID()},current),/DENIED/);await assert.rejects(sqlJournal().change(scope,item.operation_id,async(value,write)=>{assert.ok(value);const {copied_uid:ignored,...rest}=value;await write({...rest,state:'prepared'});}),/STATE_CONFLICT/);
  const raw=(await pool.query('SELECT * FROM email_operations WHERE operation_id=$1',[item.operation_id])).rows[0];assert.equal(raw.kind,'sent_copy');assert.equal(JSON.stringify(raw).includes('Localized Sent'),false);source.bytes.fill(0);
 });
 await t.test('Sent-copy exclusive/stale lease and final fence preserve a started immutable journal',async()=>{
  const unsigned={schema_version:'deft.email_sent_copy_plan.v1' as const,scope,operation_id:randomUUID(),binding_digest:'a'.repeat(64),principal_digest:'c'.repeat(64),mime_digest:'b'.repeat(64),byte_length:1,mode:'append' as const,message_id:'<journal@example.test>',mailbox:'Private Sent',uidvalidity:'7',uidnext:1};
  const plan={...unsigned,digest:createHash('sha256').update(canonicalCapabilityJson(unsigned)).digest('hex')},journal=()=>new PostgresEmailSentCopyJournal(database as never,metadata,scope,guard,()=>clock);await journal().create(plan);
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  const first=journal().change(scope,plan.operation_id,async(value,write)=>{assert.ok(value);await write({...value,state:'started'});entered();await held;await write({...value,state:'unknown'});});await ready;await assert.rejects(journal().change(scope,plan.operation_id,()=>null),/BUSY/);
  clock+=120001;await journal().change(scope,plan.operation_id,async(value,write)=>{assert.ok(value);assert.equal(value.state,'started');await write({...value,state:'unknown'});});release();await assert.rejects(first,/JOURNAL_CONFLICT/);assert.equal((await journal().load(scope,plan.operation_id))?.state,'unknown');
  await assert.rejects(journal().change(scope,plan.operation_id,async(value,write)=>{assert.ok(value);await write({...value,state:'prepared'});}),/STATE_CONFLICT/);
  let fences=0;const rejecting=new PostgresEmailSentCopyJournal(database as never,metadata,scope,async(tx)=>{await guard(tx);if(++fences===4)throw Error('FINAL_COPY_FENCE');},()=>clock);
  await assert.rejects(rejecting.change(scope,plan.operation_id,async(value,write)=>{assert.ok(value);await write({...value,state:'copied'});}),/FINAL_COPY_FENCE/);assert.equal((await journal().load(scope,plan.operation_id))?.state,'unknown');
 });
 assert.ok(providerByteRefs.every(bytes=>bytes.every(value=>value===0)),'provider-held prepared buffers are cleared after accepted, uncertain and stale-lease failures');
 for(const sent of delivered)sent.mime.fill(0);
});
