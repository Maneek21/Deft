import {z} from 'zod';
import {MODULE_OPERATION_RESULT_SCHEMAS,ModuleRecordUpdateRequestSchema,MODULE_LIMITS} from '@deft/shared/modules';
const WikiFact=z.object({slug:z.string().min(1).max(200),title:z.string().min(1).max(500),content:z.string(),version:z.number().int().positive()});
export type CompilerReadFacts={facts:Array<{tool:'module_record_get'|'module_record_query';read_index:number;item_index?:number;record:ReturnType<typeof MODULE_OPERATION_RESULT_SCHEMAS.module_record_get.parse>['record']}|{tool:'wiki_read';read_index:number;page:z.infer<typeof WikiFact>}>;limitations:string[]};
/** Only same-turn successful actor-authorized reads enter the fallback compiler. */
export function collectCompilerReadFacts(actions:readonly {action?:unknown;readOnly?:unknown;success?:unknown;result?:unknown}[]):CompilerReadFacts{
 const out:CompilerReadFacts={facts:[],limitations:[]};let bytes=0;const seen=new Set<string>();
 const limitation=(text:string)=>{if(out.limitations.length<8)out.limitations.push(text.slice(0,180));};
 const admit=(fact:CompilerReadFacts['facts'][number])=>{
  const identity=fact.tool!=='wiki_read'?'module:'+fact.record.module_id+'/'+fact.record.collection_key+'/'+fact.record.id:'wiki:'+fact.page.slug;
  // Remember even omitted latest facts: older stale facts must never replace them.
  if(seen.has(identity))return;seen.add(identity);
  const size=Buffer.byteLength(JSON.stringify(fact),'utf8');
  if(out.facts.length>=8||bytes+size>60*1024){limitation(`${fact.tool} read ${fact.read_index}: whole fact omitted by compiler context budget; do not infer missing fields`);return;}
  out.facts.push(fact);bytes+=size;
 };
 for(const [read_index,read] of [...actions.entries()].reverse()){
  if(read.readOnly!==true||read.success!==true||!['module_record_get','module_record_query','wiki_read'].includes(String(read.action)))continue;
  if(read.action==='module_record_query'){
   const result=read.result as {items?:unknown};
   const parsed=Array.isArray(result?.items)&&result.items.length<=MODULE_LIMITS.operation_page_size?MODULE_OPERATION_RESULT_SCHEMAS.module_record_query.safeParse(read.result):null;
   if(!parsed?.success){limitation(`module_record_query read ${read_index}: invalid structured result; grounded fields unavailable`);continue;}
   // Reverse admission plus final reversal retains deterministic original item order.
   for(let item_index=parsed.data.items.length-1;item_index>=0;item_index--)admit({tool:'module_record_query',read_index,item_index,record:parsed.data.items[item_index]!});
   continue;
  }
  let fact:CompilerReadFacts['facts'][number]|null=null;
  if(read.action==='module_record_get'){const parsed=MODULE_OPERATION_RESULT_SCHEMAS.module_record_get.safeParse(read.result);if(parsed.success)fact={tool:'module_record_get',read_index,record:parsed.data.record};}
  if(read.action==='wiki_read'){const parsed=WikiFact.safeParse(read.result);if(parsed.success)fact={tool:'wiki_read',read_index,page:parsed.data};}
  if(!fact){limitation(`${String(read.action)} read ${read_index}: invalid structured result; grounded fields unavailable`);continue;}
  admit(fact);
 }
 out.facts.reverse();return out;
}
export function validateCompilerGrounding<T extends {action:string;params:Record<string,any>}>(actions:T[],context:CompilerReadFacts,prompt:string):{actions:T[];warnings:string[]}{
 const warnings:string[]=[],kept:T[]=[];
 for(const action of actions){
  if(action.action==='module_record_update'){
   const p=action.params,record=[...context.facts].reverse().find(f=>f.tool!=='wiki_read'&&f.record.id===p.record_id&&(!p.module_id||f.record.module_id===p.module_id)&&(!p.collection_key||f.record.collection_key===p.collection_key));
   const candidate=ModuleRecordUpdateRequestSchema.safeParse(Object.fromEntries(Object.entries(p).filter(([k])=>['record_id','patch','unset_fields','relations','expected_revision','expected_manifest_digest','idempotency_key'].includes(k))));
   if(!candidate.success||!record||record.tool==='wiki_read'||p.expected_revision!==record.record.revision||p.expected_manifest_digest!==record.record.manifest_digest){if(warnings.length<8)warnings.push('Module update was not prepared: read the exact record and use its current revision, manifest digest and an explicit requested patch.');continue;}
  }
  if(action.action==='wiki_write'&&action.params.requested_wiki_write_mode!=='create'&&(action.params.requested_wiki_write_mode==='update'||action.params.slug)){
   const page=[...context.facts].reverse().find(f=>f.tool==='wiki_read'&&f.page.slug===action.params.slug);
   if(!page||page.tool!=='wiki_read'){if(warnings.length<8)warnings.push('Wiki update was not prepared: use the exact slug from a successful current wiki read.');continue;}
   // Append requests must contain the actual full body, never instructions
   // pretending that omitted content was preserved. Literal user text is kept.
   if(/\bappend\b/i.test(prompt)&&(typeof action.params.content!=='string'||!action.params.content.startsWith(page.page.content))){if(warnings.length<8)warnings.push('Wiki append was not prepared: supply the current full page body with the requested literal addition, not preservation instructions.');continue;}
  }
  kept.push(action);
 }
 return {actions:kept,warnings};
}
