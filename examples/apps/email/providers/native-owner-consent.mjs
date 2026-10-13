import {fail} from './contract.mjs';
/** Host-only owner consent narrows the descriptor, never its immutable custody
 * binding or credential identity. Absence preserves reviewed legacy behavior. */
export function nativeOwnerCapabilities(context,{inspection=false}={}){
 if(context.lifecycle_inspect!==undefined&&(!inspection||context.lifecycle_inspect!==true))fail('EMAIL_NATIVE_AUTHORITY_DENIED');
 const caps=context.owner_capabilities;
 if(caps!==undefined&&(!Array.isArray(caps)||!caps.length||caps.length>3||new Set(caps).size!==caps.length||!caps.includes('read')||caps.some(cap=>!['read','modify','send'].includes(cap))))fail('EMAIL_NATIVE_AUTHORITY_DENIED');
 return caps;
}
export function narrowNativeAccount(account,context,options){
 const caps=nativeOwnerCapabilities(context,options);if(caps===undefined)return account;
 return {...account,capabilities:account.capabilities.filter(cap=>['search','thread'].includes(cap)?caps.includes('read'):caps.includes(cap))};
}
