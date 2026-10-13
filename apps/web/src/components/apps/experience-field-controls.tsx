'use client';
import {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {ExperienceNode} from '@/lib/app-experience-bridge';
import type {ExperienceRendererOptions,ExperienceUiEvent,ExperienceDocumentContext} from '@/lib/app-experience-renderer';
import {createExperienceFileController,validateExperienceRichtextEdit} from '@/lib/app-experience-controls';
import {privateFilesForControls,type ComposerFilesPolicy,type ComposerPrivateFiles} from '@/lib/app-experience-compose-files';
import {ExperienceComposeRichEditor} from './experience-compose-controls-rich-editor';
import {ExperienceComposeFilesControl} from './experience-compose-controls';

type Control=Extract<ExperienceNode,{kind:'richtext_field'|'file_field'|'resource_refresh'}>;
type Host={filesPolicy:(node:Extract<Control,{kind:'file_field'}>,signal:AbortSignal)=>Promise<ComposerFilesPolicy>;
  filesCall:(node:Extract<Control,{kind:'file_field'}>,suffix:string,options:RequestInit)=>Promise<unknown>};
function RichField({node,emit,context}:{node:Extract<Control,{kind:'richtext_field'}>;emit:(event:ExperienceUiEvent)=>unknown;context:ExperienceDocumentContext}) {
  const [value,setValue]=useState({html:node.value.html,plainText:node.value.plain_text}),[notice,setNotice]=useState('');
  const published=useRef<string[]>([]);
  useEffect(()=>{const incoming=JSON.stringify(node.value),index=published.current.indexOf(incoming);
    if(index>=0){published.current.splice(0,index+1);return;}
    published.current=[];setValue({html:node.value.html,plainText:node.value.plain_text});
  },[node.value.html,node.value.plain_text]);
  return <div><ExperienceComposeRichEditor label={node.label} value={value} maxCharacters={node.profile.max_characters}
    maxPlainCharacters={node.profile.max_characters} preserveWhitespace nativeLinks={node.profile.links==='host_validated'} disabled={node.disabled}
    validateValue={next=>{validateExperienceRichtextEdit(node,next);}}
    onChange={next=>{if(!context.current()||context.signal.aborted)return;try{const richtext=validateExperienceRichtextEdit(node,next);
      published.current.push(JSON.stringify(richtext));if(published.current.length>32)published.current.shift();
      setValue(next);setNotice('');void emit({kind:'input',node_id:node.id,richtext});
    }catch{setNotice('This edit exceeds the selected limit. Your previous draft is kept.');}}}/>
    {notice&&<p role="status" className="text-xs text-[var(--error)]">{notice}</p>}</div>;
}
function FileField({node,emit,context,host}:{node:Extract<Control,{kind:'file_field'}>;emit:(event:ExperienceUiEvent)=>unknown;context:ExperienceDocumentContext;host:Host}) {
  const [manifest,setManifest]=useState<ComposerPrivateFiles|null>(null),[notice,setNotice]=useState('Opening files…'),[busy,setBusy]=useState(true),[blocked,setBlocked]=useState(false);
  const controller=useRef(createExperienceFileController({node,current:context.current,signal:context.signal,
    policy:signal=>host.filesPolicy(node,signal),call:(suffix,options)=>host.filesCall(node,suffix,options)}));
  const current=()=>context.current()&&!context.signal.aborted;
  useEffect(()=>{let mounted=true;void controller.current.load().then(value=>{if(mounted&&current()){setManifest(value);setNotice('');setBusy(false);}})
    .catch(()=>{if(mounted&&current()){setNotice('Files unavailable. Reopen the draft to verify its saved revision.');setBlocked(true);setBusy(false);}});return()=>{mounted=false;};},[]);
  async function change(operation:()=>Promise<ComposerPrivateFiles>){if(!current()||busy||blocked)return;setBusy(true);
    try{const value=await operation();if(!current())return;setManifest(value);setNotice('');
      await emit({kind:'input',node_id:node.id,draft_revision:value.draft.revision,file_ids:value.files.map(row=>row.file_id)});
    }catch{if(current()){setBlocked(true);setNotice('The file change could not be confirmed. Reopen this draft before retrying.');}}
    finally{if(current())setBusy(false);}}
  return <div><ExperienceComposeFilesControl label={node.label} files={manifest?privateFilesForControls(manifest.files,
    {draftId:node.record_id,revision:manifest.draft.revision,resourceTargetKey:'current'}):[]} disabled={node.disabled||busy||blocked}
    acceptedMediaTypes={controller.current.policy?.allowed_media_types} onSelectFiles={files=>{if(files.length!==1){setNotice('Select one file at a time.');return;}void change(()=>controller.current.upload(files[0]));}}
    onRemove={fileId=>{void change(()=>controller.current.remove(fileId));}}/>
    {notice&&<p role="status" className="text-xs text-[var(--error)]">{notice}</p>}</div>;
}
/** Only the trusted page mounts React controls; author code supplies inert nodes. */
export function createExperienceFieldControlHost(host:Host): Pick<ExperienceRendererOptions,'mountControl'> {
  // Reuse the rich editor through ordinary author acknowledgements. Disposal is
  // deferred only until the current synchronous render can adopt the same node;
  // the old context is already aborted, so callbacks are fenced immediately.
  const rich=new Map<string,{element:HTMLDivElement;root:ReturnType<typeof createRoot>;context:ExperienceDocumentContext;generation:number;profile:string}>();
  return {mountControl(node,wrapper,emit,context){
    if(node.kind==='resource_refresh'){wrapper.textContent='Refresh unavailable.';return;}
    if(node.kind==='richtext_field'){
      const profile=JSON.stringify(node.profile);let entry=rich.get(node.id);
      if(entry&&entry.profile!==profile){entry.root.unmount();rich.delete(node.id);entry=undefined;}
      if(!entry){const element=document.createElement('div');entry={element,root:createRoot(element),context,generation:0,profile};rich.set(node.id,entry);}
      entry.context=context;const owned=entry,generation=++owned.generation;
      const currentContext={get signal(){return owned.context.signal;},current:()=>owned.context.current()&&!owned.context.signal.aborted};
      wrapper.append(owned.element);owned.root.render(<RichField node={node} emit={emit} context={currentContext}/>);
      return()=>queueMicrotask(()=>{if(owned.generation!==generation)return;owned.root.unmount();if(rich.get(node.id)===owned)rich.delete(node.id);});
    }
    const root=createRoot(wrapper);
    root.render(<FileField node={node} emit={emit} context={context} host={host}/>);
    return()=>root.unmount();
  }};
}
