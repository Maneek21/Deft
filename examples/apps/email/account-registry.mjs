import {singleAddress} from './account-config.mjs';

const fail=code=>{throw Error(code);};
const text=(value,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\r\n\0]/.test(value);
export const EMAIL_ACCOUNT_CAPABILITIES=Object.freeze(['read','search','thread','send','modify','permanent_delete']);
export function validateEmailScope(scope){
 if(!scope||Object.keys(scope).sort().join(',')!=='installation_id,org_id,owner_id'||Object.values(scope).some(value=>!text(value)))fail('EMAIL_ACCOUNT_SCOPE_INVALID');
 return Object.freeze({org_id:scope.org_id,owner_id:scope.owner_id,installation_id:scope.installation_id});
}
export const sameEmailScope=(a,b)=>a?.org_id===b.org_id&&a?.owner_id===b.owner_id&&a?.installation_id===b.installation_id;
export function validateEmailAccount(value){
 const keys=['account_id','provider','display_label','primary_address','verified_sender_identities','capabilities','connection_target','resource_binding_id','action_binding_id','authority_epoch','health'];
 if(!value||Object.keys(value).some(key=>!keys.includes(key))||!['gmail','microsoft','imap_smtp'].includes(value.provider)||!['connected','reauth_required','revoked','unavailable'].includes(value.health)||!Number.isSafeInteger(value.authority_epoch)||value.authority_epoch<1||['account_id','display_label','connection_target','resource_binding_id'].some(key=>!text(value[key]))||!singleAddress(value.primary_address))fail('EMAIL_ACCOUNT_INVALID');
 if(!Array.isArray(value.verified_sender_identities)||value.verified_sender_identities.length>32||value.verified_sender_identities.some(address=>!singleAddress(address))||new Set(value.verified_sender_identities.map(address=>address.toLowerCase())).size!==value.verified_sender_identities.length||!Array.isArray(value.capabilities)||value.capabilities.length>EMAIL_ACCOUNT_CAPABILITIES.length||value.capabilities.some(capability=>!EMAIL_ACCOUNT_CAPABILITIES.includes(capability))||new Set(value.capabilities).size!==value.capabilities.length)fail('EMAIL_ACCOUNT_INVALID');
 if(value.capabilities.some(capability=>['modify','permanent_delete'].includes(capability))&&!text(value.action_binding_id))fail('EMAIL_ACCOUNT_INVALID');
 if(value.capabilities.includes('send')?(!text(value.action_binding_id)||value.verified_sender_identities.length===0):(value.action_binding_id!==null&&!text(value.action_binding_id)))fail('EMAIL_ACCOUNT_INVALID');
 return structuredClone(value);
}

// Descriptors enter only from trusted host connection custody. Caller IDs nominate
// accounts; authorize rederives current host authority for every resolution.
export class EmailAccountRegistry {
 #scope;#accounts=new Map();#authorize;
 constructor({scope,authorize,state=null}){this.#scope=validateEmailScope(scope);if(typeof authorize!=='function')fail('EMAIL_ACCOUNT_AUTHORITY_REQUIRED');this.#authorize=authorize;if(state!==null){if(state.schema_version!=='deft.email_accounts.v1'||!sameEmailScope(state.scope,this.#scope)||!Array.isArray(state.accounts)||state.accounts.length>32)fail('EMAIL_ACCOUNT_STATE_INVALID');for(const input of state.accounts){const account=validateEmailAccount(input);if(this.#accounts.has(account.account_id))fail('EMAIL_ACCOUNT_STATE_INVALID');this.#accounts.set(account.account_id,account);}}}
 #check(scope){if(!sameEmailScope(scope,this.#scope))fail('EMAIL_ACCOUNT_SCOPE_DENIED');}
 register(scope,input){
  this.#check(scope);const account=validateEmailAccount(input),prior=this.#accounts.get(account.account_id);
  if(!prior&&this.#accounts.size>=32)fail('EMAIL_ACCOUNT_LIMIT');
  if(prior&&(account.authority_epoch<=prior.authority_epoch||['provider','connection_target'].some(key=>prior[key]!==account[key])))fail('EMAIL_ACCOUNT_REPLACEMENT_INVALID');
  this.#accounts.set(account.account_id,account);return this.view(scope,account.account_id);
 }
 view(scope,id){this.#check(scope);const account=this.#accounts.get(id);if(!account)fail('EMAIL_ACCOUNT_NOT_FOUND');const {connection_target,resource_binding_id,action_binding_id,authority_epoch,...view}=account;return structuredClone(view);}
 list(scope){this.#check(scope);return [...this.#accounts.keys()].map(id=>this.view(scope,id));}
 revoke(scope,id){this.#check(scope);const account=this.#accounts.get(id);if(!account)fail('EMAIL_ACCOUNT_NOT_FOUND');account.health='revoked';account.authority_epoch++;}
 async resolve(scope,id,operation){
  this.#check(scope);const account=this.#accounts.get(id);if(!account)fail('EMAIL_ACCOUNT_NOT_FOUND');
  if(!EMAIL_ACCOUNT_CAPABILITIES.includes(operation)||!account.capabilities.includes(operation))fail('EMAIL_ACCOUNT_CAPABILITY_DENIED');
  if(account.health!=='connected')fail(account.health==='revoked'?'EMAIL_ACCOUNT_REVOKED':'EMAIL_ACCOUNT_REAUTH_REQUIRED');
  const epoch=account.authority_epoch;
  let allowed=false;try{allowed=await this.#authorize({scope:{...this.#scope},account:structuredClone(account),operation});}catch{}
  if(allowed!==true||this.#accounts.get(id)!==account||account.health!=='connected'||account.authority_epoch!==epoch)fail('EMAIL_ACCOUNT_AUTHORITY_DENIED');
  return structuredClone(account);
 }
 exportState(scope){this.#check(scope);return {schema_version:'deft.email_accounts.v1',scope:{...this.#scope},accounts:[...this.#accounts.values()].map(account=>structuredClone(account))};}
}
