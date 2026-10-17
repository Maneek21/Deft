import {parseMailboxList} from '../../../../packages/app-kit/src/mailbox-list.js';
import type {EmailActor,EmailScope} from './email-mailbox-service.js';
import type {EmailRecipientContacts} from './email-recipient-assistance.js';
import type {ModuleInstallationView,ModuleRecordPage} from './module-service.js';
type Ports={list(actor:EmailActor,scope:EmailScope):Promise<ModuleInstallationView[]>;query(actor:EmailActor,scope:EmailScope,input:{module_id:string;collection_key:string;search:string;filters:[];limit:number}):Promise<ModuleRecordPage>};
/** Reuse the installed module's governed record API. Identity is the verified
 * manifest ID and semantic schema, never the sidebar title or a browser slug. */
export class GovernedEmailRecipientContacts implements EmailRecipientContacts{
 constructor(private readonly ports:Ports){}
 async search(actor:EmailActor,scope:EmailScope,input:{query:string;limit:number},signal?:AbortSignal){
  signal?.throwIfAborted();const installed=await this.ports.list(actor,scope);signal?.throwIfAborted();
  const matches=installed.filter(m=>m.enabled&&m.module_id==='com.deft.contacts'&&m.manifest.id==='com.deft.contacts');
  if(!matches.length)return {items:[],status:'not_installed' as const,has_more:false};if(matches.length!==1)throw Error('CONTACTS_AMBIGUOUS');const selected=matches[0]!;
  const collection=selected.manifest.collections.find(c=>c.key==='contacts'),email=collection?.fields.find(f=>f.key==='email'&&f.type==='email'),name=collection?.fields.find(f=>f.key==='name'&&f.type==='text');
  if(!collection||!email||!name||collection.search?.title_field!=='name'||!collection.search.fields.includes('email'))throw Error('CONTACTS_SCHEMA_UNAVAILABLE');
  const page=await this.ports.query(actor,scope,{module_id:selected.module_id,collection_key:collection.key,search:input.query,filters:[],limit:Math.min(input.limit,20)});signal?.throwIfAborted();
  if(!Array.isArray(page.records)||page.records.length>Math.min(input.limit,20)||page.records.some(record=>record.installation_id!==selected.id||record.module_id!==selected.module_id||record.collection_key!==collection.key||record.manifest_digest!==selected.manifest_digest))throw Error('CONTACTS_SCOPE');
  const final=(await this.ports.list(actor,scope)).find(m=>m.id===selected.id);signal?.throwIfAborted();
  if(!final?.enabled||final.module_id!==selected.module_id||final.active_version_id!==selected.active_version_id||final.manifest_digest!==selected.manifest_digest)throw Error('CONTACTS_AUTHORITY_CHANGED');
  const items:{address:string;name:string}[]=[];for(const record of page.records){try{const address=record.data.email,label=record.data.name;if(typeof address!=='string'||typeof label!=='string')continue;const parsed=parseMailboxList(address,{maxItems:1})[0]!;if(parsed.displayName)continue;items.push({address:parsed.address,name:label});}catch{/* Never infer an email from other fields. */}}
  return {items,status:'available' as const,has_more:page.next_cursor!==null};
 }
}
