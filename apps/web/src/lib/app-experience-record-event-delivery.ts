/** Trusted metadata snapshots are replaceable while authority is being checked.
 * Keep one in flight and the latest pending snapshot; never queue body bytes. */
export function createRecordEventDelivery<Event extends {record_seed?:boolean;record_state:string}>(ports:{
 current:()=>boolean;send:(event:Event)=>unknown;accepted:(event:Event)=>void;
}){
 type Pending={event:Event;finish:(accepted:boolean)=>void};
 const queue:Pending[]=[];let running=false,disposed=false;
 const current=()=>!disposed&&ports.current();
 const snapshot=(event:Event)=>!event.record_seed&&event.record_state!=='submitted';
 const drain=async()=>{
  if(running)return;running=true;
  try{while(queue.length){const next=queue.shift()!;let accepted=false;
   try{if(current())accepted=await ports.send(next.event)===true&&current();}catch{/* Delivery cannot change the saved record. */}
   if(accepted)ports.accepted(next.event);next.finish(accepted);
  }}finally{running=false;}
 };
 return {send(event:Event):Promise<boolean>{
  if(!current())return Promise.resolve(false);
  return new Promise(resolve=>{const tail=queue.at(-1);
   if(tail&&snapshot(tail.event)&&snapshot(event)){queue.pop();tail.finish(false);}
   if(queue.length>=16){resolve(false);return;}
   queue.push({event,finish:resolve});void drain();
  });
 },dispose(){disposed=true;for(const pending of queue.splice(0))pending.finish(false);}};
}
