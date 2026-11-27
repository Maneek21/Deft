import {and,eq} from 'drizzle-orm';
import {orgMembers,spaces,spaceMembers,wikiPages,messages,tasks} from '@deft/db/schema';
import {documents} from '@deft/db/documents';
import {appIntegrationDestinationReceipts as receipts} from '../../../../packages/db/src/app-integration-destination-schema.js';
import type {AppRunTransaction as Tx} from './app-run-repository.js';
import type {AppIntegrationSourceCaller} from './app-integration-source.js';
import type {AppIntegrationDestinationPorts,DestinationResult} from './app-integration-destination.js';
import {createNativeKnowledge} from './native-context-create.js';
import {visibleDocumentCondition} from './document-access.js';
import {createNoteDocumentInTx,documentIdForNoteRef,noteContentJson} from './legacy-notes.js';
import {assertNativeChatForwardDestination,createNativeChatForward} from './native-chat-forward.js';
import {AppIntegrationSourceIdentitySchema} from '../../../../packages/app-kit/src/app-integration-source.js';
const deny=()=>new Error('APP_INTEGRATION_DESTINATION_CHANGED_OR_DENIED');
const escape=(v:string)=>v.replace(/[&<>"'\[\]]/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','[':'&#91;',']':'&#93;'}[c]!));
const where=(caller:AppIntegrationSourceCaller,id:string)=>and(eq(receipts.org_id,caller.org_id),eq(receipts.owner_user_id,caller.user_id),eq(receipts.request_id,id));
/** Concrete constructors and receipts share the caller's transaction. No native
 * Email rows, provider credentials or copied App ID in Chat foreign keys.
 * A `document` (or legacy `note`) destination is a document since notes moved
 * (F15, lib/legacy-notes.ts): created where a note of that visibility moved,
 * and checked on replay by the document's current access. */
export function appIntegrationDestinationPostgres(input:{
 task?:Pick<AppIntegrationDestinationPorts<Tx>,'audience'|'create'>;
}):Pick<AppIntegrationDestinationPorts<Tx>,'audience'|'receipt'|'reserve'|'complete'|'create'|'visibleResult'>{return {
 async audience(tx,caller,destination,taskDetails){
  if(destination.kind==='task'){if(!input.task)throw deny();return input.task.audience(tx,caller,destination,taskDetails);}
  const members=await tx.select({id:orgMembers.id,user_id:orgMembers.user_id,version:orgMembers.app_run_authorization_version,role:orgMembers.role}).from(orgMembers).where(and(eq(orgMembers.org_id,caller.org_id),eq(orgMembers.is_active,true))).for('share');members.sort((a,b)=>a.id.localeCompare(b.id));
  if(!members.some(row=>row.user_id===caller.user_id&&row.role!=='guest'))throw deny();
  // A private document is the caller's; an org note (Shared notes) is read by owners, admins and members, never guests.
  if(destination.kind==='document'&&destination.space_id===null)return {visibility:'private',label:'Only you',member_count:1,identity:members.filter(m=>m.user_id===caller.user_id)};
  if(destination.kind==='note'&&destination.visibility!=='space'){const readers=members.filter(m=>m.role!=='guest');return {visibility:destination.visibility,label:destination.visibility==='private'?'Only you':'Organization members',member_count:destination.visibility==='private'?1:readers.length,identity:destination.visibility==='private'?members.filter(m=>m.user_id===caller.user_id):readers};}
  const id=destination.space_id!;const [space]=await tx.select({id:spaces.id,name:spaces.name,archived:spaces.is_archived}).from(spaces).where(and(eq(spaces.org_id,caller.org_id),eq(spaces.id,id))).for('share');if(!space||space.archived)throw deny();
  const rows=await tx.select({id:spaceMembers.id,user_id:spaceMembers.user_id,joined_at:spaceMembers.joined_at}).from(spaceMembers).where(eq(spaceMembers.space_id,id)).for('share');const active=rows.filter(m=>members.some(o=>o.user_id===m.user_id)).sort((a,b)=>a.id.localeCompare(b.id));if(!active.some(m=>m.user_id===caller.user_id))throw deny();
  if(destination.kind==='chat')await assertNativeChatForwardDestination(tx,{id:caller.user_id,org_id:caller.org_id},id);
  return {visibility:'space',label:space.name+' members',member_count:active.length,identity:{space,members:active.map(m=>({...m,joined_at:m.joined_at.toISOString(),version:members.find(o=>o.user_id===m.user_id)!.version}))}};
 },
 async receipt(tx,caller,id){const [row]=await tx.select().from(receipts).where(where(caller,id)).limit(1);if(!row?.result)return null;return {request_digest:row.request_digest,source:AppIntegrationSourceIdentitySchema.parse(row.source),destination:row.destination as import('../../../../packages/app-kit/src/app-integration-destination.js').AppIntegrationDestination,result:row.result as DestinationResult};},
 async reserve(tx,caller,value){const rows=await tx.insert(receipts).values({org_id:caller.org_id,owner_user_id:caller.user_id,...value,source:value.source}).onConflictDoNothing().returning({id:receipts.request_id});return rows.length===1;},
 async complete(tx,caller,id,result){await tx.update(receipts).set({result,updated_at:new Date()}).where(where(caller,id));},
 async visibleResult(tx,caller,result){
 if(result.destination_kind==='note'||result.destination_kind==='document'){const id=await documentIdForNoteRef(caller.org_id,result.destination_id,tx);const [row]=await tx.select({id:documents.id}).from(documents).where(and(eq(documents.id,id),visibleDocumentCondition(caller.user_id,caller.org_id))).for('share');if(!row)throw deny();await this.audience(tx,caller,{kind:'document',space_id:null});}
 else if(result.destination_kind==='knowledge'){const [row]=await tx.select().from(wikiPages).where(and(eq(wikiPages.org_id,caller.org_id),eq(wikiPages.id,result.destination_id),eq(wikiPages.is_deleted,false))).for('share');if(!row)throw deny();await this.audience(tx,caller,{kind:'knowledge',space_id:row.space_id!,type:'fact'});}
 else if(result.destination_kind==='chat'){const [row]=await tx.select().from(messages).where(and(eq(messages.org_id,caller.org_id),eq(messages.id,result.destination_id),eq(messages.is_deleted,false))).for('share');if(!row)throw deny();await this.audience(tx,caller,{kind:'chat',space_id:row.space_id});}
 else {const [row]=await tx.select().from(tasks).where(and(eq(tasks.org_id,caller.org_id),eq(tasks.id,result.destination_id),eq(tasks.is_deleted,false))).for('share');if(!row)throw deny();await this.audience(tx,caller,{kind:'task',project_id:row.project_id});}
},
 async create(tx,caller,value,snapshot,request_id){
  if(value.destination.kind==='task'){if(!input.task)throw deny();return input.task.create(tx,caller,value,snapshot,request_id);}
  const citation='/apps/source/transfer/'+encodeURIComponent(request_id);
  const link='<p><a href="'+escape(citation)+'">Open original source (requires access)</a></p>',quoted=value.mode==='excerpt'?'<blockquote>'+escape(value.excerpt!).replace(/\r?\n/g,'<br>')+'</blockquote>':'';
  const user={id:caller.user_id,org_id:caller.org_id};let id:string,url:string;
  if(value.destination.kind==='note'||value.destination.kind==='document'){const destination=value.destination,visibility=destination.kind==='note'?destination.visibility:destination.space_id?'space':'private';
   const {document}=await createNoteDocumentInTx(tx as unknown as Parameters<typeof createNoteDocumentInTx>[0],{orgId:caller.org_id,userId:caller.user_id,title:value.title,json:noteContentJson(link+quoted),visibility,spaceId:destination.space_id});id=document.id;url='/d/'+encodeURIComponent(id);}
  else if(value.destination.kind==='chat'){const message=await createNativeChatForward(tx,user,{space_id:value.destination.space_id,content:'<p>'+escape(value.title)+'</p>'+link+quoted,metadata:{app_integration_transfer:{mode:value.mode,source_citation: citation,observed_at:snapshot.publication.observed_at,partial:snapshot.publication.partial}}});id=message.id;url='/chat?'+new URLSearchParams({space:value.destination.space_id,message:id});}
  else{const quote=value.mode==='excerpt'?'\n\n'+value.excerpt!.replace(/[\\`*_{}\[\]()#+.!<>~|:\-]/gu,'\\$&').split(/\r?\n/u).map(l=>'> '+l).join('\n'):'';const page=await createNativeKnowledge(tx,user,{space_id:value.destination.space_id,type:value.destination.type,title:value.title,content:'[Open original source (requires access)]('+citation+')'+quote,metadata:{app_integration_transfer:{observed_at:snapshot.publication.observed_at,partial:snapshot.publication.partial}},created_via:'app_integration_transfer'});id=page.id;url='/knowledge?slug='+encodeURIComponent(page.slug);}
  return {destination_kind:value.destination.kind,destination_id:id,destination_url:url,replayed:false};
 },
};}
