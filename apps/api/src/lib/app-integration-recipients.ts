import {z} from 'zod';
import type {AppIntegrationSourceCaller} from './app-integration-source.js';
const Input=z.strictObject({query:z.string().trim().min(1).max(240).refine(v=>!/[\x00-\x1f\x7f]/u.test(v)),limit:z.number().int().min(1).max(10)});
const Item=z.strictObject({address:z.email().max(320),name:z.string().max(512),provenance:z.tuple([z.literal('recent')]),accepted_at:z.iso.datetime()});
export const AppIntegrationRecentRecipientsSchema=z.strictObject({schema_version:z.literal('email.recipient_suggestions.v1'),items:z.array(Item).max(10),recent_status:z.enum(['available','unavailable']),partial:z.literal(true),has_more:z.boolean()}).refine(v=>v.recent_status==='available'||v.items.length===0);
type CurrentAccount=Readonly<{identity:string;expires_at:number}>;
export function createAppIntegrationRecipientAssistance(ports:{current(caller:AppIntegrationSourceCaller):Promise<CurrentAccount>;contacts(caller:AppIntegrationSourceCaller,input:z.infer<typeof Input>,signal?:AbortSignal):Promise<{items:{address:string;name:string}[];status:'available'|'unavailable'|'not_installed';has_more:boolean}>;recent(caller:AppIntegrationSourceCaller,input:z.infer<typeof Input>,signal?:AbortSignal):Promise<unknown>;clock?:()=>number}){
 const now=ports.clock??Date.now;
 return {async suggest(caller:AppIntegrationSourceCaller,raw:unknown,signal?:AbortSignal){
  const input=Input.parse(raw);if(caller.kind!=='human')throw Error('APP_INTEGRATION_RECIPIENT_ACCESS_DENIED');
  const check=async(expected?:CurrentAccount)=>{signal?.throwIfAborted();const value=await ports.current(caller);if(!value.identity||!Number.isFinite(value.expires_at)||value.expires_at<=now()||expected&&expected.identity!==value.identity)throw Error('APP_INTEGRATION_RECIPIENT_ACCESS_DENIED');return value;};
  const initial=await check(),contacts=await ports.contacts(caller,input,signal);if(contacts.items.length>20||contacts.status!=='available'&&contacts.items.length>0)throw Error('APP_INTEGRATION_RECIPIENT_RESULT_DENIED');await check(initial);
  // Unavailable is returned explicitly by the signed Runtime wrapper; transport
  // failure is never silently converted into a successful empty read.
  const recent=AppIntegrationRecentRecipientsSchema.parse(await ports.recent(caller,input,signal));await check(initial);
  const items:{address:string;name:string;provenance:('contacts'|'recent')[]}[]=[];
  for(const [rows,provenance]of [[contacts.items,'contacts'],[recent.items,'recent']] as const)for(const item of rows){const valid=z.strictObject({address:z.email().max(320),name:z.string().max(512)}).parse({address:item.address,name:item.name});const old=items.find(v=>v.address.toLowerCase()===valid.address.toLowerCase());if(old){if(!old.provenance.includes(provenance))old.provenance.push(provenance);}else items.push({...valid,provenance:[provenance]});}
  await check(initial);return {items:items.slice(0,input.limit),sources:{contacts:contacts.status,recent:recent.recent_status},partial:true,has_more:contacts.has_more||recent.has_more||items.length>input.limit};
 }};
}
