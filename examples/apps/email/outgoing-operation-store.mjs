import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';

const validProviderReceipt=value=>value&&typeof value==='object'&&!Array.isArray(value)
 &&Object.keys(value).sort().join(',')==='provider,provider_message_id'
 &&['gmail','microsoft'].includes(value.provider)
 &&(value.provider==='microsoft'&&value.provider_message_id===null||typeof value.provider_message_id==='string'
 &&value.provider_message_id.length>0&&value.provider_message_id.length<=2048
 &&!/[\u0000-\u001f\u007f]/u.test(value.provider_message_id));
const fail=()=>{throw Error('EMAIL_SEND_JOURNAL_UNAVAILABLE');};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const json=value=>JSON.stringify(canonical(value));
const same=(left,right)=>json(left)===json(right);
const hash=value=>createHash('sha256').update(value).digest('hex');

/** Durable independent Send phases. CAS is acknowledged only after the backing
 * store commits; neither process restart nor uncertain provider response reopens it. */
export function createEmailSendJournal({store,encryption_key,key_id}){
 if(typeof store?.withLock!=='function'||!(encryption_key instanceof Uint8Array)||encryption_key.byteLength!==32
  ||typeof key_id!=='string'||!key_id||key_id.length>64)fail();
 const key=Buffer.from(encryption_key);
 const locator=identity=>{if(!identity||typeof identity.operation_id!=='string'||!/^mail-[0-9a-f-]{36}$/i.test(identity.operation_id)
   ||!identity.scope||Object.values(identity.scope).some(value=>typeof value!=='string'||!value))fail();
  return hash(json({scope:identity.scope,operation_id:identity.operation_id}));};
 const base=identity=>Object.fromEntries(['operation_id','snapshot_id','snapshot_digest','mime_digest','scope','account_id','authority_epoch','draft_id','draft_revision'].map(key=>[key,identity[key]]));
 function seal(payload,digest){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('deft.email_send_operation.v1:'+digest));
  const bytes=Buffer.from(json(payload));if(bytes.length>16384)fail();try{
   const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);
   return {key_id,iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),ciphertext:ciphertext.toString('base64url')};
  }finally{bytes.fill(0);}}
 function open(value,digest){try{if(value?.schema_version!=='deft.email_send_operation.v1'||value.operation_digest!==digest||value.envelope?.key_id!==key_id)fail();
   const envelope=value.envelope,iv=Buffer.from(envelope.iv,'base64url'),tag=Buffer.from(envelope.tag,'base64url'),bytes=Buffer.from(envelope.ciphertext,'base64url');
   if(iv.length!==12||tag.length!==16||bytes.length>16384)fail();const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from('deft.email_send_operation.v1:'+digest));decipher.setAuthTag(tag);
   const plain=Buffer.concat([decipher.update(bytes),decipher.final()]);try{const result=JSON.parse(plain.toString());if(!['reserved','provider_started','accepted','unknown'].includes(result.state))fail();return result;}finally{plain.fill(0);}
  }catch{fail();}}
 async function change(identity,fn){const digest=locator(identity),owned=structuredClone(identity);
  return store.withLock({key:'email.send.operation.'+digest},async tx=>{const row=await tx.read();
   if(row!==null&&(!Number.isSafeInteger(row.revision)||row.revision<1))fail();const prior=row===null?null:open(row.value,digest);
   if(prior&&!same(base(prior.identity),base(owned)))fail();
   return fn(prior,async value=>{if(await tx.compareAndSwap({expected_revision:row?.revision??null,
    value:{schema_version:'deft.email_send_operation.v1',operation_digest:digest,envelope:seal(value,digest)}})!==true)fail();},owned);
  });
 }
 return Object.freeze({
  reserve:identity=>change(identity,async(prior,write,owned)=>{if(prior)return 'replay';await write({identity:owned,state:'reserved'});return 'reserved';}),
  reserveTransport:identity=>change(identity,async(prior,write,owned)=>{if(prior?.state!=='reserved')return false;await write({identity:owned,state:'provider_started'});return true;}),
  recordOutcome:({identity,state,output,provider_receipt})=>change(identity,async(prior,write,owned)=>{
   if(!prior||!same(prior.identity,owned)||!['accepted','unknown'].includes(state))return false;
   if(provider_receipt!==undefined&&(state!=='accepted'||!validProviderReceipt(provider_receipt)))return false;
   if(prior.state==='accepted')return state==='accepted'&&same(prior.output,output)&&same(prior.provider_receipt,provider_receipt);
   if(!['provider_started','unknown'].includes(prior.state)||prior.state==='unknown'&&state==='accepted')return false;
   if(state==='accepted'&&(!output||output.operation_id!==owned.operation_id||output.transport_outcome!=='provider_accepted'||output.sent_copy_outcome!=='pending'))return false;
   await write({identity:owned,state,...(state==='accepted'?{output,...(provider_receipt!==undefined?{provider_receipt}: {})}: {})});return true;
  }),
  readOutcome:identity=>change(identity,async prior=>prior&&same(prior.identity,identity)?structuredClone(prior):{identity:structuredClone(identity),state:'unknown'}),
 });
}
