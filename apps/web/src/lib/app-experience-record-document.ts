import type {ExperienceNode} from './app-experience-bridge';
import type {ExperienceDocumentContext,ExperienceRendererOptions} from './app-experience-renderer';
import type {SourcePresentation} from './app-experience-source-view';
type Reference=Extract<ExperienceNode,{kind:'record_document'}>;
type Document=Extract<ExperienceNode,{kind:'document'}>;
type Presentation={presentation:SourcePresentation;expires_at:string};
/** Explicit app-runtime source references never enter the legacy indexed-row
 * resolver. The host shares only the frozen safe presentation sink/lifecycle. */
export function createExperienceRecordDocumentHost(options:{storeKeys:readonly string[];resourceKeys:readonly string[];current:()=>boolean;
 load:(reference:Reference,signal:AbortSignal)=>Promise<Presentation>;
 mount:(reference:Reference,resolved:Document,wrapper:HTMLElement,current:()=>boolean,load:(signal:AbortSignal)=>Promise<Presentation>)=>()=>void;
}):Pick<ExperienceRendererOptions,'resolveRecordDocument'|'enhanceRecordDocument'>{
 const fetched=new WeakMap<ExperienceDocumentContext,{fingerprint:string;value:Presentation;leaf:Document;cleanup:()=>void}>();
 const fingerprint=(node:Reference)=>JSON.stringify([node.profile_version,node.id,node.store_key,node.resource_key,node.record_id,node.content_digest,node.image_policy??null]);
 const available=(node:Reference,context:ExperienceDocumentContext,value:Presentation,signal:AbortSignal)=>valid(node,context)&&!signal.aborted&&Number.isFinite(Date.parse(value.expires_at))&&Date.parse(value.expires_at)>Date.now();
 const valid=(node:Reference,context:ExperienceDocumentContext)=>options.current()&&context.current()&&!context.signal.aborted
  &&options.storeKeys.includes(node.store_key)&&options.resourceKeys.includes(node.resource_key);
 const read=async(node:Reference,context:ExperienceDocumentContext,signal:AbortSignal)=>{
  if(!valid(node,context)||signal.aborted)throw Error('Record document unavailable');const value=await options.load(node,signal);
  if(!valid(node,context)||signal.aborted||!Number.isFinite(Date.parse(value.expires_at))||Date.parse(value.expires_at)<=Date.now())throw Error('Record document unavailable');return value;
 };
 return {
  async resolveRecordDocument(node,context){fetched.get(context)?.cleanup();const nomination=fingerprint(node);const value=await read(node,context,context.signal);if(fingerprint(node)!==nomination)throw Error('Record document changed');const {presentation}=value;let content='',bytes=0;const encoder=new TextEncoder();
   for(const character of presentation.plain_text){const count=encoder.encode(character).byteLength;if(bytes+count>16384)break;content+=character;bytes+=count;}
   const leaf:Document={kind:'document',id:node.id,format:'plain',content,truncated:presentation.truncated||content.length<presentation.plain_text.length};
   const cleanup=()=>{context.signal.removeEventListener('abort',cleanup);fetched.delete(context);};
   fetched.set(context,{fingerprint:nomination,value,leaf:{...leaf},cleanup});context.signal.addEventListener('abort',cleanup,{once:true});if(context.signal.aborted)cleanup();return leaf;},
  enhanceRecordDocument(node,resolved,wrapper,context){const saved=fetched.get(context);saved?.cleanup();if(!valid(node,context))return;
   if(!saved||saved.fingerprint!==fingerprint(node)||!available(node,context,saved.value,context.signal)||['id','format','content','truncated'].some(key=>resolved[key as keyof Document]!==saved.leaf[key as keyof Document]))throw Error('Record document changed');
   const nomination=saved.fingerprint;let pending:Presentation|undefined=saved.value;
   const dispose=options.mount(node,resolved,wrapper,()=>valid(node,context),async signal=>{const value=pending;pending=undefined;await Promise.resolve();
    if(!value||nomination!==fingerprint(node)||!available(node,context,value,signal))throw Error('Record document unavailable');return value;});let disposed=false;
   const close=()=>{if(disposed)return;disposed=true;pending=undefined;context.signal.removeEventListener('abort',close);dispose();};
   context.signal.addEventListener('abort',close,{once:true});if(!valid(node,context))close();return close;
  },
 };
}
