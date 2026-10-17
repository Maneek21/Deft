import {LogicalMailIndex,validateProviderLocator} from '../logical-mail-index.mjs';
import {resolveProviderSource} from './provider-browser.mjs';
import {fail,digest} from './contract.mjs';
/** Only a host callback backed by encrypted, succeeded MOVE journal evidence
 * can rebind an IMAP UID. Equal headers, subjects or Message-ID never do so. */
export async function resolveNativeImapSource({scope,account,source,aliases,check}){
 await check();
 if(source?.provider!=='imap_smtp'||!aliases?.lookup)return resolveProviderSource({scope,account,source});
 const locator=validateProviderLocator(source.locator),proof=await aliases.lookup(locator);await check();
 if(!proof)return resolveProviderSource({scope,account,source});
 const fields=['schema_version','provider_scope','account_id','logical_message_id','conversation_id','base_locator','current_locator','operation_id'];
 if(Object.keys(proof).sort().join(',')!==fields.sort().join(',')||proof.schema_version!=='deft.email_imap_alias.v1'
  ||proof.provider_scope?.org_id!==scope.org_id||proof.provider_scope?.owner_id!==scope.owner_id||proof.account_id!==account.account_id
  ||proof.logical_message_id!==source.logical_message_id||proof.conversation_id!==source.conversation_id
  ||digest(validateProviderLocator(proof.current_locator))!==digest(locator)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(proof.operation_id??''))fail('EMAIL_CONNECTION_RESOURCE_DENIED');
 const base=validateProviderLocator(proof.base_locator),current=validateProviderLocator(proof.current_locator);
 if(base.kind!=='imap_smtp'||current.kind!=='imap_smtp')fail('EMAIL_CONNECTION_RESOURCE_DENIED');
 const original={...source,locator:base};resolveProviderSource({scope:proof.provider_scope,account,source:original});
 const index=new LogicalMailIndex(proof.provider_scope),parent=index.upsert(proof.provider_scope,{account_id:account.account_id,provider:'imap_smtp',locator:base});
 if(digest(base)!==digest(current))index.recordMove(proof.provider_scope,{account_id:account.account_id,logical_message_id:parent.logical_message_id,from_locator:base,to_locator:current,evidence:{kind:'provider_move',operation_id:proof.operation_id}});
 const resolved=index.get(proof.provider_scope,account.account_id,parent.logical_message_id);await check();return resolved;
}
