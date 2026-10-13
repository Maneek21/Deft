import type {NativeEmailMessage} from './email-native-search';
import type {NativeTriageFolderAcknowledgement,NativeTriageGroup,NativeTriageState,NativeTriageTarget} from './email-native-triage';

export type NativeFolderAcknowledgement=NativeTriageFolderAcknowledgement;
const key=(row:NativeTriageTarget)=>JSON.stringify([row.account_id,row.logical_message_id]);
const equal=(left:readonly string[],right:readonly string[])=>left.length===right.length&&left.every(value=>right.includes(value));
/** Completed feedback belongs to its originating view. Unknown operations keep
 * their retained status route when the user navigates elsewhere. */
export function nativeTriageFeedbackVisible(state:NativeTriageState|null,owner:string|null,view:string){
 return owner===view||!!state?.busy||!!state?.groups.some(group=>['pending','uncertain','denied','failed'].includes(group.state)||group.result?.items.some(item=>['prepared','unknown','failed'].includes(item.state)));
}
/** The folders are a fresh provider receipt, not an inference from action kind.
 * Only the selected target gets at most three normal cache reads. Other loaded
 * rows are reconciled by observations the host already makes. */
export function createNativeFolderProjection(options:{current:()=>boolean;selected:()=>NativeTriageTarget|null;
 read:(target:NativeTriageTarget,signal:AbortSignal)=>Promise<NativeEmailMessage>;publish:(row:NativeEmailMessage)=>void;
 expired:(target:NativeTriageTarget)=>void;denied:(accountId:string)=>void}){
 type Entry={ack:NativeFolderAcknowledgement;timer:ReturnType<typeof setTimeout>;generation:number};
 let active=true,scope='',signature='',generation=0,remaining=3;const owners=new Map<string,string>(),entries=new Map<string,Entry>(),expiredTargets=new Set<string>();let reader:AbortController|null=null,readerTarget:string|null=null;
 const current=()=>active&&options.current();
 const cancelReader=()=>{reader?.abort();reader=null;readerTarget=null;};
 const drop=(id:string)=>{const entry=entries.get(id);if(entry){entries.delete(id);owners.delete(id);clearTimeout(entry.timer);if(readerTarget===id)cancelReader();}};
 const reset=()=>{cancelReader();for(const id of entries.keys())drop(id);owners.clear();expiredTargets.clear();signature='';generation++;remaining=3;};
 const own=(entry:Entry)=>current()&&entries.get(key(entry.ack))===entry&&owners.get(key(entry.ack))===entry.ack.operation_id;
 // A rendered/search snapshot is never evidence. Only validated normal GET
 // callsites nominate a fresh observation; cloned retained rows cannot do so.
 const observe=(row:NativeEmailMessage,fresh=false):NativeEmailMessage=>{const entry=entries.get(key(row));if(!entry||!own(entry))return row;
  if(equal(row.folders,entry.ack.folders)){if(fresh)drop(key(row));return row;}return {...row,folders:[...entry.ack.folders]};};
 const expire=(entry:Entry)=>{if(!own(entry))return;const id=key(entry.ack);drop(id);if(expiredTargets.size>=100)expiredTargets.delete(expiredTargets.values().next().value!);expiredTargets.add(id);if(current())options.expired(entry.ack);};
 const selected=()=>{const target=options.selected(),id=target?key(target):null,entry=id?entries.get(id):undefined;
  if(reader&&readerTarget===id)return;cancelReader();if(!entry||!own(entry)||entry.generation!==generation||remaining===0)return;
  const controller=new AbortController(),ticket=generation;reader=controller;readerTarget=id;
  const reading=()=>own(entry)&&reader===controller&&!controller.signal.aborted&&ticket===generation&&key(options.selected()??{account_id:'',logical_message_id:''})===id;
  void (async()=>{let first=true;while(remaining>0&&reading()){
   if(!first)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,4000);controller.signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});first=false;if(!reading())return;
   remaining--;try{const row=await options.read(entry.ack,controller.signal);if(!reading())return;
    if(row.account_id!==entry.ack.account_id||row.logical_message_id!==entry.ack.logical_message_id)throw Error('Message details could not be confirmed.');
    const projected=observe(row,true);if(current())options.publish(projected);if(!reading())return;
   }catch(error){if(!reading())return;const status=error&&typeof error==='object'&&'status'in error?error.status:undefined;
    if(status===401||status===403){revoke(entry.ack.account_id);options.denied(entry.ack.account_id);return;}
    if(status===404){expire(entry);return;}}
  }})().finally(()=>{if(reader===controller){reader=null;readerTarget=null;}});
 };
 const revoke=(accountId:string)=>{for(const [id,entry]of entries)if(entry.ack.account_id===accountId)drop(id);for(const id of owners.keys())if(JSON.parse(id)[0]===accountId)owners.delete(id);for(const id of expiredTargets)if(JSON.parse(id)[0]===accountId)expiredTargets.delete(id);};
 return {setScope(value:string){if(scope!==value){reset();scope=value;}},begin(view:string,groups:readonly NativeTriageGroup[]){if(!current()||scope!==view)return;
   const next=groups.map(group=>group.operationId).join('/');if(groups.some(group=>group.state==='pending')&&signature!==next){signature=next;generation++;remaining=3;cancelReader();}
   const retained=new Set(groups.flatMap(group=>group.ids.map(logical_message_id=>key({account_id:group.accountId,logical_message_id}))));for(const id of owners.keys())if(!entries.has(id)&&!retained.has(id))owners.delete(id);
   for(const group of groups)if(group.state==='pending')for(const logical_message_id of group.ids){const id=key({account_id:group.accountId,logical_message_id});if(owners.get(id)!==group.operationId){drop(id);expiredTargets.delete(id);owners.set(id,group.operationId);}}
  },acknowledge(view:string,acks:readonly NativeFolderAcknowledgement[]){if(!current()||scope!==view)return;
   for(const ack of acks){const id=key(ack);if(owners.get(id)!==ack.operation_id||entries.has(id))continue;
    if(entries.size>=100)expire(entries.values().next().value!);
    const entry={} as Entry;entry.ack={...ack,folders:[...ack.folders]};entry.generation=generation;entry.timer=setTimeout(()=>expire(entry),15000);entries.set(id,entry);
   }selected();
  },observe,selected,revoke,reset,isExpired:(target:NativeTriageTarget)=>expiredTargets.has(key(target)),reopen:(target:NativeTriageTarget)=>expiredTargets.delete(key(target)),dispose(){active=false;reset();},has:(target:NativeTriageTarget)=>entries.has(key(target)),
  snapshot:()=>[...entries.values()].map(entry=>structuredClone(entry.ack))};
}
