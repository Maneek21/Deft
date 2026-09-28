import {createDraftId} from './draft-controller.mjs';
const fields = {action_key:80,label:80,summary:400,source_record_id:36,draft_record_id:36,run_id:36,state:32,created_at:40};
const terminal = new Set(['succeeded','failed','denied','cancelled','expired']);
function checked(value) {
  if (!value || Object.keys(value).sort().join(',') !== Object.keys(fields).sort().join(',')) throw Error('REQUEST_JOURNAL_INVALID');
  for (const [key,max] of Object.entries(fields)) if(typeof value[key] !== 'string' || value[key].length > max) throw Error('REQUEST_JOURNAL_INVALID');
  if (!['send_message','reply_message','archive_message'].includes(value.action_key)) throw Error('REQUEST_JOURNAL_INVALID');
  return value;
}
export function createRequestJournal(sdk,{uuid=createDraftId}={}) {
  const entries=[];
  async function readOnceMore(operation) {
    try{return await operation();}catch{
      // Only reads retry, once. Keep the exact record ID and do not discard history.
      await new Promise(resolve=>setTimeout(resolve,150+Math.floor(Math.random()*150)));
      return operation();
    }
  }
  function decode(item) {const v=checked(item.value);return {id:item.record_id,revision:item.revision,actionKey:v.action_key,label:v.label,summary:v.summary,sourceId:v.source_record_id||null,draftId:v.draft_record_id||null,runId:v.run_id||null,state:v.state,createdAt:v.created_at};}
  function value(entry) {return checked({action_key:entry.actionKey,label:entry.label,summary:entry.summary,source_record_id:entry.sourceId||'',draft_record_id:entry.draftId||'',run_id:entry.runId||'',state:entry.state,created_at:entry.createdAt});}
  async function verifiedRemove(entry) {
    if(!entry.runId)throw Error('REQUEST_NOT_TERMINAL');
    const run=await sdk.request('run_status',undefined,{run_id:entry.runId});
    if(run?.id!==entry.runId||!terminal.has(run?.state))throw Error('REQUEST_NOT_TERMINAL');
    await sdk.deletePrivateState('requests',entry.id,entry.revision);
    const index=entries.indexOf(entry);if(index>=0)entries.splice(index,1);
  }
  async function capacity() {
    if(entries.length<10)return;
    // Cached state is not authority. Inspect bounded known Run IDs, requiring a
    // current terminal host proof plus CAS; fresh pending/unknown remain retained.
    for(const entry of [...entries].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(0,10)){
      if(!entry.runId)continue;
      try{await verifiedRemove(entry);}catch{continue;}
      if(entries.length<10)return;
    }
    throw Error('REQUEST_JOURNAL_CAP');
  }
  return {entries,
    async load() {const listed=await readOnceMore(()=>sdk.listPrivateState('requests'));if(listed.items.length>10)throw Error('REQUEST_JOURNAL_CAP');const loaded=[];for(const row of listed.items){loaded.push(decode((await readOnceMore(()=>sdk.readPrivateState('requests',row.record_id))).item));}entries.splice(0,entries.length,...loaded);return entries;},
    async reserve(entry) {await capacity();const next={...entry,id:uuid(),revision:0,state:'unknown',runId:null,createdAt:new Date().toISOString()};const result=await sdk.putPrivateState('requests',next.id,0,value(next));next.revision=result.item.revision;entries.push(next);return next;},
    async update(entry,run) {const next={...entry,runId:run?.id||entry.runId,state:run?.state||'unknown'};Object.assign(entry,next);const result=await sdk.putPrivateState('requests',entry.id,entry.revision,value(next));entry.revision=result.item.revision;return entry;},
    async cancelUnsubmitted(entry) {if(entry.runId||entry.state!=='unknown')throw Error('REQUEST_CANCELLATION_UNCERTAIN');await sdk.deletePrivateState('requests',entry.id,entry.revision);entries.splice(entries.indexOf(entry),1);},
    async remove(entry) {await verifiedRemove(entry);}
  };
}
