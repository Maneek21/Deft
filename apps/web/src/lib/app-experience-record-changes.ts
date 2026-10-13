import {canonicalAppDataJson} from '../../../../packages/app-kit/src/app-data';
import {AppRecordChangeParametersSchema,AppPreparedRecordChangeSchema,type AppPreparedRecordChange,type AppRecordChangeReference} from '../../../../packages/app-kit/src/record-change';
import type {DeftExperienceRecordFormNode} from '../../../../packages/app-kit/src/app-data';
import type {createExperienceRecordWriter,ExperienceRecordRow} from './app-experience-record-writer';
export class RecordChangeNotApplied extends Error{constructor(){super('This change was not applied. Reopen the saved draft before trying again.');}}
export type RecordChangeControl=NonNullable<DeftExperienceRecordFormNode['record_changes']>[number];
export type RecordChangeChoice=AppRecordChangeReference&{label:string};
export type RecordChangePorts={
 listChanges:(node:DeftExperienceRecordFormNode,control:RecordChangeControl,signal:AbortSignal,cursor?:string|null)=>Promise<{choices:readonly RecordChangeChoice[];next_cursor:string|null}>;
 prepareChange:(node:DeftExperienceRecordFormNode,row:ExperienceRecordRow,control:RecordChangeControl,source:RecordChangeChoice,requestId:string,signal:AbortSignal,invocationMode?:'initial',parameters?:Record<string,string>)=>Promise<AppPreparedRecordChange>;
 applyChange:(node:DeftExperienceRecordFormNode,row:ExperienceRecordRow,prepared:AppPreparedRecordChange,requestId:string,signal:AbortSignal)=>Promise<ExperienceRecordRow>;
 changeStatus:(node:DeftExperienceRecordFormNode,row:ExperienceRecordRow,prepared:AppPreparedRecordChange,requestId:string,signal:AbortSignal)=>Promise<ExperienceRecordRow|null>;
};
export type RecordChangeState={phase:'idle'|'loading'|'choosing'|'preparing'|'review'|'applying'|'unconfirmed'|'parameters';parameterFields?:readonly {key:string;label:string;max_characters:number}[];parameters?:Record<string,string>;choices:readonly RecordChangeChoice[];prepared:AppPreparedRecordChange|null;notice:string;next_cursor?:string|null};
const equal=(a:unknown,b:unknown)=>canonicalAppDataJson(a)===canonicalAppDataJson(b);
export function verifyRecordChangeReceipt(previous:ExperienceRecordRow,next:ExperienceRecordRow,prepared:AppPreparedRecordChange){
 if(previous.status!=='draft'||next.status!=='draft'||next.record_id!==previous.record_id||next.revision!==previous.revision+1
  ||!equal(next.value,prepared.value)||!equal(next.files??[],previous.files??[])||!equal(next.source_refs??[],previous.source_refs??[]))throw Error('Changed record not confirmed');return next;
}
/** Full previews remain in this trusted lifetime; only row acknowledgements leave it. */
export function createRecordChanges(options:{node:DeftExperienceRecordFormNode;writer:()=>ReturnType<typeof createExperienceRecordWriter>|null;ports:RecordChangePorts;
 current:()=>boolean;locked:()=>boolean;signal:AbortSignal;change:(state:RecordChangeState)=>void}){
 let active=true,state:RecordChangeState={phase:'idle',choices:[],prepared:null,notice:''},control:RecordChangeControl|null=null,previous:ExperienceRecordRow|null=null;
 let selectedSource:RecordChangeChoice|null=null;
 let attempt:{row:ExperienceRecordRow;prepared:AppPreparedRecordChange;requestId:string}|null=null;
 const current=()=>active&&!options.signal.aborted&&options.current();
 const emit=()=>{if(current())options.change({...state});};
 const ready=()=>{const writer=options.writer(),snapshot=writer?.snapshot;return !!writer&&snapshot?.row.status==='draft'&&!snapshot.dirty&&snapshot.state==='saved';};
 return {
  get snapshot(){return {...state};},
  async choose(selected:RecordChangeControl){if(!current()||options.locked()||state.phase!=='idle'||!options.node.record_changes?.some(item=>equal(item,selected)))return false;
   control=selected;state={phase:'loading',choices:[],prepared:null,notice:'Opening saved content…'};emit();
   try{const writer=options.writer();if(!writer||!await writer.save()||!current()||!ready())throw Error('Save the draft before using saved content.');
    previous=writer.snapshot.row;const page=await options.ports.listChanges(options.node,selected,options.signal),choices=page.choices;if(!current())return false;
    if(choices.length>25||choices.some(item=>item.store_key!==selected.source_store_key)||new Set(choices.map(item=>item.record_id)).size!==choices.length)throw Error('Saved content changed');
    state={phase:'choosing',choices,prepared:null,next_cursor:page.next_cursor,notice:choices.length?'Choose saved content to review.':'No saved content is available.'};emit();return true;
   }catch{if(current()){state={phase:'idle',choices:[],prepared:null,notice:'Saved content is unavailable. Your draft is kept.'};emit();}return false;}
  },
  async nextPage(){if(!current()||state.phase!=='choosing'||!state.next_cursor||!control||!ready())return false;
   const cursor=state.next_cursor;state={...state,phase:'loading',notice:'Opening more saved content…'};emit();
   try{const page=await options.ports.listChanges(options.node,control,options.signal,cursor);if(!current())return false;
    if(page.choices.length>25||page.choices.some(item=>item.store_key!==control!.source_store_key)||new Set(page.choices.map(item=>item.record_id)).size!==page.choices.length||page.next_cursor===cursor)throw Error('Saved content page changed');
    state={phase:'choosing',choices:page.choices,prepared:null,next_cursor:page.next_cursor,notice:page.choices.length?'Choose saved content to review.':'No saved content is available on this page.'};emit();return true;
   }catch{if(current()){state={phase:'idle',choices:[],prepared:null,notice:'Saved content is unavailable. Your draft is kept.'};emit();}return false;}
  },
  async prepare(source:RecordChangeChoice){if(!current()||state.phase!=='choosing'||!control||!previous||!ready()||!state.choices.some(item=>equal(item,source)))return false;
   state={...state,phase:'preparing',notice:'Preparing a preview…'};emit();
   try{const prepared=AppPreparedRecordChangeSchema.parse(await options.ports.prepareChange(options.node,previous,control,source,crypto.randomUUID(),options.signal,undefined,control.parameters==='runtime_prompt'?{}:undefined));if(!current())return false;if(prepared.invocation_mode!==undefined)throw Error('Manual preview changed');
    if(prepared.schema_version!==(control.parameters==='runtime_prompt'?'deft.app_prepared_record_change.v2':'deft.app_prepared_record_change.v1')||prepared.schema_version==='deft.app_prepared_record_change.v2'&&!equal(prepared.parameters,{}))throw Error('Parameter preview changed');
    if(!ready()||options.writer()!.snapshot.row.revision!==previous.revision||options.writer()!.snapshot.row.content_digest!==previous.content_digest
     ||Date.parse(prepared.expires_at)<=Date.now()||prepared.operation_key!==control.operation_key
     ||!equal(prepared.source,{store_key:source.store_key,record_id:source.record_id,expected_revision:source.expected_revision,expected_content_digest:source.expected_content_digest})
     ||!equal(prepared.destination,{store_key:options.node.store_key,record_id:previous.record_id,expected_revision:previous.revision,expected_content_digest:previous.content_digest}))throw Error('Saved draft changed');selectedSource=source;state={...state,phase:'review',prepared,...(prepared.schema_version==='deft.app_prepared_record_change.v2'?{parameterFields:prepared.parameter_fields,parameters:{...prepared.parameters}}:{}),notice:''};emit();return true;
   }catch{if(current()){state={phase:'idle',choices:[],prepared:null,notice:'The preview is unavailable. Your draft is kept.'};emit();}return false;}
  },
  editParameter(key:string,value:string){if(!current()||!['review','parameters'].includes(state.phase)||!state.parameterFields?.some(field=>field.key===key)||!ready())return false;
   const field=state.parameterFields.find(field=>field.key===key)!;if(value.length>field.max_characters)return false;
   state={...state,phase:'parameters',prepared:null,parameters:{...state.parameters,[key]:value},notice:'Update the preview to review your entered values. Missing values remain visible placeholders.'};emit();return true;},
  async updatePreview(){if(!current()||state.phase!=='parameters'||!control||control.parameters!=='runtime_prompt'||!previous||!selectedSource||!ready())return false;
   const source=selectedSource,parameters={...state.parameters};try{AppRecordChangeParametersSchema.parse(parameters);}catch{state={...state,notice:'Correct parameter values before updating the preview.'};emit();return false;}
   state={...state,phase:'preparing',prepared:null,notice:'Updating the preview…'};emit();
   try{const prepared=AppPreparedRecordChangeSchema.parse(await options.ports.prepareChange(options.node,previous,control,source,crypto.randomUUID(),options.signal,undefined,parameters));if(!current())return false;
    if(!ready()||options.writer()!.snapshot.row.revision!==previous.revision||options.writer()!.snapshot.row.content_digest!==previous.content_digest||Date.parse(prepared.expires_at)<=Date.now()
     ||prepared.invocation_mode!==undefined||prepared.schema_version!=='deft.app_prepared_record_change.v2'||!equal(prepared.parameters,parameters)||prepared.operation_key!==control.operation_key
     ||!equal(prepared.parameter_fields,state.parameterFields)||!equal(prepared.source,{store_key:source.store_key,record_id:source.record_id,expected_revision:source.expected_revision,expected_content_digest:source.expected_content_digest})
     ||!equal(prepared.destination,{store_key:options.node.store_key,record_id:previous.record_id,expected_revision:previous.revision,expected_content_digest:previous.content_digest}))throw Error('Saved draft or parameter fields changed');
    state={...state,phase:'review',prepared,notice:''};emit();return true;
   }catch{if(current()){state={...state,phase:'parameters',prepared:null,notice:'The preview is unavailable. Your draft is kept. Update the preview explicitly to review again.'};emit();}return false;}
  },
  async apply(){if(!current()||state.phase!=='review'||!state.prepared||!previous||!ready()||Date.parse(state.prepared.expires_at)<=Date.now())return false;
   const writer=options.writer()!,row=writer.snapshot.row;if(row.revision!==previous.revision||row.content_digest!==previous.content_digest)return false;
   attempt={row,prepared:state.prepared,requestId:crypto.randomUUID()};const owned=attempt;state={...state,phase:'applying',notice:'Applying saved content…'};emit();
   let settled=false;const ok=await writer.mutate(async()=>{try{return verifyRecordChangeReceipt(owned.row,await options.ports.applyChange(options.node,owned.row,owned.prepared,owned.requestId,options.signal),owned.prepared);}catch(error){settled=error instanceof RecordChangeNotApplied;throw error;}});
   if(!current())return false;if(ok){attempt=null;state={phase:'idle',choices:[],prepared:null,notice:'Saved content applied privately.'};}
   else if(settled){attempt=null;state={phase:'idle',choices:[],prepared:null,notice:'No changes were applied. Reopen the saved draft before trying again.'};}
   else state={...state,phase:'unconfirmed',notice:'This change could not be confirmed. Check its original status before making another change.'};emit();return ok;
  },
  async check(){if(!current()||state.phase!=='unconfirmed'||!attempt)return false;const owned=attempt;state={...state,phase:'applying',notice:'Checking the original change…'};emit();
   try{const next=await options.ports.changeStatus(options.node,owned.row,owned.prepared,owned.requestId,options.signal);if(!current())return false;
    if(!next||!options.writer()?.confirmMutation(verifyRecordChangeReceipt(owned.row,next,owned.prepared),owned.row,owned.prepared.value))throw Error('Change remains uncertain');
    attempt=null;state={phase:'idle',choices:[],prepared:null,notice:'Saved change confirmed.'};emit();return true;
   }catch{if(current()){state={...state,phase:'unconfirmed',notice:'The original change is not confirmed. Your draft remains blocked.'};emit();}return false;}
  },
  close(){if(!current()||['loading','preparing','applying','unconfirmed'].includes(state.phase))return false;state={phase:'idle',choices:[],prepared:null,notice:''};previous=null;control=null;selectedSource=null;emit();return true;},
  dispose(){active=false;attempt=null;previous=null;selectedSource=null;state={phase:'idle',choices:[],prepared:null,notice:''};},
 };
}
