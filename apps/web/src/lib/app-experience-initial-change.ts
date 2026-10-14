import {canonicalAppDataJson} from '../../../../packages/app-kit/src/app-data';
import {RecordChangeNotApplied,verifyRecordChangeReceipt,type RecordChangeChoice,type RecordChangePorts} from './app-experience-record-changes';
import type {RecordFormNode as DeftExperienceRecordFormNode} from './app-experience-record-form';
import type {createExperienceRecordWriter,ExperienceRecordRow} from './app-experience-record-writer';
export type InitialChangePorts=RecordChangePorts&{initialSource:(node:DeftExperienceRecordFormNode,row:ExperienceRecordRow,signal:AbortSignal)=>Promise<RecordChangeChoice|null>};
/** One nomination belongs to the exact loaded clean initial row. Read failure
 * leaves composition usable; an uncertain write keeps its original identity. */
export function createInitialRecordChange(options:{node:DeftExperienceRecordFormNode;writer:()=>ReturnType<typeof createExperienceRecordWriter>|null;
 ports:InitialChangePorts;current:()=>boolean;signal:AbortSignal;change:(busy:boolean,notice:string,unknown:boolean)=>void}){
 let attempted=false,active=true,owned:{row:ExperienceRecordRow;prepared:Awaited<ReturnType<InitialChangePorts['prepareChange']>>;requestId:string}|null=null;
 const current=()=>active&&options.current()&&!options.signal.aborted;
 const clean=(baseline:ExperienceRecordRow)=>{const state=options.writer()?.snapshot;return current()&&!!state&&state.row.status==='draft'&&state.row.revision===1&&state.row.content_revision===1&&!state.dirty&&state.state==='saved'
  &&state.row.record_id===baseline.record_id&&state.row.content_digest===baseline.content_digest&&canonicalAppDataJson(state.value)===canonicalAppDataJson(baseline.value);};
 const notice=(busy:boolean,text:string)=>{if(current())options.change(busy,text,!!owned);};
 return {
  async start(){if(attempted||!options.node.initial_change||!current())return false;attempted=true;
   const row=options.writer()?.snapshot.row;if(!row||!clean(row))return false;const nomination=options.node.initial_change;
   const control={...nomination,label:'Saved default'};notice(true,'Checking your saved default…');
   try{const source=await options.ports.initialSource(options.node,row,options.signal);if(!source||!clean(row)){notice(false,'Your draft is ready. Apply saved content explicitly if needed.');return false;}
    const prepared=await options.ports.prepareChange(options.node,row,control,source,crypto.randomUUID(),options.signal,'initial');
    if(!clean(row)||Date.parse(prepared.expires_at)<=Date.now()||prepared.invocation_mode!=='initial'||prepared.operation_key!==nomination.operation_key||prepared.source.store_key!==nomination.source_store_key||prepared.destination.store_key!==options.node.store_key||prepared.destination.record_id!==row.record_id||prepared.destination.expected_revision!==row.revision||prepared.destination.expected_content_digest!==row.content_digest)return false;
    const attempt={row,prepared,requestId:crypto.randomUUID()};owned=attempt;let settled=false;
    const ok=await options.writer()!.mutate(async()=>{if(!cleanDuringMutation(row))throw Error('Initial draft changed');try{return verifyRecordChangeReceipt(row,await options.ports.applyChange(options.node,row,prepared,attempt.requestId,options.signal),prepared);}catch(error){settled=error instanceof RecordChangeNotApplied;throw error;}});
    if(ok){owned=null;notice(false,'Saved default applied.');return true;}
    if(settled){owned=null;await options.writer()?.reopen({record_id:row.record_id,revision:row.revision,content_digest:row.content_digest});notice(false,'Your draft is kept. Apply saved content explicitly if needed.');return false;}
    notice(false,'The initial saved-content change is not confirmed. Check its original status before editing.');return false;
   }catch{if(!owned)notice(false,'Your draft is ready. Apply saved content explicitly if needed.');return false;}
   finally{if(current())options.change(false,owned?'The initial saved-content change is not confirmed. Check its original status before editing.':'',!!owned);}
  },
  async check(){if(!owned||!current())return false;const attempt=owned;notice(true,'Checking the original change…');
   try{const next=await options.ports.changeStatus(options.node,attempt.row,attempt.prepared,attempt.requestId,options.signal);
    if(!current()||!next||!options.writer()?.confirmMutation(verifyRecordChangeReceipt(attempt.row,next,attempt.prepared),attempt.row,attempt.prepared.value))throw Error('Change uncertain');
    owned=null;notice(false,'Saved default confirmed.');return true;
   }catch{notice(false,'The original change remains unconfirmed. Your draft is kept.');return false;}},
  dispose(){active=false;owned=null;},
 };
 function cleanDuringMutation(row:ExperienceRecordRow){const state=options.writer()?.snapshot;return current()&&!!state&&!state.dirty&&state.row.record_id===row.record_id&&state.row.revision===row.revision&&state.row.content_digest===row.content_digest&&canonicalAppDataJson(state.value)===canonicalAppDataJson(row.value);}
}
