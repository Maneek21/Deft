import {createHash} from 'node:crypto';
import {and,eq,inArray,isNull,count} from 'drizzle-orm';
import {canonicalCapabilityJson} from '@deft/shared';
import {z} from 'zod';
import {emailMessages,emailCheckpoints,emailMemberships,emailOperations,emailImapAliases,emailImapMoveReservations} from '@deft/db/schema';
import type {db} from './db.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import type {EmailScope,EmailMessageRecord} from './email-mailbox-service.js';
import type {NativeEmailProviderScope,NativeEmailTriageValue} from './app-connection-contract.js';
import {EmailImapAliasProofSchema,EmailImapLocatorSchema,emailImapLocatorKey,emailImapSourceDigest,type EmailImapMoveNomination,type EmailImapAliasProof} from './email-imap-alias-contract.js';
type Database=Pick<typeof db,'transaction'>;
type Tx=Parameters<Parameters<Database['transaction']>[0]>[0];
type Guard=(transaction:unknown)=>Promise<void>;
export type EmailImapMoveBinding=Readonly<{resource_binding_id:string;action_binding_id?:string;authority_epoch:number}>;
const reservation=z.strictObject({destination_mailbox:EmailImapLocatorSchema.shape.mailbox,destination_folders:z.array(z.string().min(1).max(256)).min(1).max(8),source:z.record(z.string(),z.json())});
const where=(table:typeof emailMessages|typeof emailCheckpoints|typeof emailMemberships|typeof emailOperations|typeof emailImapAliases|typeof emailImapMoveReservations,s:EmailScope)=>and(eq(table.org_id,s.org_id),eq(table.owner_user_id,s.owner_user_id),eq(table.account_id,s.account_id));
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
const same=(a:unknown,b:unknown)=>a===undefined||b===undefined?a===b:canonicalCapabilityJson(a)===canonicalCapabilityJson(b);
const context=(scope:EmailScope,id:string,revision:number)=>({...scope,kind:'operation' as const,record_id:id,revision});
const reservationId=(operation:string,id:string)=>`imap-move:${operation}:${id}`;
const locatorLogicalId=(scope:NativeEmailProviderScope,account:string,locator:z.infer<typeof EmailImapLocatorSchema>)=>`mail_${createHash('sha256').update(JSON.stringify([{org_id:scope.org_id,owner_id:scope.owner_id,installation_id:scope.installation_id},account,JSON.stringify([account,'imap_smtp',[locator.mailbox,locator.uidvalidity,locator.uid]])])).digest('hex')}`;
/** Uses guard -> checkpoint -> journal -> message lock order. No network I/O
 * happens inside a transaction. Unknown effects retain one reservation/message. */
export class PostgresEmailImapAliasStore {
 constructor(private readonly database:Database,private readonly cipher:EmailMailboxCrypto,private readonly now=()=>new Date()){}
 private async journal(tx:Tx,scope:EmailScope,id:string,providerScope:NativeEmailProviderScope,binding:EmailImapMoveBinding){
  z.uuid().parse(id);if(providerScope.org_id!==scope.org_id||providerScope.owner_id!==scope.owner_user_id)fail('EMAIL_IMAP_MOVE_PROOF_INVALID');
  const [row]=await tx.select().from(emailOperations).where(and(where(emailOperations,scope),eq(emailOperations.operation_id,id))).limit(1).for('update');
  if(!row||row.kind!=='triage'||row.revision<1||!row.content_envelope)fail('EMAIL_IMAP_MOVE_PROOF_INVALID');
  const value=this.cipher.open(row.content_envelope,context(scope,id,row.revision)) as unknown as NativeEmailTriageValue,plan=value?.plan;
  if(!plan||plan.schema_version!=='deft.email_triage_plan.v1'||plan.operation_id!==id||!same(plan.binding.scope,providerScope)
   ||plan.binding.account.account_id!==scope.account_id||plan.binding.account.provider!=='imap_smtp'
   ||plan.binding.account.resource_binding_id!==binding.resource_binding_id||plan.binding.action_binding_id!==plan.binding.account.action_binding_id
   ||binding.action_binding_id!==undefined&&plan.binding.action_binding_id!==binding.action_binding_id
   ||plan.binding.account.authority_epoch!==binding.authority_epoch||!Array.isArray(plan.items)||!plan.items.length||plan.items.length>25
   ||!Array.isArray(value.items)||value.items.length!==plan.items.length||new Set(plan.items.map(item=>item.logical_id)).size!==plan.items.length)fail('EMAIL_IMAP_MOVE_PROOF_INVALID');
  const {digest,...unsigned}=plan;if(emailImapSourceDigest(unsigned)!==digest)fail('EMAIL_IMAP_MOVE_PROOF_INVALID');
  if(value.items.some((item,i)=>item.logical_id!==plan.items[i]?.logical_id||!['prepared','started','succeeded','failed','unknown'].includes(item.state)))fail('EMAIL_IMAP_MOVE_PROOF_INVALID');return value;
 }
 private async checkpoint(tx:Tx,scope:EmailScope){await tx.insert(emailCheckpoints).values({...scope}).onConflictDoNothing();const [row]=await tx.select().from(emailCheckpoints).where(where(emailCheckpoints,scope)).limit(1).for('update');if(!row)fail('EMAIL_IMAP_MOVE_PROOF_INVALID');return row;}
 private source(scope:EmailScope,row:typeof emailMessages.$inferSelect){if(!row.source_envelope||row.deleted_at)fail('EMAIL_IMAP_MOVE_SOURCE_CHANGED');return this.cipher.open(row.source_envelope,{...scope,kind:'provider_source',record_id:row.logical_message_id,revision:row.storage_revision}) as Record<string,unknown>;}
 private proof(scope:EmailScope,row:typeof emailImapAliases.$inferSelect){const proof=EmailImapAliasProofSchema.parse(this.cipher.open(row.evidence_envelope,context(scope,`imap-alias:${row.locator_key}`,row.revision)));
  if(proof.account_id!==scope.account_id||proof.provider_scope.org_id!==scope.org_id||proof.provider_scope.owner_id!==scope.owner_user_id||proof.logical_message_id!==row.logical_message_id)fail('EMAIL_IMAP_MOVE_PROOF_INVALID');return proof;}
 async lookup(scope:EmailScope,locator:unknown,guard:Guard):Promise<EmailImapAliasProof|null>{const key=emailImapLocatorKey(scope.account_id,EmailImapLocatorSchema.parse(locator));return this.database.transaction(async tx=>{await guard(tx);const [row]=await tx.select().from(emailImapAliases).where(and(where(emailImapAliases,scope),eq(emailImapAliases.locator_key,key))).limit(1);const result=row?this.proof(scope,row):null;await guard(tx);return result;});}
 async reserveMove(scope:EmailScope,input:EmailImapMoveNomination,providerScope:NativeEmailProviderScope,binding:EmailImapMoveBinding,guard:Guard){
  const before=EmailImapLocatorSchema.parse(input.before_locator),destination=reservation.shape.destination_mailbox.parse(input.destination_mailbox),folders=reservation.shape.destination_folders.parse(input.destination_folders);if(new Set(folders).size!==folders.length)fail('EMAIL_IMAP_MOVE_PROOF_INVALID');
  return this.database.transaction(async tx=>{await guard(tx);await this.checkpoint(tx,scope);const journal=await this.journal(tx,scope,input.operation_id,providerScope,binding);
   const candidates=journal.plan.items.filter(item=>same(item.before?.locator,before));if(candidates.length!==1)fail('EMAIL_IMAP_MOVE_PROOF_INVALID');
   const kind=journal.plan.operation.kind;if(typeof kind!=='string'||!['archive','trash','spam','restore','not_spam','move'].includes(kind)||!journal.plan.binding.operations.includes(kind))fail('EMAIL_IMAP_MOVE_PROOF_INVALID');
   const expectedDestination=journal.plan.undo_of?(candidates[0]!.restore_before?.locator as {mailbox?:unknown}|undefined)?.mailbox:kind==='move'?journal.plan.operation.destination:undefined;
   if(expectedDestination!==undefined&&expectedDestination!==destination||!journal.plan.undo_of&&['archive','trash','spam'].includes(kind)&&!folders.includes(kind))fail('EMAIL_IMAP_MOVE_PROOF_INVALID');
   const id=candidates[0]!.logical_id,state=journal.items.find(item=>item.logical_id===id)!;
   const [row]=await tx.select().from(emailMessages).where(and(where(emailMessages,scope),eq(emailMessages.logical_message_id,id),isNull(emailMessages.deleted_at))).limit(1).for('update');if(!row)fail('EMAIL_IMAP_MOVE_SOURCE_CHANGED');
   const source=this.source(scope,row);if(source.account_id!==scope.account_id||source.logical_message_id!==id||source.provider!=='imap_smtp'||!same(source.locator,before))fail('EMAIL_IMAP_MOVE_SOURCE_CHANGED');
   const [prior]=await tx.select().from(emailImapMoveReservations).where(and(where(emailImapMoveReservations,scope),eq(emailImapMoveReservations.logical_message_id,id))).limit(1);
   const source_digest=emailImapSourceDigest(source);
   if(prior){const saved=reservation.parse(this.cipher.open(prior.reservation_envelope,context(scope,reservationId(prior.operation_id,id),1)));
    if(prior.operation_id!==input.operation_id)fail('EMAIL_IMAP_MOVE_BUSY');if(prior.source_digest!==source_digest||saved.destination_mailbox!==destination||!same(saved.destination_folders,folders))fail('EMAIL_IMAP_MOVE_SOURCE_CHANGED');await guard(tx);return;}
   if(state.state!=='prepared')fail('EMAIL_IMAP_MOVE_PROOF_INVALID');const [total]=await tx.select({value:count()}).from(emailImapAliases).where(and(where(emailImapAliases,scope),eq(emailImapAliases.logical_message_id,id)));
   if((total?.value??0)>=32)fail('EMAIL_IMAP_MOVE_ALIAS_LIMIT');
   await tx.insert(emailImapMoveReservations).values({...scope,logical_message_id:id,operation_id:input.operation_id,source_digest,
    reservation_envelope:this.cipher.seal({destination_mailbox:destination,destination_folders:folders,source},context(scope,reservationId(input.operation_id,id),1))});await guard(tx);
  });
 }
 async reconcileMove(scope:EmailScope,operationId:string,providerScope:NativeEmailProviderScope,binding:EmailImapMoveBinding,guard:Guard){
  return this.database.transaction(async tx=>{await guard(tx);const checkpoint=await this.checkpoint(tx,scope);const journal=await this.journal(tx,scope,operationId,providerScope,binding);
   const held=await tx.select().from(emailImapMoveReservations).where(and(where(emailImapMoveReservations,scope),eq(emailImapMoveReservations.operation_id,operationId)));
   let changed=0,unresolved=0;const revision=checkpoint.revision+1;if(revision>2147483647)fail('EMAIL_IMAP_MOVE_ALIAS_LIMIT');
   for(const heldRow of held.sort((a,b)=>a.logical_message_id.localeCompare(b.logical_message_id))){
    const item=journal.items.find(item=>item.logical_id===heldRow.logical_message_id),prepared=journal.plan.items.find(item=>item.logical_id===heldRow.logical_message_id);if(!item||!prepared)fail('EMAIL_IMAP_MOVE_PROOF_INVALID');
    if(item.state==='failed'){await tx.delete(emailImapMoveReservations).where(and(where(emailImapMoveReservations,scope),eq(emailImapMoveReservations.logical_message_id,item.logical_id)));continue;}
    if(item.state!=='succeeded'){unresolved++;continue;}
    const before=EmailImapLocatorSchema.parse(prepared.before?.locator),after=EmailImapLocatorSchema.parse(item.after?.locator);if(same(before,after))fail('EMAIL_IMAP_MOVE_PROOF_INVALID');
    const [row]=await tx.select().from(emailMessages).where(and(where(emailMessages,scope),eq(emailMessages.logical_message_id,item.logical_id))).limit(1).for('update');if(!row)fail('EMAIL_IMAP_MOVE_SOURCE_CHANGED');
    const source=this.source(scope,row),saved=reservation.parse(this.cipher.open(heldRow.reservation_envelope,context(scope,reservationId(operationId,item.logical_id),1)));
    if(emailImapSourceDigest(source)!==heldRow.source_digest||!same(source.locator,before)||!same(saved.source,source)||after.mailbox!==saved.destination_mailbox)fail('EMAIL_IMAP_MOVE_SOURCE_CHANGED');
    const aliases=await tx.select().from(emailImapAliases).where(and(where(emailImapAliases,scope),eq(emailImapAliases.logical_message_id,item.logical_id))),previous=aliases.length?this.proof(scope,aliases[0]!):null;
    const proof=EmailImapAliasProofSchema.parse({schema_version:'deft.email_imap_alias.v1',provider_scope:previous?.provider_scope??providerScope,account_id:scope.account_id,
     logical_message_id:item.logical_id,conversation_id:source.conversation_id,base_locator:previous?.base_locator??before,current_locator:after,operation_id:operationId});
    const keys=[...new Set([...aliases.map(alias=>alias.locator_key),emailImapLocatorKey(scope.account_id,before),emailImapLocatorKey(scope.account_id,after)])];if(keys.length>32)fail('EMAIL_IMAP_MOVE_ALIAS_LIMIT');
    const destinationId=locatorLogicalId(providerScope,scope.account_id,after);
    if(destinationId!==item.logical_id){const [duplicate]=await tx.select({id:emailMessages.logical_message_id}).from(emailMessages).where(and(where(emailMessages,scope),eq(emailMessages.logical_message_id,destinationId))).limit(1);if(duplicate)fail('EMAIL_IMAP_MOVE_ALIAS_COLLISION');}
    for(const key of keys){await tx.insert(emailImapAliases).values({...scope,logical_message_id:item.logical_id,locator_key:key,revision,evidence_envelope:this.cipher.seal(proof,context(scope,`imap-alias:${key}`,revision))}).onConflictDoNothing();
     const [alias]=await tx.select().from(emailImapAliases).where(and(where(emailImapAliases,scope),eq(emailImapAliases.locator_key,key))).limit(1);if(!alias||alias.logical_message_id!==item.logical_id)fail('EMAIL_IMAP_MOVE_ALIAS_COLLISION');
     await tx.update(emailImapAliases).set({revision,evidence_envelope:this.cipher.seal(proof,context(scope,`imap-alias:${key}`,revision)),updated_at:this.now()}).where(and(where(emailImapAliases,scope),eq(emailImapAliases.locator_key,key)));
    }
    const nextSource={...source,locator:after},oldSummary=this.cipher.open(row.summary_envelope,{...scope,kind:'summary',record_id:item.logical_id,revision:row.storage_revision}) as Record<string,unknown>,flags=z.array(z.string()).max(100).parse(item.after?.flags);
    const summary={...oldSummary,in_inbox:saved.destination_folders.includes('inbox'),in_sent:saved.destination_folders.includes('sent'),in_archive:saved.destination_folders.includes('archive'),seen:flags.includes('\\Seen'),flagged:flags.includes('\\Flagged'),answered:flags.includes('\\Answered')};
    await tx.update(emailMessages).set({revision:`move:${operationId}`,storage_revision:revision,source_envelope:this.cipher.seal(nextSource,{...scope,kind:'provider_source',record_id:item.logical_id,revision}),summary_envelope:this.cipher.seal(summary,{...scope,kind:'summary',record_id:item.logical_id,revision}),seen:flags.includes('\\Seen'),flagged:flags.includes('\\Flagged'),answered:flags.includes('\\Answered'),inventory_generation:null,updated_at:this.now()}).where(and(where(emailMessages,scope),eq(emailMessages.logical_message_id,item.logical_id)));
    await tx.delete(emailMemberships).where(and(where(emailMemberships,scope),eq(emailMemberships.logical_message_id,item.logical_id)));
    await tx.insert(emailMemberships).values(saved.destination_folders.map(folder=>({...scope,logical_message_id:item.logical_id,folder,inventory_generation:null})));
    await tx.delete(emailImapMoveReservations).where(and(where(emailImapMoveReservations,scope),eq(emailImapMoveReservations.logical_message_id,item.logical_id)));changed++;
   }
   if(changed){const cursor=checkpoint.cursor_envelope?this.cipher.open(checkpoint.cursor_envelope,{...scope,kind:'checkpoint',record_id:'provider-cursor',revision:checkpoint.revision}):null;
    await tx.update(emailCheckpoints).set({revision,cursor_envelope:cursor?this.cipher.seal(cursor,{...scope,kind:'checkpoint',record_id:'provider-cursor',revision}):null,coverage:'partial',fresh_until:null,updated_at:this.now()}).where(where(emailCheckpoints,scope));}
   await guard(tx);return {changed,unresolved};
  });
 }
 async normalizeRecords(rawTx:unknown,scope:EmailScope,records:readonly EmailMessageRecord[]):Promise<EmailMessageRecord[]>{const tx=rawTx as Tx,result:EmailMessageRecord[]=[];
  const keys=records.filter(record=>record.provider_source.provider==='imap_smtp').map(record=>emailImapLocatorKey(scope.account_id,EmailImapLocatorSchema.parse(record.provider_source.locator)));
  const aliases=keys.length?await tx.select().from(emailImapAliases).where(and(where(emailImapAliases,scope),inArray(emailImapAliases.locator_key,keys))):[],byKey=new Map(aliases.map(row=>[row.locator_key,row]));
  for(const record of records){if(record.provider_source.provider!=='imap_smtp'){result.push(record);continue;}const locator=EmailImapLocatorSchema.parse(record.provider_source.locator),key=emailImapLocatorKey(scope.account_id,locator);
   const alias=byKey.get(key);if(!alias){result.push(record);continue;}const proof=this.proof(scope,alias);
   if(!same(proof.current_locator,locator))continue;
   result.push({...record,logical_message_id:proof.logical_message_id,data:{...record.data,logical_message_id:proof.logical_message_id,conversation_id:proof.conversation_id},provider_source:{...record.provider_source,logical_message_id:proof.logical_message_id,conversation_id:proof.conversation_id}});
  }if(new Set(result.map(record=>record.logical_message_id)).size!==result.length)fail('EMAIL_IMAP_MOVE_ALIAS_COLLISION');return result;
 }
 async filterTombstones(rawTx:unknown,scope:EmailScope,ids:readonly string[],proofs:Readonly<Record<string,string>>={}):Promise<string[]>{const tx=rawTx as Tx;if(!ids.length)return [];const rows=await tx.select().from(emailMessages).where(and(where(emailMessages,scope),inArray(emailMessages.logical_message_id,[...ids]),isNull(emailMessages.deleted_at)));
  const sources=new Map(rows.map(row=>[row.logical_message_id,this.source(scope,row)])),imapIds=rows.filter(row=>sources.get(row.logical_message_id)?.provider==='imap_smtp').map(row=>row.logical_message_id);
  const reservations=imapIds.length?await tx.select({id:emailImapMoveReservations.logical_message_id}).from(emailImapMoveReservations).where(and(where(emailImapMoveReservations,scope),inArray(emailImapMoveReservations.logical_message_id,imapIds))):[],held=new Set(reservations.map(row=>row.id));
  return ids.filter(id=>{const source=sources.get(id);if(!source||source.provider!=='imap_smtp')return true;return !held.has(id)&&proofs[id]===emailImapSourceDigest(source);});
 }
}
