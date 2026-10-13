const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
/** Interpret only the module's exact reviewed scalar output. Unknown stays unknown. */
export function readTriageReceipt(run){
 const out=run?.output;
 if(!['succeeded','failed'].includes(run?.state)||!out||out.operation_id!==run.id||!uuid.test(run.id)
  ||Object.keys(out).sort().join(',')!=='automatic_retry,failed_count,items,operation_id,succeeded_count,undo_available,unknown_count'
  ||out.automatic_retry!==false||typeof out.undo_available!=='boolean'||typeof out.items!=='string'||out.items.length>4096)return null;
 const rows=out.items.split('\n').map(line=>/^([a-f0-9-]{36}): (succeeded|failed|unknown|prepared)(?: \(([A-Z0-9_]{1,120})\))?$/i.exec(line));
 if(!rows.length||rows.length>25||rows.some(row=>!row||!uuid.test(row[1]))||new Set(rows.map(row=>row[1])).size!==rows.length)return null;
 for(const [key,state] of [['succeeded_count','succeeded'],['failed_count','failed'],['unknown_count','unknown']]){
  const expected=rows.filter(row=>row[2]===state||(state==='unknown'&&row[2]==='prepared')).length;
  if(out[key]!==expected)return null;
 }
 return {operationId:run.id,recordIds:rows.map(row=>row[1]),items:rows.map(row=>({recordId:row[1],state:row[2]==='prepared'?'unknown':row[2],code:row[3]||''})),summary:`${out.succeeded_count} completed · ${out.failed_count} failed${out.unknown_count?` · ${out.unknown_count} unknown`:''}`,
  undoAvailable:out.undo_available&&out.unknown_count===0&&out.succeeded_count>0};
}
