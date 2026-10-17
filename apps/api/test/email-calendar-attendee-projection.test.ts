import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {events,emailOutbox} from '@deft/db/schema';
import {emailCalendarInvitations,emailCalendarInvitationActions} from '../../../packages/db/src/email-calendar-invitation-schema.js';
import {EmailCalendarInvitationStore,emailInvitationModelContext} from '../src/lib/email-calendar-invitation-store.js';
import {EmailCalendarInvitationService} from '../src/lib/email-calendar-invitation-service.js';
import {EmailInvitationPreviewService} from '../src/lib/email-calendar-invitation-preview.js';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {NativeEmailCalendarPartsSchema} from '../src/lib/email-native-adapter-contract.js';
import {parseEmailCalendarInvitations,serializeEmailInvitationReply,selectEmailInvitationAttendee} from '../src/lib/email-calendar-invitation.js';
import {assertEmailInvitationReceiver} from '../src/lib/email-calendar-attendee-projection.js';
import {projectEmailCalendarEvents} from '../src/lib/email-calendar-projection.js';
const require=createRequire(import.meta.url),ts=require('typescript'),webRequire=createRequire(new URL('../../web/package.json',import.meta.url));
const React=webRequire('react'),{renderToStaticMarkup}=webRequire('react-dom/server');
const scope={org_id:'org',owner_user_id:'owner',account_id:'account'},owner='owner@example.test',other='other@example.test',logical='mail_'+'a'.repeat(64),now=new Date('2026-10-04T12:00:00Z');
const actor={user_id:'owner',web_session_id:'sid',access_expires_at:now.getTime()+3600000},cap={scope,resource_binding_id:'binding',authority_version:'version',expires_at:actor.access_expires_at};
const body=(method='REQUEST')=>`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:${method}\r\nBEGIN:VEVENT\r\nUID:owner-projection\r\nDTSTAMP:20261004T120000Z\r\nSEQUENCE:1\r\nDTSTART:20261005T120000Z\r\nDTEND:20261005T130000Z\r\nSUMMARY:Owner projection\r\nORGANIZER:mailto:organizer@example.test\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${owner}\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:${other}\r\nATTENDEE;PARTSTAT=DECLINED:mailto:declined@example.test\r\nATTENDEE;PARTSTAT=TENTATIVE:mailto:tentative@example.test\r\nATTENDEE:mailto:pending@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const invitation=(method='REQUEST')=>{const result=parseEmailCalendarInvitations({source_digest:'b'.repeat(64),ics_text:body(method)});assert.equal(result.status,'parsed');return result.items[0]!;};
const input=(response:'accepted'|'tentative'|'declined'='accepted',send=false)=>({request_id:randomUUID(),preview_token:'token',destination_id:'deft_personal' as const,recreate_deleted:false,action:{kind:'rsvp' as const,response,send_response:send}});
/** Transaction-port fixture: executes the actual store/crypto/projection, not a
 * PostgreSQL authorization proof. Real SQL fences run in the separate PG gate. */
function database(){
 const tables=new Map<any,any[]>([events,emailOutbox,emailCalendarInvitations,emailCalendarInvitationActions].map(table=>[table,[]])),dialect=new PgDialect();let transactions=0;
 const matches=(table:any,row:any,condition:any)=>{if(!condition)return true;const p=dialect.sqlToQuery(condition).params;
  if(table===events)return row.id===p[0]&&row.org_id===p[1]&&row.user_id===p[2]&&row.source===p[3]&&row.event_type===p[4];
  return row.org_id===p[0]&&row.owner_user_id===p[1]&&row.account_id===p[2]&&(p.length===3||row[table===emailCalendarInvitations?'invitation_id':'request_id']===p[3]);};
 class Query{
  table:any;condition:any;payload:any;constructor(readonly kind:string){}
  from(table:any){this.table=table;return this;}where(condition:any){this.condition=condition;return this;}limit(_n:number){return this;}for(_mode:string){return this;}orderBy(_sort:any){return this;}
  values(value:any){this.payload=value;return this;}set(value:any){this.payload=value;return this;}returning(){return this;}
  then(resolve:any,reject:any){return Promise.resolve().then(()=>{const rows=tables.get(this.table)!;
   if(this.kind==='select')return rows.filter(row=>matches(this.table,row,this.condition));
   if(this.kind==='insert'){const row={...this.payload,url:null};rows.push(row);return [row];}
   return rows.filter(row=>matches(this.table,row,this.condition)).map(row=>Object.assign(row,this.payload));
  }).then(resolve,reject);}
 }
 const tx={select:()=>new Query('select'),insert:(table:any)=>Object.assign(new Query('insert'),{table}),update:(table:any)=>Object.assign(new Query('update'),{table}),execute:async()=>[]};
 return {tables,get transactions(){return transactions;},async transaction(fn:any){transactions++;const before=structuredClone([...tables.values()]);try{return await fn(tx);}catch(error){for(const [i,table]of [...tables.keys()].entries())tables.set(table,before[i]!);throw error;}}};
}
const keys={current:()=>({key_id:'fixture',key:Buffer.alloc(32,24)}),read:(_purpose:unknown,id:string)=>id==='fixture'?{key_id:id,key:Buffer.alloc(32,24)}:null,keyIds:()=>['fixture']};
function fixture(){
 const db=database(),cipher=new EmailMailboxCrypto(keys);let Store:any=EmailCalendarInvitationStore;
 // Exact pre-fix production class, executed with its original call signature.
 // This overlay is used only by the two metadata reproduction assertions.
 if(process.env.M7_BASELINE_STORE){const source=readFileSync(process.env.M7_BASELINE_STORE,'utf8'),exports:any={},module={exports},actualRequire=createRequire(new URL('../src/lib/email-calendar-invitation-store.ts',import.meta.url));
  const baselineRequire=(name:string)=>name==='@deft/db/schema'?{events,emailOutbox}:name.endsWith('/email-calendar-invitation-schema.js')?{emailCalendarInvitations,emailCalendarInvitationActions}:actualRequire(name);
  new Function('exports','module','require',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,module,baselineRequire);Store=module.exports.EmailCalendarInvitationStore;}
 const store=new Store(db,cipher,()=>now),apply=(choice:'accepted'|'tentative'|'declined',item=invitation(),guard=async()=>{})=>process.env.M7_BASELINE_STORE?store.apply(scope,logical,item,input(choice),guard):store.apply(scope,logical,item,input(choice),owner,guard);
 return {db,cipher,store,apply};
}
const modalSource=readFileSync(new URL('../../web/src/components/calendar/event-detail-modal.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('modal.tsx',modalSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const declaration=tree.statements.find((node:any)=>ts.isFunctionDeclaration(node)&&node.name?.text==='EventDetailModal');assert.ok(declaration);
const icon=()=>null,Modal=runInNewContext(ts.transpileModule('('+declaration.getText(tree).replace(/^export\s+/u,'')+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None,jsx:ts.JsxEmit.React}}).outputText,
 {React,useState:React.useState,useEffect:React.useEffect,getEventSourceColor:()=> '#000',getEventSourceLabel:()=> 'Calendar',formatEventTime:()=> '12:00',formatFullDateLong:()=> 'Synthetic date',RESPONSE_COLORS:{accepted:'#22c55e',declined:'#ef4444',tentative:'#f59e0b',needsAction:'#9ca3af'},api:{delete:()=>assert.fail('No external effects')},AutomationText:icon,CreateEventModal:icon,X:icon,MapPin:icon,ExternalLink:icon,Users:icon,Video:icon,FileText:icon,Clock:icon,Edit2:icon,Trash2:icon});
const statuses=(row:any)=>row.metadata.attendees.map((a:any)=>a.responseStatus);
test('actual store + real Calendar/modal project chosen receiver and preserve other incoming PARTSTAT',async()=>{
 for(const choice of ['accepted','tentative']as const){const f=fixture(),receipt=await f.apply(choice),row=f.db.tables.get(events)![0];
  assert.deepEqual(statuses(row),[choice,'accepted','declined','tentative','needsAction']);assert.equal(receipt.response.state,'not_requested');assert.equal(receipt.response.delivery_status,'unknown');
  const projected=projectEmailCalendarEvents([row],new Date('2026-10-05'),new Date('2026-10-06'))[0]!;assert.ok(projected);
  const html=renderToStaticMarkup(React.createElement(Modal,{event:projected,onClose:()=>{}}));assert.equal((html.match(/>pending</gu)??[]).length,1);assert.ok(html.includes('>'+(choice==='tentative'?'maybe':choice)+'<'));
  const reply=serializeEmailInvitationReply(invitation(),[owner],choice,now);assert.match(reply,new RegExp(`PARTSTAT=${choice.toUpperCase()}:mailto:${owner}`));assert.ok(!reply.includes(other));
 }
});
test('actual store decline updates only nominated receiver; cancellation preserves reported participation',async()=>{
 const f=fixture();await f.apply('accepted');await f.apply('declined');const row=f.db.tables.get(events)![0];assert.deepEqual(statuses(row),['declined','accepted','declined','tentative','needsAction']);assert.equal(row.metadata.status,'canceled');
 const cancelled=invitation('CANCEL');cancelled.sequence=2;const request={...input(),action:{kind:'apply_cancellation' as const}};
 if(process.env.M7_BASELINE_STORE)await f.store.apply(scope,logical,cancelled,request,async()=>{});else await f.store.apply(scope,logical,cancelled,request,null,async()=>{});
 assert.deepEqual(statuses(row),['declined','accepted','declined','tentative','needsAction']);
});
test('receiver must be exactly one eligible member before any transaction; legacy encrypted model remains readable',async()=>{
 const f=fixture(),item=invitation();for(const receiver of [null,'attacker@example.test','OWNER@example.test'])await assert.rejects(f.store.apply(scope,logical,item,input(),receiver,async()=>{}),/INVALID/);
 assert.equal(f.db.transactions,0);assert.throws(()=>assertEmailInvitationReceiver({...item,attendees:[item.attendees[0]!,item.attendees[0]!]},owner),/INVALID/);
 assert.throws(()=>assertEmailInvitationReceiver({...item,attendees:[{...item.attendees[0]!,delegated:true}]},owner),/INVALID/);
 await f.apply('accepted');const row=f.db.tables.get(emailCalendarInvitations)![0],context=emailInvitationModelContext(scope,row.invitation_id,row.revision),model=f.cipher.open(row.model_envelope,context)as any;
 assert.equal(model.receiving_attendee_address,owner);delete model.receiving_attendee_address;row.model_envelope=f.cipher.seal(model,context);await f.apply('tentative');assert.equal(statuses(f.db.tables.get(events)![0])[0],'tentative');
 const current=f.db.tables.get(emailCalendarInvitations)![0],ctx=emailInvitationModelContext(scope,current.invitation_id,current.revision),bad=f.cipher.open(current.model_envelope,ctx)as any;bad.receiving_attendee_address='attacker@example.test';current.model_envelope=f.cipher.seal(bad,ctx);
 const before=statuses(f.db.tables.get(events)![0]);await assert.rejects(f.apply('accepted'),/UNAVAILABLE|INVALID/);assert.deepEqual(statuses(f.db.tables.get(events)![0]),before);
});
test('actual store final authority denial rolls back attendee/model/action updates',async()=>{
 const f=fixture();await f.apply('accepted');const before=structuredClone([...f.db.tables.values()]);let checks=0;
 await assert.rejects(f.apply('tentative',invitation(),async()=>{if(++checks===2)throw Error('LATE_DENIAL');}),/LATE_DENIAL/);assert.equal(checks,2);assert.deepEqual([...f.db.tables.values()],before);
});
function serviceFixture(){
 const f=fixture();let allowed=true,source='b'.repeat(64),address=owner,release:()=>void=()=>{},entered:()=>void=()=>{},held=false,disposed=0;
 const ready=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r),authority={async current(){if(!allowed)throw Error('EMAIL_INVITATION_ACCESS_DENIED');return structuredClone(cap);}};
 const previews=new EmailInvitationPreviewService(authority,{async readCalendarParts(){return NativeEmailCalendarPartsSchema.parse({schema_version:'deft.email_calendar_parts.v1',account_id:scope.account_id,logical_message_id:logical,provider:'gmail',source_digest:source,receiving_identity:{primary_address:address,display_label:'Owner'},status:'available',parts:[{part_ref:'c'.repeat(64),ics_text:body(),media_type_method:'REQUEST'}]});}},f.cipher,()=>now.getTime());
 const replies={async prepare(){if(held){entered();await wait;}return {outbox_id:'fixture-outbox',enqueue:async()=>({outbox_id:'fixture-outbox',state:'queued' as const}),dispose:()=>{disposed++;}};}};
 return {...f,previews,service:new EmailCalendarInvitationService(authority,previews,f.store,replies as any,()=>now.getTime()),ready,release,hold(){held=true;},deny(){allowed=false;},changeSource(){source='d'.repeat(64);},changeReceiver(){address=other;},get disposed(){return disposed;}};
}
test('actual service transports host verified receiver; HTTP receiver injection remains forbidden',async()=>{
 const f=serviceFixture(),token=(await f.previews.preview(actor,scope,logical)).invitations[0]!.preview_token!,request={...input('tentative'),preview_token:token};
 await f.service.apply(actor,scope,request);assert.equal(statuses(f.db.tables.get(events)![0])[0],'tentative');
 await assert.rejects(f.service.apply(actor,scope,{...request,receiving_attendee_address:'attacker@example.test'}));
});
test('held preparation denies changed authority, source, receiver and abort before Calendar/Outbox transaction',async()=>{
 for(const change of ['authority','source','receiver','abort']){const f=serviceFixture(),token=(await f.previews.preview(actor,scope,logical)).invitations[0]!.preview_token!,request={...input('accepted',true),preview_token:token},controller=new AbortController();f.hold();
  const pending=f.service.apply(actor,scope,request,controller.signal);await f.ready;if(change==='authority')f.deny();if(change==='source')f.changeSource();if(change==='receiver')f.changeReceiver();if(change==='abort')controller.abort();f.release();
  await assert.rejects(pending);assert.equal(f.db.transactions,0);assert.equal(f.disposed,1);assert.equal(f.db.tables.get(events)!.length,0);
 }
});
