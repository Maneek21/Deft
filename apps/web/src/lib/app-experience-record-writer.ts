/** A large record stays inside the trusted host. Author events contain only its
 * immutable locator/revision; no document or binary bytes cross the Worker. */
export type ExperienceRecordValue = Record<string, unknown>;
export type ExperienceRecordRow = Readonly<{record_id:string;revision:number;content_revision?:number;content_digest:string;status:'draft'|'submitted'|'archived';value:ExperienceRecordValue;
 source_refs?:readonly {resource_key:string;record_id:string;content_digest:string}[];
 summary?:Readonly<Record<string,string|number|boolean|null>>;
 files?:readonly {file_id:string;upload_revision:number;sha256:string}[]}>;
export type ExperienceRecordWriterState = Readonly<{row:ExperienceRecordRow;value:ExperienceRecordValue;dirty:boolean;
  state:'saved'|'saving'|'unsaved'|'blocked';notice:string}>;
export function experienceRecordSubmissionEvent(nodeId:string,row:ExperienceRecordRow){
 return {kind:'input' as const,node_id:nodeId,record_id:row.record_id,record_revision:row.revision,content_digest:row.content_digest,record_state:'submitted',valid:false,dirty:false};
}
export type RecordSaveAttempt={previous:ExperienceRecordRow;captured:ExperienceRecordValue;requestId:string};
export function createExperienceRecordWriter(options:{initial:ExperienceRecordRow;current:()=>boolean;signal:AbortSignal;
  validate:(value:ExperienceRecordValue)=>void;read:()=>Promise<ExperienceRecordRow>;
  save:(revision:number,value:ExperienceRecordValue,requestId:string,contentDigest:string)=>Promise<ExperienceRecordRow>;
  change:(state:ExperienceRecordWriterState)=>void;beforeSave?:(attempt:RecordSaveAttempt)=>Promise<void>;recoverSave?:(revision:number,value:ExperienceRecordValue,requestId:string,digest:string)=>Promise<ExperienceRecordRow|null>}) {
  if(options.initial.status!=='draft')throw Error('Record is read-only');
  let row=structuredClone(options.initial),value=structuredClone(row.value),state:ExperienceRecordWriterState['state']='saved',notice='',active=true;
  let pending:Promise<boolean>|null=null,mutating=false,unconfirmed:{previous:ExperienceRecordRow;captured:ExperienceRecordValue;requestId:string}|null=null;
  const current=()=>active&&!options.signal.aborted&&options.current();
  const canonical=(input:unknown):unknown=>Array.isArray(input)?input.map(canonical):input&&typeof input==='object'?Object.fromEntries(Object.entries(input).sort(([a],[b])=>a.localeCompare(b)).map(([key,part])=>[key,canonical(part)])):input;
  const equal=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
  const dirty=()=>!equal(value,row.value);
  const emit=()=>{if(current())options.change({row:structuredClone(row),value:structuredClone(value),dirty:dirty(),state,notice});};
  const verify=(next:ExperienceRecordRow,revision:number)=>{
    if(!current()||next.status!=='draft'||next.record_id!==row.record_id||next.revision!==revision||!/^sha256:[a-f0-9]{64}$/u.test(next.content_digest))throw Error('Record result changed');
    options.validate(next.value);return structuredClone(next);
  };
  const save=(explicit=false):Promise<boolean>=>{
    if(!current()||state==='blocked')return Promise.resolve(false);
    if(pending)return pending;
    pending=(async()=>{while(current()&&(dirty()||explicit&&row.revision===0)){
      const captured=structuredClone(value),previous=row;let dispatched=false;
      try{options.validate(captured);}catch{state='unsaved';notice='This draft needs correction before saving. Your edits are kept.';emit();return false;}
      state='saving';notice='Saving…';emit();
      try{const requestId=crypto.randomUUID();unconfirmed={previous:structuredClone(previous),captured,requestId};if(options.beforeSave)await options.beforeSave(structuredClone(unconfirmed));dispatched=true;const next=verify(await options.save(previous.revision,captured,requestId,previous.content_digest),previous.revision+1);
        if(!equal(next.value,captured))throw Error('Saved content changed');row=next;unconfirmed=null;state=dirty()?'unsaved':'saved';notice=dirty()?'Unsaved changes':'Saved privately';emit();
      }catch{if(current()){if(dispatched){state='blocked';notice='Saving could not be confirmed. Your edits are kept. Reopen the saved version before trying again.';}else{unconfirmed=null;state='unsaved';notice='Save was not started because browser recovery could not be confirmed. Your edits are kept. Try Save again.';}emit();}return false;}
    }return current();})();
    const task=pending;void task.finally(()=>{if(pending===task)pending=null;});return task;
  };
  return {
    get snapshot():ExperienceRecordWriterState{return {row:structuredClone(row),value:structuredClone(value),dirty:dirty(),state,notice};},
    edit(next:ExperienceRecordValue){if(!current()||state==='blocked'||mutating)return false;value=structuredClone(next);state=pending?'saving':dirty()?'unsaved':'saved';notice=dirty()?'Unsaved changes':'Saved privately';emit();return true;},
    save,
    get recoveryAttempt(){return unconfirmed?structuredClone(unconfirmed):null;},
    restoreRecovery(next:ExperienceRecordValue,attempt?:RecordSaveAttempt){if(!current()||pending||mutating||dirty())return false;
      try{options.validate(next);if(attempt&&(attempt.previous.record_id!==row.record_id||!/^sha256:[a-f0-9]{64}$/u.test(attempt.previous.content_digest)||attempt.previous.revision>row.revision||!attempt.requestId))return false;
       value=structuredClone(next);unconfirmed=attempt?structuredClone(attempt):null;state=attempt?'blocked':dirty()?'unsaved':'saved';notice=attempt?'Saving could not be confirmed. Check the original saved status.':'Browser draft restored. Review it before saving.';emit();return true;}catch{return false;}},
    blockRecovery(){if(!current()||pending||mutating)return false;state='blocked';notice='Submission is not confirmed. Check its original status before changing this record.';emit();return true;},
    /** Read-only recovery of the original mutation identity; never repeats save. */
    async reconcileSave(){if(!current()||pending||mutating||!unconfirmed||!options.recoverSave)return false;mutating=true;
      const attempt=unconfirmed;state='saving';notice='Checking saved status…';emit();
      try{const result=await options.recoverSave(attempt.previous.revision,attempt.captured,attempt.requestId,attempt.previous.content_digest);
        if(!result)throw Error('Save remains uncertain');const next=verify(result,attempt.previous.revision+1);if(!equal(next.value,attempt.captured))throw Error('Saved contents changed');
        row=next;unconfirmed=null;state=dirty()?'unsaved':'saved';notice=dirty()?'Unsaved changes':'Saved status confirmed';emit();return true;
      }catch{if(current()){state='blocked';notice='Saved status is not confirmed. Your edits are kept. Check the original status or reopen its saved version.';emit();}return false;}
      finally{mutating=false;}
    },
    /** Binary ports own the mutation identity. They execute once after text CAS
     * is confirmed, and an unknown result blocks every subsequent mutation. */
    async mutate(operation:(revision:number)=>Promise<ExperienceRecordRow>){
      if(!current()||state==='blocked'||mutating)return false;mutating=true;
      try{if(!await save(true))return false;
        const previous=row;state='saving';notice='Saving files…';emit();
        row=verify(await operation(previous.revision),previous.revision+1);value=structuredClone(row.value);state='saved';notice='Saved privately';emit();return true;
      }catch{if(current()){state='blocked';notice='The file change could not be confirmed. Reopen the saved version before trying again.';emit();}return false;}
      finally{mutating=false;}
    },
    /** Only a trusted original mutation receipt may reconcile an uncertain CAS. */
    confirmMutation(result:ExperienceRecordRow,previous:ExperienceRecordRow,expectedValue:ExperienceRecordValue){
      if(!current()||pending||mutating||state!=='blocked'||unconfirmed||dirty()||row.record_id!==previous.record_id
        ||row.revision!==previous.revision||row.content_digest!==previous.content_digest)return false;
      try{const next=verify(result,previous.revision+1);if(!equal(next.value,expectedValue))return false;
        row=next;value=structuredClone(row.value);state='saved';notice='Saved change confirmed';emit();return true;}catch{return false;}
    },
    /** Explicit recovery replaces local edits only after the caller requests it. */
    async reopen(expected?:Pick<ExperienceRecordRow,'record_id'|'revision'|'content_digest'>&{preserve_edits?:boolean}){if(!current()||pending||mutating||expected?.preserve_edits&&(dirty()||state!=='saved'))return false;try{const next=await options.read();
      if(!current()||expected?.preserve_edits&&(dirty()||state!=='saved'||!equal(next.value,row.value))||next.status!=='draft'||next.record_id!==row.record_id||next.revision<row.revision
          ||expected&&(next.record_id!==expected.record_id||next.revision!==expected.revision||next.content_digest!==expected.content_digest))throw Error('Record changed');
      options.validate(next.value);row=structuredClone(next);value=structuredClone(row.value);unconfirmed=null;state='saved';notice='Saved version reopened';emit();return true;
    }catch{if(current()){state='blocked';notice='The saved version is unavailable. Your edits are kept.';emit();}return false;}},
    dispose(){active=false;},
  };
}
