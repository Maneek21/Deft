import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHash,randomUUID} from 'node:crypto';
import {createNativeImapEffectsBridge} from './native-imap-effects.mjs';
import {LogicalMailIndex} from '../logical-mail-index.mjs';
import {providerSourceForParent} from './provider-browser.mjs';
export function nativeImapEffectsFixture(){
 const scope={org_id:'org',owner_id:'owner',installation_id:'installation'},descriptor={org_id:'org',owner_user_id:'owner',installation_id:'installation',account_id:'account',provider:'imap_smtp',resource_binding_id:'binding',authority_epoch:1,connection_revision:1,principal_digest:'a'.repeat(64),health:'connected',capabilities:['read','modify','send'],primary_address:'owner@example.test',display_label:'Native IMAP SMTP',connection_target:'host-target',action_binding_id:'action',verified_sender_identities:['owner@example.test']};
 const boxes=new Map([['INBOX',{validity:'100',rows:new Map([[1,{uid:1,flags:new Set(['\\Answered']),modseq:1n}]])}],['Localized Archive',{validity:'101',specialUse:'\\Archive',rows:new Map()}],['Localized Trash',{validity:'102',specialUse:'\\Trash',rows:new Map()}],['Private Work',{validity:'103',rows:new Map()}]]);
 const calls={imap:0,smtp:0,list:0,write:0,send:0,close:0,reserve:0},ledger=new Map();let allowed=true,transportResult=null,onWrite=async()=>{},onSend=async()=>{},tls=true,condstore=true,move=true,finishLoss=false,captured;
 const journal={async load(_scope,id){return structuredClone(ledger.get(id)??null);},async create(plan){assert.equal(ledger.has(plan.operation_id),false);ledger.set(plan.operation_id,{plan:structuredClone(plan),items:plan.items.map(item=>({logical_id:item.logical_id,state:'prepared'}))});},
  async change(_scope,id,work){await work(structuredClone(ledger.get(id)),async value=>{if(finishLoss&&value.items.some(item=>item.state==='succeeded'))throw Error('Synthetic durable finish loss');ledger.set(id,structuredClone(value));});}};
 const context={org_id:'org',owner_user_id:'owner',installation_id:'installation',account_id:'account',resource_binding_id:'binding',authority_version:'v1',expires_at:Date.now()+60000,recheck:async()=>{if(!allowed)throw Error('revoked');}};
 const triageContext={...context,triage_journal:journal,imap_aliases:{lookup:async()=>null,reserve:async()=>{if(!allowed)throw Error('revoked');},reconcile:async()=>{}},triage_before_reserve:async()=>{if(!allowed)throw Error('revoked');}};
 const sendContext={...context,send_before_reserve:async()=>{calls.reserve++;return allowed;}};
 const host={async current(_ctx,purpose='read'){assert.ok(['read','modify','send'].includes(purpose));return structuredClone(descriptor);},
  async withAuthorizedClient(_ctx,expected,work,purpose='read'){assert.ok(['modify','read'].includes(purpose));assert.equal(expected.principal_digest,descriptor.principal_digest);calls.imap++;
   const client={secureConnection:tls,authenticated:true,capabilities:new Set([...(move?['MOVE','UIDPLUS']:[]),...(condstore?['CONDSTORE']:[])]),
    async list(){calls.list++;return [...boxes].map(([path,box])=>({path,specialUse:box.specialUse,flags:new Set()}));},
    async getMailboxLock(path,options={}){const box=boxes.get(path);assert.ok(box);this.mailbox={path,uidValidity:box.validity,readOnly:options.readOnly===true,permanentFlags:new Set(['\\*'])};return {release(){}};},
    async fetchOne(uid,query,options){assert.equal(options.uid,true);const row=boxes.get(this.mailbox.path).rows.get(uid);return row?{...structuredClone(row),size:bytes.length}:false;},
    async download(uid,_part,options){assert.equal(options.uid,true);assert.ok(boxes.get(this.mailbox.path).rows.has(uid));return {meta:{expectedSize:bytes.length},content:Readable.from([Buffer.from(bytes)])};},
    async messageFlagsSet(uid,flags,options){const row=boxes.get(this.mailbox.path).rows.get(uid);assert.equal(options.uid,true);assert.equal(options.unchangedSince,row.modseq);assert.ok([...ledger.values()].some(value=>value.items[0].state==='started'));calls.write++;row.flags=new Set(flags);row.modseq++;await onWrite();return true;},
    async messageMove(uid,destination,options){assert.equal(options.uid,true);assert.ok([...ledger.values()].some(value=>value.items[0].state==='started'));calls.write++;const row=boxes.get(this.mailbox.path).rows.get(uid);boxes.get(this.mailbox.path).rows.delete(uid);const dest=boxes.get(destination);dest.rows.set(99,{...row,uid:99});await onWrite();return {uidMap:new Map([[uid,99]]),uidValidity:dest.validity};}};
   try{return await work(client);}finally{calls.close++;}},
  async withAuthorizedSmtp(_ctx,expected,work){calls.smtp++;assert.equal(expected.principal_digest,descriptor.principal_digest);try{return await work({async sendMail(packet){calls.send++;captured=packet.raw;assert.equal(calls.reserve,1);assert.equal(createHash('sha256').update(packet.raw).digest('hex'),request.mime_digest);assert.equal(/^Bcc:/mi.test(packet.raw.toString()),false);assert.deepEqual(packet.envelope,request.envelope);await onSend();return transportResult??{accepted:packet.envelope.to,rejected:[],pending:[]};},close(){}});}finally{calls.close++;}}
 };
 const bytes=Buffer.from('From: owner@example.test\r\nTo: to@example.test\r\nCc: cc@example.test\r\nSubject: Native SMTP\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nExact synthetic bytes\r\n');
 const request={operation_id:randomUUID(),mime_bytes:bytes,mime_digest:createHash('sha256').update(bytes).digest('hex'),from_address:'owner@example.test',envelope:{from:'owner@example.test',to:['to@example.test','cc@example.test','blind@example.test']}};
 const source=providerSourceForParent(descriptor,new LogicalMailIndex(scope).upsert(scope,{account_id:'account',provider:'imap_smtp',locator:{kind:'imap_smtp',mailbox:'INBOX',uidvalidity:'100',uid:1}}));
 return {host,bridge:()=>createNativeImapEffectsBridge({host}),context,triageContext,sendContext,request,source,descriptor,boxes,calls,ledger,get captured(){return captured;},deny(){allowed=false;},set onSend(fn){onSend=fn;},set onWrite(fn){onWrite=fn;},set result(value){transportResult=value;},set tls(value){tls=value;},set condstore(value){condstore=value;},set move(value){move=value;},set finishLoss(value){finishLoss=value;}};
}
