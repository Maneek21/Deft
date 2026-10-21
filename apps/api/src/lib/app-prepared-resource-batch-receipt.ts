import {AppResourceActionSourcesSchema} from '@deft/app-kit/core';
/** Only an original retained generic receipt can unlock the next child. */
export function knownPreparedResourceBatchReceipt(value:unknown,runId:string,operation:string,sources:unknown):boolean{
 const refs=AppResourceActionSourcesSchema.safeParse(sources);if(!refs.success)return false;
 const row=value as Record<string,unknown>|null;if(!row||row.operation_id!==runId||row.operation_key!==operation||row.automatic_retry!==false||row.item_count!==refs.data.length||!Number.isSafeInteger(row.succeeded_count)||!Number.isSafeInteger(row.failed_count)||Number(row.succeeded_count)<0||Number(row.failed_count)<0||Number(row.succeeded_count)+Number(row.failed_count)!==row.item_count||typeof row.items_json!=='string'||Buffer.byteLength(row.items_json)>2048)return false;
 let items:unknown;try{items=JSON.parse(row.items_json);}catch{return false;}if(!Array.isArray(items)||items.length!==refs.data.length||new Set(items.map(item=>item?.record_id)).size!==items.length||items.some(item=>!item||Object.keys(item).sort().join(',')!=='record_id,state'||!['succeeded','failed'].includes(item.state)||!refs.data.some(ref=>ref.record_id===item.record_id)))return false;
 if(Object.hasOwn(row,'actions_json')){
  if(row.actions_json==='[]')return items.filter(item=>item.state==='succeeded').length===row.succeeded_count;
  if(row.failed_count!==0||row.succeeded_count!==refs.data.length||items.some(item=>item.state!=='succeeded')||typeof row.actions_json!=='string'||Buffer.byteLength(row.actions_json)>16384)return false;
  let actions:unknown;try{actions=JSON.parse(row.actions_json);}catch{return false;}
  if(!Array.isArray(actions)||actions.length<refs.data.length||actions.length>150||actions.some(item=>!item||Object.keys(item).sort().join(',')!=='action,index,record_id,state'||item.state!=='succeeded'||typeof item.action!=='string'||! /^[a-z][a-z0-9_]{0,47}$/u.test(item.action)||!Number.isSafeInteger(item.index)||item.index<0||item.index>5||!refs.data.some(ref=>ref.record_id===item.record_id)))return false;
  for(const ref of refs.data){const rows=actions.filter(item=>item.record_id===ref.record_id).sort((a,b)=>a.index-b.index);if(rows.length<1||rows.length>6||new Set(rows.map(item=>item.action)).size!==rows.length||rows.some((item,index)=>item.index!==index))return false;}
 }
 return items.filter(item=>item.state==='succeeded').length===row.succeeded_count;
}
