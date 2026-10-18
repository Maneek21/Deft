import {createHash} from 'node:crypto';
import {validateEmailScope, sameEmailScope, EMAIL_ACCOUNT_CAPABILITIES} from '../account-registry.mjs';

export class EmailOAuthError extends Error {
 constructor(code,{outcome='no_effect'}={}){super(code);this.name='EmailOAuthError';this.code=code;this.outcome=outcome;}
}
export const oauthFail=(code,options)=>{throw new EmailOAuthError(code,options);};
export const oauthText=(value,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\r\n\0]/.test(value);
export function oauthObject(value,keys,code='EMAIL_OAUTH_INPUT_INVALID'){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))oauthFail(code);
}
export const oauthDigest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function validateOAuthBinding(input){
 oauthObject(input,['scope','account_id','provider','connection_target','resource_binding_id','action_binding_id','authority_epoch','capabilities'],'EMAIL_OAUTH_BINDING_INVALID');
 let scope;try{scope=validateEmailScope(input.scope);}catch{oauthFail('EMAIL_OAUTH_BINDING_INVALID');}
 if(!['gmail','microsoft'].includes(input.provider)||['account_id','connection_target','resource_binding_id'].some(key=>!oauthText(input[key]))||!Number.isSafeInteger(input.authority_epoch)||input.authority_epoch<1||!Array.isArray(input.capabilities)||input.capabilities.length<1||input.capabilities.length>EMAIL_ACCOUNT_CAPABILITIES.length||input.capabilities.some(item=>!EMAIL_ACCOUNT_CAPABILITIES.includes(item))||new Set(input.capabilities).size!==input.capabilities.length||input.capabilities.some(item=>['send','modify','permanent_delete'].includes(item))&&!oauthText(input.action_binding_id)||input.action_binding_id!==null&&!oauthText(input.action_binding_id))oauthFail('EMAIL_OAUTH_BINDING_INVALID');
 return Object.freeze({scope,account_id:input.account_id,provider:input.provider,connection_target:input.connection_target,resource_binding_id:input.resource_binding_id,action_binding_id:input.action_binding_id,authority_epoch:input.authority_epoch,capabilities:[...input.capabilities]});
}
export function sameOAuthAccount(a,b){return sameEmailScope(a.scope,b.scope)&&['account_id','provider','connection_target'].every(key=>a[key]===b[key]);}
export const sameOAuthBinding=(a,b)=>sameOAuthAccount(a,b)&&['resource_binding_id','action_binding_id','authority_epoch'].every(key=>a[key]===b[key])&&a.capabilities.length===b.capabilities.length&&a.capabilities.every(item=>b.capabilities.includes(item));
export const oauthAccountKey=binding=>'email.oauth.account.'+oauthDigest([binding.scope.org_id,binding.scope.owner_id,binding.scope.installation_id,binding.account_id,binding.provider,binding.connection_target]);
