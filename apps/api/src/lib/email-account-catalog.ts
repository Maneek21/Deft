import {z} from 'zod';
import type {NativeEmailAccount} from './email-native-adapter-contract.js';
import {EmailMailboxError,type EmailActor,type EmailCapability,type EmailScope} from './email-mailbox-service.js';

const id=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
export type EmailAccountCatalogEntry=Readonly<{account_id:string;provider:'gmail'|'microsoft'|'imap_smtp';primary_address:string;display_label:string;capabilities:readonly string[]}>;
export type EmailAccountCatalog=Readonly<{accounts:EmailAccountCatalogEntry[];has_more:boolean;unavailable_count:number}>;
type Ports={
  listCandidates(orgId:string,ownerId:string,limit:number,signal?:AbortSignal):Promise<string[]>;
  inspect(actor:EmailActor,scope:EmailScope,signal?:AbortSignal):Promise<{capability:EmailCapability;account:NativeEmailAccount}>;
  current(actor:EmailActor,scope:EmailScope,signal?:AbortSignal):Promise<EmailCapability>;
};

/** Owner mailbox discovery. Candidate IDs never authorize content; each visible
 * identity has a current connected-account check and a final per-account check.
 * One disconnected mailbox does not hide the owner's healthy accounts. */
export class EmailAccountCatalogService{
  constructor(private readonly ports:Ports,private readonly now=Date.now){}
  async list(actor:EmailActor,orgId:string,signal?:AbortSignal):Promise<EmailAccountCatalog>{
    id.parse(orgId);id.parse(actor.user_id);id.parse(actor.web_session_id);
    const live=()=>{signal?.throwIfAborted();if(!Number.isFinite(actor.access_expires_at)||actor.access_expires_at<=this.now())throw new EmailMailboxError('EMAIL_ACCESS_DENIED');};
    live();const candidates=await this.ports.listCandidates(orgId,actor.user_id,17,signal);live();
    if(candidates.length>17||new Set(candidates).size!==candidates.length||candidates.some(value=>!id.safeParse(value).success))throw new EmailMailboxError('EMAIL_PAGE_INVALID');
    const entries:{entry:EmailAccountCatalogEntry;scope:EmailScope;capability:EmailCapability}[]=[];let unavailable_count=0;
    const selected=candidates.slice(0,16);
    // Three independent accounts may check provider custody concurrently. Keep
    // output in catalogue order and preserve every final authority check.
    const discovered=new Map<string,(typeof entries)[number]>();let next=0;
    await Promise.all(Array.from({length:Math.min(3,selected.length)},async()=>{
     while(next<selected.length){const account_id=selected[next++]!;
      live();const scope={org_id:orgId,owner_user_id:actor.user_id,account_id};
      try{
        const {account,capability}=await this.ports.inspect(actor,scope,signal);live();
        if(account.account_id!==account_id||!['gmail','microsoft','imap_smtp'].includes(account.provider)
          ||!id.safeParse(account.primary_address).success||typeof account.display_label!=='string'||account.display_label.length>256
          ||/[\u0000-\u001f\u007f]/u.test(account.display_label))throw new EmailMailboxError('EMAIL_PAGE_INVALID');
        discovered.set(account_id,{scope,capability,entry:{account_id,provider:account.provider,primary_address:account.primary_address,display_label:account.display_label,capabilities:[...account.capabilities]}});
      }catch(error){live();if(error instanceof EmailMailboxError&&error.code==='EMAIL_PAGE_INVALID')throw error;unavailable_count++;}
    }
    }));
    for(const accountId of selected){const entry=discovered.get(accountId);if(entry)entries.push(entry);}
    const accounts:EmailAccountCatalogEntry[]=[];
    for(const row of entries){
      try{const current=await this.ports.current(actor,row.scope,signal);live();
        if(current.authority_version!==row.capability.authority_version||current.resource_binding_id!==row.capability.resource_binding_id
          ||current.scope.org_id!==orgId||current.scope.owner_user_id!==actor.user_id||current.scope.account_id!==row.scope.account_id
          ||!Number.isFinite(current.expires_at)||current.expires_at<=this.now())throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
        accounts.push(row.entry);
      }catch{live();unavailable_count++;}
    }
    live();return {accounts,has_more:candidates.length>16,unavailable_count};
  }
}
