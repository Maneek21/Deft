export function createDraftId() {
  const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export const draftSubjectValid=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\r\n\0]/.test(value);
const saveIssue=value=>value.subject!==''&&!draftSubjectValid(value.subject)?'Use a subject of up to 200 characters without line breaks or null characters.':value.to.length>2048||(value.cc??'').length>2048||(value.bcc??'').length>2048||(value.body_html??'').length>16384||value.subject.length>200||value.body.length>4096||new TextEncoder().encode(JSON.stringify(value)).byteLength>16384?'Draft exceeds its size limit. Shorten the recipient, subject or message.':null;
export async function markDraftSubmitted(sdk,id,expectedRevision) {
  const {item}=await sdk.readPrivateState('drafts',id);
  if(!item||item.record_id!==id||!Number.isSafeInteger(item.revision)||item.revision<1)throw Error('DRAFT_INVALID');
  if(expectedRevision!==undefined&&item.revision!==expectedRevision)throw Error('APP_STATE_CONFLICT');
  if(item.value?.mode==='submitted')return item;
  if(!['compose','reply','reply_all','forward'].includes(item.value?.mode))throw Error('DRAFT_INVALID');
  const value={...item.value,mode:'submitted'};
  const result=await sdk.putPrivateState('drafts',id,item.revision,value);
  return {...item,revision:result.item.revision,value};
}
export function createDraftController(sdk,{snapshot,onChange,uuid=createDraftId,delay=650}) {
  let state={id:null,revision:0,dirty:0,written:0,blocked:false,saving:false,status:'Draft',generation:0},timer;const pending=new Map(),savedParents=new WeakMap();
  const notify=s=>{if(state===s)onChange();};
  const save=async()=>{
    clearTimeout(timer);const s=state;
    if(s.blocked)return;if(s.saving){s.again=true;return s.promise;}
    const value=snapshot();if(!['compose','reply','reply_all','forward'].includes(value.mode)||(!s.id&&!value.to&&!value.subject&&!value.body))return;
    const issue=saveIssue(value);if(issue){s.status=issue;notify(s);return;}
    s.id??=uuid();s.saving=true;s.status='Saving…';notify(s);
    s.promise=(async()=>{do{
      s.again=false;if(state!==s)break;const captured={...snapshot()},dirty=s.dirty,issue=saveIssue(captured);if(issue){s.status=issue;break;}
      try{const parent=['reply','reply_all'].includes(captured.mode)?captured.reply_record_id||'':'';
        const nomination=parent&&savedParents.get(s)!==parent?{source_refs:[{field:'reply_record_id',action_key:'send_message',input_field:'parent_record_id',record_id:parent}]}:null;
        const result=await sdk.putPrivateState('drafts',s.id,s.revision,captured,...(nomination?[nomination]:[]));savedParents.set(s,parent);s.revision=result.item.revision;s.written=dirty;s.status=s.dirty===dirty?'Saved privately':'Unsaved changes';}
      catch(e){s.blocked=true;s.status=String(e?.message||'').includes('STATE_CONFLICT')?'Draft changed elsewhere. Reload it or save a separate copy.':'Save could not be confirmed. Reload the saved draft before trying again.';break;}
      if(s.dirty>s.written)s.again=true;
    }while(s.again&&state===s);s.saving=false;notify(s);})();const promise=s.promise,id=s.id;pending.set(id,promise);const clear=()=>{if(pending.get(id)===promise)pending.delete(id);};promise.then(clear,clear);return promise;
  };
  return {
    get current(){return state;},
    change(){state.dirty++;if(state.blocked)return;state.status='Unsaved changes';notify(state);clearTimeout(timer);timer=setTimeout(()=>void save(),delay);},
    save,
    use(id=null,revision=0){clearTimeout(timer);state={id,revision,dirty:0,written:0,blocked:false,saving:false,status:id?'Saved privately':'Draft',generation:state.generation+1};onChange();},
    copy(){this.use();state.dirty++;return save();},
    async list(){return (await sdk.listPrivateState('drafts')).items;},
    async read(id){const observed=state;await pending.get(id);if(state!==observed)throw Error('DRAFT_SELECTION_CHANGED');const result=await sdk.readPrivateState('drafts',id);if(state!==observed)throw Error('DRAFT_SELECTION_CHANGED');return result.item;},
    async markSubmitted(id,expectedRevision){await pending.get(id);const item=await markDraftSubmitted(sdk,id,expectedRevision);if(state.id===id){clearTimeout(timer);state={...state,revision:item.revision,blocked:true,saving:false,status:'Submitted. Check Activity for its outcome.',generation:state.generation+1};onChange();}return item;},
    async remove(){const s=state;if(!s.id)return;clearTimeout(timer);await s.promise;if(state!==s)return;const result=await sdk.deletePrivateState('drafts',s.id,s.revision);if(state===s){this.use();state.status='Saved copy deleted. Current text remains a draft.';onChange();}return result;},
    close(){clearTimeout(timer);state={...state,generation:state.generation+1};},
  };
}
