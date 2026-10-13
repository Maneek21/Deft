import {createDraftId,markDraftSubmitted} from './draft-controller.mjs';
const fields = {action_key:80,label:80,summary:400,source_record_id:36,draft_record_id:36,run_id:36,state:32,created_at:40};
const terminal = new Set(['succeeded','failed','denied','cancelled','expired']);
function checked(value) {
  if (!value || Object.keys(value).sort().join(',') !== Object.keys(fields).sort().join(',')) throw Error('REQUEST_JOURNAL_INVALID');
  for (const [key,max] of Object.entries(fields)) if(typeof value[key] !== 'string' || value[key].length > max) throw Error('REQUEST_JOURNAL_INVALID');
  if (!['send_message','reply_message','archive_message','triage_message','permanent_delete_message'].includes(value.action_key)) throw Error('REQUEST_JOURNAL_INVALID');
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
    // A submitted active row still consumes draft quota. The host tombstone
    // frees that quota and retains its CAS fence before Run evidence is evicted.
    // Another retained Activity reference still needs those submitted bytes.
    let draftPreserved=false;
    if(entry.draftId){const pinned=await pinDraft(entry,{allowInaccessible:true});draftPreserved=pinned.inaccessible;const draft=pinned.item;if(draft&&!entries.some(other=>other!==entry&&other.draftId===entry.draftId))await sdk.deletePrivateState('drafts',draft.record_id,draft.revision);}
    await sdk.deletePrivateState('requests',entry.id,entry.revision);
    const index=entries.indexOf(entry);if(index>=0)entries.splice(index,1);
    return {draftPreserved};
  }
  async function pinDraft(entry,{allowInaccessible=false}={}) {
    if(allowInaccessible){
      // This governed list contains only drafts accessible to this current
      // version/target. Older incompatible rows are excluded by the host; keep
      // them without reading, marking or deleting their unavailable payload.
      const listed=await sdk.listPrivateState('drafts');
      if(!Array.isArray(listed?.items)||listed.items.length>32||listed.items.some(item=>typeof item?.record_id!=='string'||!item.record_id)||new Set(listed.items.map(item=>item.record_id)).size!==listed.items.length||'next_cursor' in listed)throw Error('DRAFT_LIST_INVALID');
      if(!listed.items.some(item=>item.record_id===entry.draftId))return {item:null,inaccessible:true};
    }
    let unavailableRead=null;
    // Never translate marker-write/session/CAS failures into success. The
    // visibility list above avoids relying on masked bridge error strings.
    const draftSdk={
      async readPrivateState(...args){try{return await sdk.readPrivateState(...args);}catch(error){const code=error?.code??error?.message;if(code==='APP_NOT_FOUND')unavailableRead=code;throw error;}},
      putPrivateState:(...args)=>sdk.putPrivateState(...args),
    };
    try{return {item:await markDraftSubmitted(draftSdk,entry.draftId),inaccessible:false};}catch(error){if(!unavailableRead)throw error;return {item:null,inaccessible:false};}
  }
  async function hasCapacity() {
    // Current-session rows are only a visibility window. The host quota also
    // includes this owner's retained requests in other versions and targets.
    const listed=await readOnceMore(()=>sdk.listPrivateState('requests')),quota=listed.quota;
    if(quota===undefined)return entries.length<10;
    if(![quota.used_records,quota.max_records,quota.used_bytes,quota.max_total_bytes].every(Number.isSafeInteger)
      ||quota.used_records<0||quota.used_bytes<0||quota.max_records<1||quota.max_total_bytes<1)throw Error('REQUEST_JOURNAL_INVALID');
    return entries.length<10&&quota.used_records<quota.max_records&&quota.used_bytes<quota.max_total_bytes;
  }
  async function capacity() {
    // Opening a composer never removes retained requests, saved drafts or files.
    // Only the explicit Activity Remove action may perform verified cleanup.
    if(!await hasCapacity())throw Error('REQUEST_JOURNAL_CAP');
  }
  return {entries,
    async load() {const listed=await readOnceMore(()=>sdk.listPrivateState('requests'));if(listed.items.length>10)throw Error('REQUEST_JOURNAL_CAP');const loaded=[];for(const row of listed.items){loaded.push(decode((await readOnceMore(()=>sdk.readPrivateState('requests',row.record_id))).item));}entries.splice(0,entries.length,...loaded);return entries;},
    async reserve(entry) {await capacity();const next={...entry,id:uuid(),revision:0,state:'unknown',runId:null,createdAt:new Date().toISOString()};let result;try{result=await sdk.putPrivateState('requests',next.id,0,value(next));}catch(error){
      // The same host code also represents CAS conflicts. Confirm capacity with
      // a fresh read before translating it; never repeat the create attempt.
      if(error?.code==='APP_STATE_CONFLICT'||error?.message==='APP_STATE_CONFLICT'){
        let full=false;try{full=!await hasCapacity();}catch{}
        if(full)throw Error('REQUEST_JOURNAL_CAP');
      }
      throw error;
    }next.revision=result.item.revision;entries.push(next);return next;},
    async update(entry,run) {const next={...entry,runId:run?.id||entry.runId,state:run?.state||'unknown'};Object.assign(entry,next);const result=await sdk.putPrivateState('requests',entry.id,entry.revision,value(next));entry.revision=result.item.revision;if(entry.runId&&entry.draftId){const pinned=await pinDraft(entry,{allowInaccessible:run?.id===entry.runId&&terminal.has(run?.state)});entry.draftPreserved=pinned.inaccessible;}return entry;},
    async cancelUnsubmitted(entry) {if(entry.runId||entry.state!=='unknown')throw Error('REQUEST_CANCELLATION_UNCERTAIN');await sdk.deletePrivateState('requests',entry.id,entry.revision);entries.splice(entries.indexOf(entry),1);},
    async remove(entry) {return verifiedRemove(entry);}
  };
}
