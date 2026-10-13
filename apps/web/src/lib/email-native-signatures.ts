import {parseNativeSafeComposeHtml as parseSafeComposeHtml} from '../../../../packages/app-kit/src/safe-compose-html';

export type NativeSignatureEntry={address:string;plain:string;html:string;placement:'new'|'reply'|'both'|'none'};
export type NativeSignaturePreferences={account_id:string;revision:number;preferences:{identities:NativeSignatureEntry[]};identity_availability:{available:{address:string;identity_key:string}[]|null;saved:{address:string;identity_key:string;current:boolean}[]}};
export type NativeSignatureState={status:'loading'|'ready'|'failed'|'denied';saved:NativeSignaturePreferences|null;entry:NativeSignatureEntry|null;dirty:boolean;busy:boolean;uncertain:boolean;conflict:boolean;notice:string};
export const emptyNativeSignatureState=():NativeSignatureState=>({status:'loading',saved:null,entry:null,dirty:false,busy:false,uncertain:false,conflict:false,notice:'Loading signature preferences…'});
const normalize=(address:string)=>address.trim().toLocaleLowerCase('en-US');
const closed=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const address=(value:unknown):value is string=>typeof value==='string'&&value.length<=320&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
const identifier=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export class NativeSignatureError extends Error{constructor(readonly kind:'invalid'|'denied'|'conflict'|'unavailable'){super(kind==='invalid'?'Keep the signature within its limits and check its formatting.':kind==='denied'?'Signature access changed. Reconnect this account in Email settings.':kind==='conflict'?'Signature preferences changed elsewhere. Your edits are kept here.':'The saved signature could not be confirmed. Your edits are kept here.');}}
export function parseNativeSignatureEntry(raw:unknown):NativeSignatureEntry{
 const fail=():never=>{throw new NativeSignatureError('invalid');};
 if(!closed(raw,['address','plain','html','placement'])||!address(raw.address)||typeof raw.plain!=='string'||raw.plain.length>2048||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(raw.plain)||typeof raw.html!=='string'||raw.html.length>16384||!['new','reply','both','none'].includes(String(raw.placement)))return fail();
 if(raw.html){try{if(!raw.plain||parseSafeComposeHtml(raw.html,{maxCharacters:16384,maxBytes:65536}).plainText!==raw.plain)return fail();}catch{return fail();}}
 return {...raw} as NativeSignatureEntry;
}
export function parseNativeSignaturePreferences(raw:unknown,accountId:string):NativeSignaturePreferences{
 const fail=():never=>{throw new NativeSignatureError('unavailable');};
 if(!closed(raw,['account_id','revision','preferences','identity_availability'])||raw.account_id!==accountId||typeof raw.revision!=='number'||!Number.isSafeInteger(raw.revision)||raw.revision<0||raw.revision>2147483647||!closed(raw.preferences,['identities'])||!Array.isArray(raw.preferences.identities)||raw.preferences.identities.length>32||!closed(raw.identity_availability,['available','saved']))return fail();
 let identities:NativeSignatureEntry[];try{identities=raw.preferences.identities.map(parseNativeSignatureEntry);}catch{return fail();}
 if(new Set(identities.map(item=>normalize(item.address))).size!==identities.length||new TextEncoder().encode(JSON.stringify({identities})).byteLength>65536)return fail();
 const available=raw.identity_availability.available,saved=raw.identity_availability.saved;
 const identity=(value:unknown,keys:string[])=>closed(value,keys)&&address(value.address)&&typeof value.identity_key==='string'&&/^[a-f0-9]{64}$/u.test(value.identity_key);
 if(!(available===null||Array.isArray(available)&&available.length<=32&&available.every(item=>identity(item,['address','identity_key'])))||!Array.isArray(saved)||saved.length!==identities.length||saved.some(item=>!identity(item,['address','identity_key','current'])||typeof item.current!=='boolean'))return fail();
 const verified=available as NativeSignaturePreferences['identity_availability']['available'],retained=saved as NativeSignaturePreferences['identity_availability']['saved'];
 if(verified&&(new Set(verified.map(item=>normalize(item.address))).size!==verified.length||new Set(verified.map(item=>item.identity_key)).size!==verified.length))return fail();
 if(retained.some((item,index)=>normalize(item.address)!==normalize(identities[index]!.address)||item.current!==!!verified?.some(value=>normalize(value.address)===normalize(item.address)&&value.identity_key===item.identity_key)))return fail();
 return {account_id:accountId,revision:raw.revision,preferences:{identities},identity_availability:{available:verified?structuredClone(verified):null,saved:structuredClone(retained)}};
}
type Fetch=(path:string,init:RequestInit)=>Promise<Response>;
export function createNativeSignatureApi(options:{fetch:Fetch;current:()=>boolean}){
 const lifetime=new AbortController();
 const request=async(accountId:string,patch?:{expected_revision:number;identities:NativeSignatureEntry[]})=>{
  if(!identifier(accountId))throw new NativeSignatureError('invalid');if(!options.current()||lifetime.signal.aborted)throw new NativeSignatureError('denied');
  const signal=AbortSignal.any([lifetime.signal,AbortSignal.timeout(15000)]);
  const response=await options.fetch(`/api/email/accounts/${encodeURIComponent(accountId)}/signatures`,{method:patch?'PUT':'GET',cache:'no-store',signal,...(patch?{headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)}:{})});
  if(!options.current()||signal.aborted){await response.body?.cancel();throw new NativeSignatureError(options.current()?'unavailable':'denied');}
  if(!response.ok){await response.body?.cancel();throw new NativeSignatureError([401,403].includes(response.status)?'denied':response.status===409?'conflict':[400,413].includes(response.status)?'invalid':'unavailable');}
  if(!response.body)throw new NativeSignatureError('unavailable');const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let text='',size=0;
  const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{for(;;){signal.throwIfAborted();const part=await reader.read();signal.throwIfAborted();if(part.done)break;size+=part.value.byteLength;if(size>131072)throw new NativeSignatureError('unavailable');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();if(!options.current())throw new NativeSignatureError('denied');return parseNativeSignaturePreferences(JSON.parse(text),accountId);}
  finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
 };
 return {read:(accountId:string)=>request(accountId),save:(accountId:string,revision:number,entry:NativeSignatureEntry)=>{
  const identities=[parseNativeSignatureEntry(entry)];if(!Number.isSafeInteger(revision)||revision<0||revision>2147483646||new TextEncoder().encode(JSON.stringify({identities})).byteLength>65536)throw new NativeSignatureError('invalid');return request(accountId,{expected_revision:revision,identities});
 },dispose:()=>lifetime.abort()};
}
export function createNativeSignatureSettings(options:{accountId:string;primaryAddress:string;fetch:Fetch;current:()=>boolean;change:(state:NativeSignatureState)=>void}){
 const client=createNativeSignatureApi(options);let active=true,state=emptyNativeSignatureState(),selectedAddress=options.primaryAddress,attempt:{revision:number;entry:NativeSignatureEntry}|null=null;
 const current=()=>active&&options.current(),emit=()=>{if(current())options.change(structuredClone(state));};
 const editable=(row:NativeSignaturePreferences)=>row.identity_availability.available?.find(item=>normalize(item.address)===normalize(selectedAddress));
 const entryFor=(row:NativeSignaturePreferences)=>{const identity=editable(row);return identity?structuredClone(row.preferences.identities.find(item=>normalize(item.address)===normalize(identity.address))??{address:identity.address,plain:'',html:'',placement:'none' as const}):null;};
 const publish=(row:NativeSignaturePreferences,notice='')=>{state={status:'ready',saved:row,entry:entryFor(row),dirty:false,busy:false,uncertain:false,conflict:false,notice};attempt=null;emit();};
 const deny=()=>{state={...emptyNativeSignatureState(),status:'denied',notice:new NativeSignatureError('denied').message};emit();active=false;client.dispose();};
 const error=(raw:unknown)=>raw instanceof NativeSignatureError?raw:new NativeSignatureError('unavailable');
 return {
  async load(discard=false){if(!current()||state.busy||state.dirty&&!discard||state.uncertain&&!discard||state.conflict&&!discard)return;state.busy=true;emit();try{const row=await client.read(options.accountId);if(current())publish(row);}catch(raw){if(current()){const failure=error(raw);if(failure.kind==='denied')deny();else{state.busy=false;state.status=state.saved?'ready':'failed';state.notice=failure.message;emit();}}}},
  select(address:string){if(!current()||state.status!=='ready'||state.busy||state.dirty||state.uncertain||state.conflict||!state.saved||!state.saved.identity_availability.available?.some(item=>normalize(item.address)===normalize(address)))return;selectedAddress=address;state.entry=entryFor(state.saved);state.notice='';emit();},
  edit(entry:NativeSignatureEntry){if(!current()||state.status!=='ready'||state.busy||state.uncertain||state.conflict||!state.entry||!state.saved||normalize(entry.address)!==normalize(state.entry.address))return;state.entry=structuredClone(entry);state.dirty=JSON.stringify(entry)!==JSON.stringify(entryFor(state.saved));state.notice='';emit();},
  async save(){if(!current()||state.busy||state.uncertain||state.conflict||!state.dirty||!state.entry||!state.saved)return;let entry:NativeSignatureEntry;try{entry=parseNativeSignatureEntry(state.entry);}catch(raw){state.notice=error(raw).message;emit();return;}
   const pending={revision:state.saved.revision,entry};attempt=pending;state.busy=true;state.notice='Saving signature preferences…';emit();try{const row=await client.save(options.accountId,pending.revision,entry);if(!current())return;
    const saved=entryFor(row);if(row.revision!==pending.revision+1||!saved||JSON.stringify(saved)!==JSON.stringify(entry))throw new NativeSignatureError('unavailable');publish(row,'Signature preferences saved. Existing drafts are unchanged.');
   }catch(raw){if(current()){const failure=error(raw);if(failure.kind==='denied')deny();else{state.busy=false;state.conflict=failure.kind==='conflict';state.uncertain=!['invalid','conflict'].includes(failure.kind);state.notice=failure.message;emit();}}}},
  async check(){if(!current()||state.busy||!state.uncertain||!attempt)return;const pending=attempt;state.busy=true;emit();try{const row=await client.read(options.accountId);if(!current())return;const saved=entryFor(row);
    if(row.revision>pending.revision&&saved&&JSON.stringify(saved)===JSON.stringify(pending.entry))publish(row,'Saved signature preferences confirmed. Existing drafts are unchanged.');
    else{state.busy=false;state.conflict=true;state.uncertain=false;state.notice='The saved signature differs from this change. Your edits are kept here. Reload to discard them and use the saved version.';emit();}
   }catch(raw){if(current()){const failure=error(raw);if(failure.kind==='denied')deny();else{state.busy=false;state.notice=failure.message;emit();}}}},
  dispose(){active=false;client.dispose();state=emptyNativeSignatureState();attempt=null;},snapshot:()=>structuredClone(state)
 };
}
