import type {AppNavigationItem} from './app-navigation';
export type NativeEmailAvailability=Readonly<{available:boolean;legacy_installation_ids:readonly string[]}>;
export const unavailableNativeEmail:NativeEmailAvailability=Object.freeze({available:false,legacy_installation_ids:Object.freeze([])});
export function parseNativeEmailAvailability(value:unknown):NativeEmailAvailability{
 if(!value||typeof value!=='object'||Array.isArray(value))return unavailableNativeEmail;
 const row=value as Record<string,unknown>;
 if(Object.keys(row).length!==2||typeof row.available!=='boolean'||!Array.isArray(row.legacy_installation_ids)||row.legacy_installation_ids.length>50||row.legacy_installation_ids.some(id=>typeof id!=='string'||!id||id.length>256||id.trim()!==id||/[\u0000-\u001f\u007f-\u009f]/u.test(id))||new Set(row.legacy_installation_ids).size!==row.legacy_installation_ids.length)return unavailableNativeEmail;
 return Object.freeze({available:row.available,legacy_installation_ids:Object.freeze([...row.legacy_installation_ids] as string[])});
}
/** Native routes replace mapped legacy modules. Admitted Experiences from a
 * later version keep their own navigation on the same installation. */
export function nativeEmailAppNavigation(groups:readonly AppNavigationItem[],availability:NativeEmailAvailability){
 if(!availability.available)return [...groups];const replaced=new Set(availability.legacy_installation_ids);
 return groups.flatMap(group=>{
  if(!replaced.has(group.installationId))return [group];
  const links=group.links.filter(link=>link.kind==='experience');
  return links.length?[{...group,links,href:links[0]!.href}]:[];
 });
}
/** An admitted replacement Experience owns the primary entry. Native history
 * remains reachable by its existing routes and is the fallback without it. */
export function showNativeEmailNavigation(groups:readonly AppNavigationItem[],availability:NativeEmailAvailability){
 if(!availability.available)return false;
 const mapped=new Set(availability.legacy_installation_ids);
 return !groups.some(group=>mapped.has(group.installationId)&&group.links.some(link=>link.kind==='experience'));
}
export async function readNativeEmailAvailability(ports:{fetch:(path:string,init:RequestInit)=>Promise<Response>;current:()=>boolean},signal?:AbortSignal):Promise<NativeEmailAvailability>{
 const bounded=AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])]);let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 try{if(!ports.current()||bounded.aborted)return unavailableNativeEmail;const response=await ports.fetch('/api/email/availability',{method:'GET',cache:'no-store',signal:bounded});
  if(!response.ok||!ports.current()||bounded.aborted){await response.body?.cancel().catch(()=>{});return unavailableNativeEmail;}if(!response.body)return unavailableNativeEmail;
  reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let count=0,text='';const abort=()=>{void reader?.cancel().catch(()=>{});};bounded.addEventListener('abort',abort,{once:true});
  try{for(;;){bounded.throwIfAborted();const next=await reader.read();bounded.throwIfAborted();if(next.done)break;count+=next.value.byteLength;if(count>16384)return unavailableNativeEmail;text+=decoder.decode(next.value,{stream:true});}text+=decoder.decode();}finally{bounded.removeEventListener('abort',abort);}
  if(!ports.current()||bounded.aborted)return unavailableNativeEmail;return parseNativeEmailAvailability(JSON.parse(text));
 }catch{return unavailableNativeEmail;}finally{await reader?.cancel().catch(()=>{});reader?.releaseLock();}
}
