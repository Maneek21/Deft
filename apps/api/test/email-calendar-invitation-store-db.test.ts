import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {eq} from 'drizzle-orm';
import {events,emailAccounts,emailDrafts,emailOutbox,emailOutboxEvents,jobQueue,emailProviderDraftMirrors} from '@deft/db/schema';
import {emailCalendarInvitations,emailCalendarInvitationActions} from '../../../packages/db/src/email-calendar-invitation-schema.js';
import {EmailCalendarInvitationStore,emailInvitationModelContext} from '../src/lib/email-calendar-invitation-store.js';
import {EmailInvitationPreviewService} from '../src/lib/email-calendar-invitation-preview.js';
import {EmailCalendarInvitationService} from '../src/lib/email-calendar-invitation-service.js';
import {EmailCalendarReplyOutbox} from '../src/lib/email-calendar-reply-outbox.js';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {EmailOutboxCrypto} from '../src/lib/email-outbox-crypto.js';
import {EmailOutboxStore} from '../src/lib/email-outbox-store.js';
import {createEmailNativeOutgoingSnapshotBuilder} from '../src/lib/email-native-outgoing-snapshot.js';
import {NativeEmailCalendarPartsSchema} from '../src/lib/app-connection-contract.js';
import type {EmailCapability} from '../src/lib/email-mailbox-service.js';
import {createEmailCalendarInvitationRoutes} from '../src/routes/email-calendar-invitations.js';
import {readEmailCalendarOccurrences} from '../src/lib/email-calendar-projection.js';
import {Hono} from 'hono';
const target='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_notifications_87_fresh';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
test('actual PG Calendar invitation + existing Outbox atomic owner action, restart and version/edit/deletion fences',{skip:!safe,timeout:45000},async t=>{
 const namespace='email_calendar_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:target});await admin.query(`CREATE SCHEMA "${namespace}"`);
 const pool=new pg.Pool({connectionString:target,options:`-c search_path=${namespace},public`,max:8});t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${namespace}" CASCADE`);await admin.end();});
 await pool.query("CREATE TABLE email_accounts(org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,authority_revision integer NOT NULL DEFAULT 7,provider_draft_sync_enabled boolean NOT NULL DEFAULT false,state text NOT NULL DEFAULT 'active',PRIMARY KEY(org_id,owner_user_id,account_id))");
 await pool.query('CREATE TABLE events(LIKE public.events INCLUDING ALL)');await pool.query('CREATE TABLE job_queue(LIKE public.job_queue INCLUDING ALL)');
 for(const table of ['tasks','projects','notes','reminders','orgs'])await pool.query(`CREATE TABLE ${table}(LIKE public.${table} INCLUDING ALL)`);
 const migration=(name:string)=>readFileSync(new URL('../../../packages/db/upgrades/'+name,import.meta.url),'utf8');
 for(const name of ['66-email-native-drafts','70-email-provider-draft-mirrors','72-email-outbox','73-email-outbox-attempt-markers','88-email-calendar-invitations'])await pool.query(migration(`0.3.0-preview.${name}.sql`));
 const database=drizzle(pool,{schema:{events,emailAccounts,emailDrafts,emailOutbox,emailOutboxEvents,jobQueue,emailProviderDraftMirrors,emailCalendarInvitations,emailCalendarInvitationActions}});
 const scope={org_id:'org',owner_user_id:'owner',account_id:'account'},other={...scope,account_id:'other'};await pool.query("INSERT INTO email_accounts(org_id,owner_user_id,account_id) VALUES('org','owner','account'),('org','owner','other')");
 const keys={current:()=>({key_id:'calendar-fixture',key:Buffer.alloc(32,24)}),read:(_purpose:unknown,id:string)=>id==='calendar-fixture'?{key_id:id,key:Buffer.alloc(32,24)}:null,keyIds:()=>['calendar-fixture']};
 const cipher=new EmailMailboxCrypto(keys),binary=new EmailOutboxCrypto(keys);let clock=Date.parse('2026-10-04T12:00:00Z'),allowed=true,denyFinalRequest:string|null=null,sequence=1,stamp='20261004T120000Z',summary='Reviewed synthetic invitation',method='REQUEST',digest='b'.repeat(64),sourceChanged=false;
 const logical='mail_'+'c'.repeat(64),actor={user_id:'owner',web_session_id:'real-fixture-sid',access_expires_at:clock+86400000},operations:string[]=[];
 const authority={async current(_actor:unknown,s:typeof scope,operation:string,tx?:unknown):Promise<EmailCapability>{operations.push(operation);if(!allowed||s.owner_user_id!=='owner'||s.org_id!=='org')throw Error('REVOKED');
  if(tx&&denyFinalRequest){const rows=await(tx as typeof database).select().from(emailCalendarInvitationActions).where(eq(emailCalendarInvitationActions.request_id,denyFinalRequest)).limit(1);if(rows.length)throw Error('FINAL_FENCE');}return {scope:s,resource_binding_id:'binding-'+s.account_id,authority_version:'authority',expires_at:actor.access_expires_at};}};
 let recurrenceId='';
 const body=()=>`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:${method}\r\nBEGIN:VEVENT\r\nUID:shared-uid\r\nDTSTAMP:${stamp}\r\nSEQUENCE:${sequence}\r\nDTSTART:20261005T120000Z\r\nDTEND:20261005T130000Z\r\nSUMMARY:${summary}\r\nORGANIZER:mailto:organizer@example.test\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:owner@example.test\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:other@example.test\r\n${recurrenceId?'RECURRENCE-ID:'+recurrenceId:'RRULE:FREQ=WEEKLY;COUNT=4\r\nEXDATE:20261012T120000Z'}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
 const content={async readCalendarParts(_actor:unknown,s:typeof scope){return NativeEmailCalendarPartsSchema.parse({schema_version:'deft.email_calendar_parts.v1',account_id:s.account_id,logical_message_id:logical,provider:'gmail',source_digest:sourceChanged?'a'.repeat(64):digest,
  receiving_identity:{primary_address:'owner@example.test',display_label:'Owner'},status:'available',parts:[{part_ref:'f'.repeat(64),ics_text:body(),media_type_method:method}]});}};
 const account=(s:typeof scope)=>({schema_version:undefined,org_id:s.org_id,owner_user_id:s.owner_user_id,account_id:s.account_id,provider:'gmail' as const,resource_binding_id:'binding-'+s.account_id,authority_epoch:19,connection_revision:1,principal_digest:'a'.repeat(64),health:'connected' as const,
  capabilities:['read','send'],primary_address:'owner@example.test',display_label:'Owner',installation_id:'installation',connection_target:'target',action_binding_id:'action',verified_sender_identities:['owner@example.test']});
 const accounts={async getSendIdentity(s:typeof scope){const {schema_version:_unused,...value}=account(s);return value;}};
 const {createOutgoingSnapshotService}=await import(new URL('../../../examples/apps/email/outgoing-snapshot.mjs',import.meta.url).href);
 const snapshots=createEmailNativeOutgoingSnapshotBuilder({accounts,attachments:{readForSend:async()=>{throw Error('NO_FILES');}},replies:async()=>{throw Error('NO_REPLY');},createOutgoingSnapshotService:(ports:any)=>createOutgoingSnapshotService({...ports,profile:'native'}),now:()=>new Date(clock)});
 const outbox=new EmailOutboxStore(database,cipher,binary,()=>new Date(clock)),store=()=>new EmailCalendarInvitationStore(database,cipher,()=>new Date(clock));
 const make=()=>new EmailCalendarInvitationService(authority,new EmailInvitationPreviewService(authority,content,cipher,()=>clock),store(),new EmailCalendarReplyOutbox(snapshots,accounts,outbox,cipher,()=>new Date(clock)),()=>clock);
 const routes=createEmailCalendarInvitationRoutes({verify:async(token:string)=>{if(token!=='fixture')throw Error('invalid');return {id:actor.user_id,org_id:scope.org_id,sid:actor.web_session_id,exp:actor.access_expires_at/1000};},service:async()=>make(),now:()=>clock});
 const input=async(s=scope,response:'accepted'|'tentative'|'declined'='accepted',send=false)=>({request_id:randomUUID(),preview_token:(await make().preview(actor,s,logical)).invitations[0]!.preview_token!,destination_id:'deft_personal' as const,recreate_deleted:false,action:{kind:'rsvp' as const,response,send_response:send}});
 let firstEvent='',firstRequest='';
 await t.test('read-only preview has no rows or provider effect; local Calendar import uses human_read only',async()=>{
  const preview=await make().preview(actor,scope,logical);assert.equal(preview.invitations[0]!.summary,summary);assert.equal((await pool.query('SELECT count(*) FROM events')).rows[0].count,'0');assert.ok(operations.every(value=>value==='human_read'));
  const request=await input();firstRequest=request.request_id;const receipt=await make().apply(actor,scope,request);assert.equal(receipt.calendar.state,'applied');firstEvent=receipt.calendar.event_id!;assert.equal(receipt.response.state,'not_requested');assert.equal((await pool.query('SELECT count(*) FROM email_outbox')).rows[0].count,'0');
  const event=(await pool.query('SELECT * FROM events WHERE id=$1',[firstEvent])).rows[0];assert.equal(event.org_id,'org');assert.equal(event.user_id,'owner');assert.equal(event.metadata.email_invitation.rrule,'FREQ=WEEKLY;COUNT=4');assert.equal(event.metadata.email_invitation.exdates.length,1);
  assert.deepEqual(event.metadata.attendees.map((row:any)=>[row.email,row.responseStatus]),[['owner@example.test','accepted'],['other@example.test','accepted']]);
  const raw=(await pool.query('SELECT * FROM email_calendar_invitations')).rows[0];assert.equal(JSON.stringify(raw).includes(summary),false);assert.equal((await make().apply(actor,scope,request)).calendar.event_id,firstEvent);assert.equal((await pool.query('SELECT count(*) FROM events')).rows[0].count,'1');
 });
 await t.test('legacy model without receiver remains readable; fresh declined/tentative actions repair only verified owner participation',async()=>{
  const row=(await database.select().from(emailCalendarInvitations))[0]!,context=emailInvitationModelContext(scope,row.invitation_id,row.revision),model=cipher.open(row.model_envelope,context) as any;
  assert.equal(model.receiving_attendee_address,'owner@example.test');delete model.receiving_attendee_address;
  await pool.query('UPDATE email_calendar_invitations SET model_envelope=$1 WHERE invitation_id=$2',[cipher.seal(model,context),row.invitation_id]);
  for(const choice of ['declined','tentative','accepted'] as const){await make().apply(actor,scope,await input(scope,choice));const event=(await pool.query('SELECT metadata FROM events WHERE id=$1',[firstEvent])).rows[0];
   assert.deepEqual(event.metadata.attendees.map((a:any)=>a.responseStatus),[choice,'accepted']);assert.equal(event.metadata.status,choice==='declined'?'canceled':choice==='tentative'?'tentative':'confirmed');}
  const current=(await database.select().from(emailCalendarInvitations))[0]!,ctx=emailInvitationModelContext(scope,current.invitation_id,current.revision),upgraded=cipher.open(current.model_envelope,ctx) as any;assert.equal(upgraded.receiving_attendee_address,'owner@example.test');
  const before=(await pool.query('SELECT metadata FROM events WHERE id=$1',[firstEvent])).rows[0].metadata;upgraded.receiving_attendee_address='attacker@example.test';
  await pool.query('UPDATE email_calendar_invitations SET model_envelope=$1 WHERE invitation_id=$2',[cipher.seal(upgraded,ctx),current.invitation_id]);await assert.rejects(make().apply(actor,scope,await input()),/UNAVAILABLE/);
  assert.deepEqual((await pool.query('SELECT metadata FROM events WHERE id=$1',[firstEvent])).rows[0].metadata,before);
  upgraded.receiving_attendee_address='owner@example.test';await pool.query('UPDATE email_calendar_invitations SET model_envelope=$1 WHERE invitation_id=$2',[cipher.seal(upgraded,ctx),current.invitation_id]);
 });
 await t.test('restart receipt lookup is scoped and same request cannot switch response',async()=>{
  assert.equal((await make().readRequest(actor,scope,firstRequest))?.calendar.event_id,firstEvent);assert.equal(await make().readRequest(actor,other,firstRequest),null);
  const request=await input();request.request_id=firstRequest as ReturnType<typeof randomUUID>;request.action.response='declined';await assert.rejects(make().apply(actor,scope,request),/REQUEST_CONFLICT/);
 });
 await t.test('actual HTTP factory binds owner/SID scope, returns no-store preview/receipt, rejects browser ICS/recipients and never imports automatically',async()=>{
  const headers={Authorization:'Bearer fixture','Content-Type':'application/json'},url=`http://fixture/accounts/${scope.account_id}/messages/${logical}/invitations`;
  const before=Number((await pool.query('SELECT count(*) FROM events')).rows[0].count),preview=await routes.request(url,{headers});assert.equal(preview.status,200);assert.equal(preview.headers.get('cache-control'),'no-store');
  assert.equal(Number((await pool.query('SELECT count(*) FROM events')).rows[0].count),before);assert.equal((await routes.request(url)).status,401);
  const request=await input(),injected=await routes.request(`http://fixture/accounts/${scope.account_id}/invitations/apply`,{method:'POST',headers,body:JSON.stringify({...request,ics_text:body(),to:'attacker@example.test'})});assert.equal(injected.status,400);
  assert.equal(Number((await pool.query('SELECT count(*) FROM events')).rows[0].count),before);
  const receipt=await routes.request(`http://fixture/accounts/${scope.account_id}/invitations/requests/${firstRequest}`,{headers});assert.equal(receipt.status,200);assert.equal((await receipt.json()).receipt.calendar.event_id,firstEvent);
  const otherReceipt=await routes.request(`http://fixture/accounts/${other.account_id}/invitations/requests/${firstRequest}`,{headers});assert.deepEqual(await otherReceipt.json(),{receipt:null});
 });
 await t.test('monotonic version and same-version content conflict preserve event',async()=>{
  summary='Same version external edit';await assert.rejects(make().apply(actor,scope,await input()),/VERSION_CONFLICT/);summary='Reviewed synthetic invitation';sequence=0;stamp='20261005T120000Z';await assert.rejects(make().apply(actor,scope,await input()),/STALE/);
  sequence=2;stamp='20261003T120000Z';summary='Newer sequence';const receipt=await make().apply(actor,scope,await input());assert.equal(receipt.calendar.event_id,firstEvent);assert.equal((await pool.query('SELECT title FROM events WHERE id=$1',[firstEvent])).rows[0].title,'Newer sequence');
 });
 await t.test('same UID another account stays distinct; user Calendar edit and deletion are preserved',async()=>{
  const receipt=await make().apply(actor,other,await input(other));assert.notEqual(receipt.calendar.event_id,firstEvent);
  await pool.query("UPDATE events SET title='User edited',updated_at=now() WHERE id=$1",[firstEvent]);sequence=3;await assert.rejects(make().apply(actor,scope,await input()),/CALENDAR_EDITED/);assert.equal((await pool.query('SELECT title FROM events WHERE id=$1',[firstEvent])).rows[0].title,'User edited');
  await pool.query('DELETE FROM events WHERE id=$1',[firstEvent]);await assert.rejects(make().apply(actor,scope,await input()),/CALENDAR_DELETED/);
  const recreate=await input();recreate.recreate_deleted=true;const replacement=await make().apply(actor,scope,recreate);assert.ok(replacement.calendar.event_id);assert.notEqual(replacement.calendar.event_id,firstEvent);firstEvent=replacement.calendar.event_id!;
 });
 await t.test('explicit RSVP commits owner draft + encrypted immutable MIME + real queued job with Calendar atomically',async()=>{
  sequence=4;const request=await input(scope,'tentative',true),receipt=await make().apply(actor,scope,request);assert.equal(receipt.response.state,'queued');assert.ok(receipt.response.outbox_id);assert.ok(operations.includes('human_send'));
  const row=(await pool.query('SELECT * FROM email_outbox WHERE outbox_id=$1',[receipt.response.outbox_id])).rows[0];assert.equal(row.state,'queued');const bytes=binary.open({...scope,outbox_id:row.outbox_id,operation_id:row.operation_id,mime_digest:row.mime_digest},row);
  const {simpleParser}=createRequire(new URL('../../../examples/apps/email/package.json',import.meta.url))('mailparser');const parsed=await simpleParser(bytes);assert.equal(parsed.to&&'value'in parsed.to?parsed.to.value[0]!.address:null,'organizer@example.test');assert.equal(parsed.from!.value[0]!.address,'owner@example.test');assert.equal(parsed.attachments.some((part:any)=>part.contentType==='text/calendar'),true);const reply=parsed.attachments.find((part:any)=>part.contentType==='text/calendar')!.content.toString();assert.match(reply,/METHOD:REPLY\r\n/);assert.match(reply,/ATTENDEE;PARTSTAT=TENTATIVE:mailto:owner@example.test/);assert.ok(!reply.includes('other@example.test'));bytes.fill(0);
  assert.deepEqual((await pool.query('SELECT metadata FROM events WHERE id=$1',[firstEvent])).rows[0].metadata.attendees.map((a:any)=>a.responseStatus),['tentative','accepted']);
  assert.equal((await pool.query('SELECT status FROM email_drafts WHERE draft_id=$1',[row.draft_id])).rows[0].status,'submitted');assert.equal((await pool.query('SELECT status,name FROM job_queue WHERE id=$1',[row.job_id])).rows[0].name,'native-email-outbox');
  await pool.query("UPDATE email_outbox SET state='paused',revision=revision+1 WHERE outbox_id=$1",[row.outbox_id]);assert.equal((await make().readRequest(actor,scope,request.request_id))!.response.state,'paused');
 });
 await t.test('Calendar final-fence/Outbox failure rolls back all rows; fresh source drift prevents reservation commit',async()=>{
  sequence=5;const counts=async()=>Promise.all(['events','email_calendar_invitation_actions','email_outbox','email_drafts','job_queue'].map(async table=>Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count)));
  const before=await counts(),beforeMetadata=(await pool.query('SELECT metadata FROM events WHERE id=$1',[firstEvent])).rows[0].metadata,request=await input(scope,'accepted',true);denyFinalRequest=request.request_id;await assert.rejects(make().apply(actor,scope,request),/FINAL_FENCE/);denyFinalRequest=null;assert.deepEqual(await counts(),before);assert.deepEqual((await pool.query('SELECT metadata FROM events WHERE id=$1',[firstEvent])).rows[0].metadata,beforeMetadata);
  const stale=await input(scope,'accepted',true);sourceChanged=true;await assert.rejects(make().apply(actor,scope,stale),/PREVIEW_STALE/);sourceChanged=false;assert.deepEqual(await counts(),before);
  allowed=false;await assert.rejects(make().preview(actor,scope,logical));allowed=true;
 });
 await t.test('explicit cancellation affects exact linked Calendar event only, never another account or queues a reply',async()=>{
  method='CANCEL';sequence=6;const preview=await make().preview(actor,scope,logical),request={request_id:randomUUID(),preview_token:preview.invitations[0]!.preview_token!,destination_id:'deft_personal',recreate_deleted:false,action:{kind:'apply_cancellation'}};
  const receipt=await make().apply(actor,scope,request);assert.equal(receipt.calendar.event_id,firstEvent);assert.equal(receipt.calendar.state,'cancelled');assert.equal(receipt.response.state,'not_requested');
  const rows=(await pool.query('SELECT account_id,event_id FROM email_calendar_invitations')).rows;const otherEvent=rows.find(row=>row.account_id==='other')!.event_id;
  assert.equal((await pool.query('SELECT metadata FROM events WHERE id=$1',[firstEvent])).rows[0].metadata.status,'canceled');assert.notEqual((await pool.query('SELECT metadata FROM events WHERE id=$1',[otherEvent])).rows[0].metadata.status,'canceled');
 });
 await t.test('concurrent mounted RSVP replay commits one exact receipt/Outbox; Calendar projection stays owner scoped',async()=>{
  method='REQUEST';sequence=7;const request=await input(scope,'accepted',true),headers={Authorization:'Bearer fixture','Content-Type':'application/json'};
  const before=Number((await pool.query('SELECT count(*) FROM email_outbox')).rows[0].count);
  const results=await Promise.all([1,2].map(()=>routes.request('http://fixture/accounts/account/invitations/apply',{method:'POST',headers,body:JSON.stringify(request)})));
  assert.deepEqual(results.map(value=>value.status),[202,202]);const receipts=await Promise.all(results.map(value=>value.json()));assert.deepEqual(receipts[0],receipts[1]);
  assert.equal(Number((await pool.query('SELECT count(*) FROM email_outbox')).rows[0].count),before+1);
  assert.equal((await pool.query('SELECT count(*) FROM email_calendar_invitation_actions WHERE request_id=$1',[request.request_id])).rows[0].count,'1');
  const occurrences=await readEmailCalendarOccurrences(database,{org_id:'org',owner_user_id:'owner',from:new Date('2026-10-01'),to:new Date('2026-11-01')});assert.equal(occurrences.length,6);
  assert.equal((await readEmailCalendarOccurrences(database,{org_id:'other-org',owner_user_id:'owner',from:new Date('2026-10-01'),to:new Date('2026-11-01')})).length,0);
  assert.equal((await readEmailCalendarOccurrences(database,{org_id:'org',owner_user_id:'other-owner',from:new Date('2026-10-01'),to:new Date('2026-11-01')})).length,0);
 });
 await t.test('whole series cancellation preserves edited exception, then forbids stale instance resurrection',async()=>{
  recurrenceId='20261019T120000Z';sequence=8;const instance=await make().apply(actor,scope,await input());const row=(await pool.query('SELECT * FROM events WHERE id=$1',[instance.calendar.event_id])).rows[0];
  await pool.query("UPDATE events SET title='Edited exception',updated_at=now() WHERE id=$1",[row.id]);
  recurrenceId='';method='CANCEL';sequence=9;const preview=await make().preview(actor,scope,logical),request={request_id:randomUUID(),preview_token:preview.invitations[0]!.preview_token!,destination_id:'deft_personal',recreate_deleted:false,action:{kind:'apply_cancellation'}};
  await assert.rejects(make().apply(actor,scope,request),/CALENDAR_EDITED/);assert.notEqual((await pool.query('SELECT metadata FROM events WHERE id=$1',[firstEvent])).rows[0].metadata.status,'canceled');
  await pool.query('UPDATE events SET title=$2,updated_at=$3 WHERE id=$1',[row.id,row.title,row.updated_at]);await make().apply(actor,scope,request);
  recurrenceId='20261019T120000Z';method='REQUEST';sequence=10;await assert.rejects(make().apply(actor,scope,await input()),/SERIES_CANCELLED/);
  const occurrences=await readEmailCalendarOccurrences(database,{org_id:'org',owner_user_id:'owner',from:new Date('2026-10-01'),to:new Date('2026-11-01')});assert.equal(occurrences.length,3);assert.ok(occurrences.every(row=>(row.metadata as any).email_invitation.account_id==='other'));
 });
 await t.test('existing mounted Calendar edit/delete routes enforce current organization and preserve actual owner time edits',async()=>{
  const shared=await import('../src/lib/db.js'),{eventRoutes}=await import('../src/routes/events.js'),{calendarRoutes}=await import('../src/routes/calendar.js');
  const originals={select:shared.db.select,update:shared.db.update,delete:shared.db.delete};
  Object.assign(shared.db,{select:database.select.bind(database),update:database.update.bind(database),delete:database.delete.bind(database)});
  try{
   const app=new Hono();app.use('*',async(c,next)=>{c.set('user',{id:'owner',org_id:c.req.header('x-org')??'org',email:'owner@example.test',role:'member'} as any);await next();});app.route('/events',eventRoutes);app.route('/calendar',calendarRoutes);
   const otherEvent=(await pool.query("SELECT event_id FROM email_calendar_invitations WHERE account_id='other'")).rows[0].event_id;
   for(const verb of ['PATCH','DELETE'])assert.equal((await app.request('http://fixture/events/'+otherEvent,{method:verb,headers:{'x-org':'wrong-org','content-type':'application/json'},...(verb==='PATCH'?{body:JSON.stringify({title:'forged'})}:{})})).status,404);
   const update=await app.request('http://fixture/events/'+otherEvent,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({start:'2026-10-06T12:00:00Z',end:'2026-10-06T13:00:00Z'})});assert.equal(update.status,200);
   const occurrences=await readEmailCalendarOccurrences(database,{org_id:'org',owner_user_id:'owner',from:new Date('2026-10-01'),to:new Date('2026-11-01')});assert.equal(occurrences[0]!.timestamp.toISOString(),'2026-10-06T12:00:00.000Z');
   const calendar=await app.request('http://fixture/calendar?from=2026-10-01&to=2026-11-01');assert.equal(calendar.status,200);const publicCalendar=await calendar.json();assert.deepEqual(publicCalendar.events.map((event:any)=>event.timestamp),['2026-10-06T12:00:00.000Z','2026-10-13T12:00:00.000Z','2026-10-20T12:00:00.000Z','2026-10-27T12:00:00.000Z']);
   const foreignCalendar=await app.request('http://fixture/calendar?from=2026-10-01&to=2026-11-01',{headers:{'x-org':'wrong-org'}});assert.equal(foreignCalendar.status,200);assert.deepEqual((await foreignCalendar.json()).events,[]);
   recurrenceId='';method='REQUEST';sequence=11;await assert.rejects(make().apply(actor,other,await input(other)),/CALENDAR_EDITED/);
  }finally{Object.assign(shared.db,originals);await shared.closeDb();}
 });
});
