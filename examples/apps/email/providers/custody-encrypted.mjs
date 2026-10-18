import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {oauthAccountKey,oauthDigest,oauthFail,oauthObject,oauthText,sameOAuthAccount,validateOAuthBinding} from './oauth-contract.mjs';
import {validateEmailScope,sameEmailScope} from '../account-registry.mjs';

const MAX_SECRET_BYTES=65536;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
/**
 * @typedef {{revision:number,value:object|null}} CustodyRow
 * @typedef {{read:()=>Promise<CustodyRow|null>,
 * compareAndSwap:(input:{expected_revision:number|null,value:object|null})=>Promise<boolean>}} CustodyTransaction
 * @typedef {{withLock:(input:{key:string},callback:(tx:CustodyTransaction)=>Promise<unknown>)=>Promise<unknown>}} EmailCustodyStore
 *
 * Persist `value` as opaque JSON: encrypted states have schema_version,
 * state_digest, binding, browser_digest, expires_at, envelope; encrypted accounts
 * have schema_version, binding, health, setup_generation, envelope. Envelope is exactly
 * {key_id,iv,tag,ciphertext}, all base64url except key_id. No plaintext tokens or
 * PKCE verifier occur in these objects. A null value is a durable replay
 * tombstone; retain the row revision rather than deleting/reusing it.
 * `compareAndSwap` commits before returning true and increases revision. The
 * cross-process lock must be fenced: an expired holder cannot read/write again.
 * Do not wrap its callback in one delayed-commit database transaction, since the
 * refresh_pending marker must survive a process crash during provider I/O.
 */
// This is server-only. The injected store must commit each CAS durably, while a
// fenced cross-process lock covers the callback, including any provider I/O.
export function createEncryptedEmailCustody({encryption_key,key_id,store,now=Date.now}){
 if(!(encryption_key instanceof Uint8Array)||encryption_key.byteLength!==32||!oauthText(key_id,64)||typeof store?.withLock!=='function'||typeof now!=='function')oauthFail('EMAIL_OAUTH_CUSTODY_CONFIG_INVALID');
 const key=Buffer.from(encryption_key);
 const aad=value=>Buffer.from(JSON.stringify(canonical(value)));
 function seal(value,context){
  const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>MAX_SECRET_BYTES)oauthFail('EMAIL_OAUTH_CUSTODY_LIMIT');
  try{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(context));const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);return {key_id,iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),ciphertext:ciphertext.toString('base64url')};}finally{bytes.fill(0);}
 }
 function open(envelope,context){
  oauthObject(envelope,['key_id','iv','tag','ciphertext'],'EMAIL_OAUTH_CUSTODY_INVALID');
  const decode=(value,limit)=>{if(!oauthText(value,limit)||!/^[A-Za-z0-9_-]+$/.test(value))oauthFail('EMAIL_OAUTH_CUSTODY_INVALID');const bytes=Buffer.from(value,'base64url');if(bytes.toString('base64url')!==value)oauthFail('EMAIL_OAUTH_CUSTODY_INVALID');return bytes;};
  let bytes;try{if(envelope.key_id!==key_id)oauthFail('EMAIL_OAUTH_CUSTODY_KEY_UNAVAILABLE');const iv=decode(envelope.iv,32),tag=decode(envelope.tag,32),ciphertext=decode(envelope.ciphertext,Math.ceil(MAX_SECRET_BYTES*4/3)+4);if(iv.length!==12||tag.length!==16||ciphertext.length>MAX_SECRET_BYTES)oauthFail('EMAIL_OAUTH_CUSTODY_INVALID');const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(aad(context));decipher.setAuthTag(tag);bytes=Buffer.concat([decipher.update(ciphertext),decipher.final()]);const result=JSON.parse(bytes.toString('utf8'));if(!result||typeof result!=='object'||Array.isArray(result))oauthFail('EMAIL_OAUTH_CUSTODY_INVALID');return result;}catch(error){if(error?.code==='EMAIL_OAUTH_CUSTODY_KEY_UNAVAILABLE')throw error;oauthFail('EMAIL_OAUTH_CUSTODY_INVALID');}finally{bytes?.fill(0);}
 }
 async function locked(key,callback){
  try{return await store.withLock({key},async tx=>{if(typeof tx?.read!=='function'||typeof tx?.compareAndSwap!=='function')oauthFail('EMAIL_OAUTH_CUSTODY_STORE_INVALID');return callback(tx);});}catch(error){if(error?.name==='EmailOAuthError')throw error;oauthFail('EMAIL_OAUTH_CUSTODY_UNAVAILABLE');}
 }
 function version(row){if(row!==null&&(!row||!Number.isSafeInteger(row.revision)||row.revision<1||!Object.hasOwn(row,'value')))oauthFail('EMAIL_OAUTH_CUSTODY_STORE_INVALID');return row?.revision??null;}
 async function write(tx,row,value){if(await tx.compareAndSwap({expected_revision:version(row),value})!==true)oauthFail('EMAIL_OAUTH_CUSTODY_CONFLICT');}
 return Object.freeze({
  async storeState({state,binding,browser_binding,expires_at,secret}){
   binding=validateOAuthBinding(binding);if(!oauthText(state,128)||!oauthText(browser_binding,1024)||!Number.isSafeInteger(expires_at)||expires_at<=now())oauthFail('EMAIL_OAUTH_STATE_INVALID');
   const state_digest=oauthDigest(state),metadata={schema_version:'deft.email_oauth_state.v1',state_digest,binding,browser_digest:oauthDigest(browser_binding),expires_at};
   await locked('email.oauth.state.'+state_digest,async tx=>{const row=await tx.read();if(row!==null)oauthFail('EMAIL_OAUTH_STATE_CONFLICT');await write(tx,row,{...metadata,envelope:seal(secret,metadata)});});
  },
  async takeState({scope,state,browser_binding}){
   try{scope=validateEmailScope(scope);}catch{oauthFail('EMAIL_OAUTH_SCOPE_DENIED');}if(!oauthText(state,128)||!oauthText(browser_binding,1024))oauthFail('EMAIL_OAUTH_STATE_INVALID');
   const state_digest=oauthDigest(state);
   return locked('email.oauth.state.'+state_digest,async tx=>{
    const row=await tx.read();version(row);const value=row?.value;if(!value)oauthFail('EMAIL_OAUTH_STATE_REPLAY');
    oauthObject(value,['schema_version','state_digest','binding','browser_digest','expires_at','envelope'],'EMAIL_OAUTH_STATE_INVALID');const binding=validateOAuthBinding(value.binding);
    if(value.schema_version!=='deft.email_oauth_state.v1'||value.state_digest!==state_digest||!sameEmailScope(scope,binding.scope)||value.browser_digest!==oauthDigest(browser_binding))oauthFail('EMAIL_OAUTH_STATE_DENIED');
    const {envelope,...metadata}=value;await write(tx,row,null);
    if(!Number.isSafeInteger(value.expires_at)||value.expires_at<=now())oauthFail('EMAIL_OAUTH_STATE_EXPIRED');
    return {binding,expires_at:value.expires_at,secret:open(envelope,metadata)};
   });
  },
  async withAccount(input,callback){
   const binding=validateOAuthBinding(input);
   return locked(oauthAccountKey(binding),async tx=>{
    let row=await tx.read();version(row);
    const api={
     read(){
      const value=row?.value;if(!value)return null;
      oauthObject(value,['schema_version','binding','health','setup_generation','envelope'],'EMAIL_OAUTH_CUSTODY_INVALID');const prior=validateOAuthBinding(value.binding);
      if(value.schema_version!=='deft.email_oauth_tokens.v1'||!sameOAuthAccount(prior,binding)||prior.authority_epoch>binding.authority_epoch||!Number.isSafeInteger(value.setup_generation)||value.setup_generation<1||!['connected','refresh_pending','reauth_required','revoked'].includes(value.health))oauthFail('EMAIL_OAUTH_CUSTODY_BINDING_DENIED');
      const {envelope,...metadata}=value,payload=open(envelope,metadata);oauthObject(payload,['credentials'],'EMAIL_OAUTH_CUSTODY_INVALID');if(!Object.hasOwn(payload,'credentials')||payload.credentials!==null&&(!payload.credentials||typeof payload.credentials!=='object'||Array.isArray(payload.credentials)))oauthFail('EMAIL_OAUTH_CUSTODY_INVALID');return {binding:prior,health:value.health,setup_generation:value.setup_generation,secret:payload.credentials};
     },
     async write({health,secret,advance_setup=false}){
      if(!['connected','refresh_pending','reauth_required','revoked'].includes(health)||health!=='revoked'&&(!secret||typeof secret!=='object')||health==='revoked'&&secret!==null&&(!secret||secret.access_token!=='discarded'||secret.refresh_token!=='discarded'||secret.expires_at!==0))oauthFail('EMAIL_OAUTH_CUSTODY_INVALID');
      if(typeof advance_setup!=='boolean')oauthFail('EMAIL_OAUTH_CUSTODY_INVALID');const current=api.read(),setup_generation=current?current.setup_generation+(advance_setup?1:0):1;if(!Number.isSafeInteger(setup_generation))oauthFail('EMAIL_OAUTH_SETUP_LIMIT');
      const metadata={schema_version:'deft.email_oauth_tokens.v1',binding,health,setup_generation};await write(tx,row,{...metadata,envelope:seal({credentials:secret},metadata)});row=await tx.read();version(row);return setup_generation;
     },
     async advanceSetup(){
      const current=api.read(),setup_generation=(current?.setup_generation??0)+1;if(!Number.isSafeInteger(setup_generation))oauthFail('EMAIL_OAUTH_SETUP_LIMIT');
      // Starting a new flow invalidates older flows without rebinding existing
      // credentials to a newer host epoch before provider verification.
      const metadata={schema_version:'deft.email_oauth_tokens.v1',binding:current?.binding??binding,health:current?.health??'revoked',setup_generation},secret=current?.secret??null;
      await write(tx,row,{...metadata,envelope:seal({credentials:secret},metadata)});row=await tx.read();version(row);return setup_generation;
     }
    };return callback(Object.freeze(api));
   });
  }
 });
}
