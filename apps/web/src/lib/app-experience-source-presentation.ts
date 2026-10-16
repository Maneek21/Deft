import {createExperiencePresentationHeaders} from './app-experience-presentation-headers';
import {api} from './api';
import {createExperiencePresentationElement,printExperiencePresentation,type ExperiencePresentationImageState} from './app-experience-safe-document';
import {readSourceBinary,type SourcePresentation} from './app-experience-source-view';
import type {ExperienceLease} from './app-experience-lease';
import type {ExperienceNode} from './app-experience-bridge';
type Options={wrap:HTMLElement;node:Extract<ExperienceNode,{kind:'document'}>;scope:{exposure_id:string;exposure_epoch:number;review_digest?:string};sessionId:string;resourceKey:string;recordId:string;current:()=>boolean;load:(signal:AbortSignal)=>Promise<{presentation:SourcePresentation;expires_at:string}>;registerPrint?:(print:()=>boolean)=>()=>void;
 readBinary?:(input:{operation:'read_image'|'read_source';image_ref?:string},signal:AbortSignal)=>Promise<{bytes:Uint8Array;media_type:string}>;maxSourceBytes?:number;authorizedLifetime?:()=>ExperienceLease|undefined;automaticImages?:(signal:AbortSignal)=>Promise<boolean|undefined>};

/** The App's document body is only a matching key. Source bytes, nomination
 * references and object URLs remain entirely in this trusted host surface. */
export function mountExperienceSourcePresentation(options:Options):(()=>void)&{attach:(next:HTMLElement)=>void}{
 const {scope,current}=options;let wrap=options.wrap;const controller=new AbortController(),urls=new Map<string,string>(),imageStates=new Map<string,ExperiencePresentationImageState>();let active=true,expires=Infinity,presentation:SourcePresentation|undefined,body:HTMLElement|undefined,loadedBytes=0,budgetExceeded=false;
 let automaticDenied=false;let unregisterPrint:(()=>void)|undefined,headerDetails:HTMLElement|undefined;
 const dispose=()=>{headerDetails?.remove();headerDetails=undefined;active=false;controller.abort();unregisterPrint?.();for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();loadedBytes=0;observer.disconnect();document.removeEventListener('visibilitychange',hidden);clearTimeout(timer);};
 const hidden=()=>{if(document.hidden)dispose();};document.addEventListener('visibilitychange',hidden);
 const observer=new MutationObserver(()=>{if(!wrap.isConnected)dispose();});observer.observe(document.documentElement,{childList:true,subtree:true});let timer:ReturnType<typeof setTimeout>|undefined;
 // Only the new app-data document supplies a freshly validated same-scope lease.
 // Legacy source views retain their original fixed response deadline.
 const expire=()=>{dispose();if(wrap.isConnected)(body??wrap.querySelector('.ex-safe-document'))?.replaceWith(document.createTextNode('Message access expired. Refresh the mailbox to reload.'));};
 const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(valid())arm();else expire();},Math.max(0,expires-Date.now()));};
 const valid=()=>{
  if(!active||controller.signal.aborted)return false;
  if(!current()||document.hidden){if(presentation)expire();return false;}
  if(presentation&&options.authorizedLifetime){
   const lease=options.authorizedLifetime(),next=lease?.exposure;
   const deadline=lease?Math.min(Date.parse(lease.session_expires_at),Date.parse(lease.exposure.expires_at)):NaN;
   if(!scope.review_digest||!next||next.exposure_id!==scope.exposure_id||next.exposure_epoch!==scope.exposure_epoch||next.review_digest!==scope.review_digest||!Number.isFinite(deadline)||deadline<=Date.now()){expire();return false;}
   if(deadline!==expires){expires=deadline;arm();}
  }
  if(Date.now()>=expires){if(presentation)expire();return false;}
  return true;
 };
 const notices=document.createElement('div'),controls=document.createElement('div'),notice=document.createElement('p'),imageStatus=document.createElement('p'),embeddedStatus=document.createElement('p');
 notices.className='ex-message-notices';controls.className='ex-message-image-controls';controls.setAttribute('role','group');controls.setAttribute('aria-label','Message images');
 notice.className=imageStatus.className=embeddedStatus.className='ex-text ex-text-caption';
 for(const status of [notice,imageStatus,embeddedStatus]){status.setAttribute('role','status');status.setAttribute('aria-live','polite');}
 notice.textContent='Loading message formatting…';controls.append(imageStatus);notices.append(notice,controls,embeddedStatus);wrap.prepend(notices);
 const path=`/api/app-experiences/sessions/${encodeURIComponent(options.sessionId)}/resources/${encodeURIComponent(options.resourceKey)}/content`;
 const render=()=>{if(!presentation||!valid()||!wrap.isConnected)return;const next=createExperiencePresentationElement(presentation,presentation.images,urls,imageStates);if(body?.parentElement===wrap){body.replaceWith(next);}else{const old=wrap.querySelector('.ex-safe-document');if(old)old.replaceWith(next);else wrap.append(next);}body=next;};
 const savedChoice=async()=>{
  try{const choice=await options.automaticImages?.(controller.signal);if((choice??presentation?.external_images==='always')&&valid())return true;}catch{/* Unavailable saved choices never fall back to the source default. */}
  automaticDenied=true;if(valid()&&presentation){for(const image of presentation.images.filter(item=>item.kind==='remote')){const url=urls.get(image.image_ref);if(url){URL.revokeObjectURL(url);urls.delete(image.image_ref);}imageStates.delete(image.image_ref);}
   imageStatus.textContent='Your saved image choice changed or is unavailable. External images remain blocked.';render();}return false;
 };
 const loadImages=async(kind:'cid'|'remote',automatic=false)=>{if(!presentation||!valid())return;const queue=presentation.images.filter(image=>image.kind===kind&&!urls.has(image.image_ref));let cursor=0,failed=0,unsupported=0;const status=kind==='remote'?imageStatus:embeddedStatus;
  if(queue.length){status.textContent=kind==='remote'?'Loading external images…':'Loading embedded images…';for(const image of queue)imageStates.set(image.image_ref,'loading');render();}
  const consume=async()=>{for(;;){const image=queue[cursor++];if(!image||!valid()||budgetExceeded)return;try{if(automatic&&(!await savedChoice()))throw Error('Saved image choice unavailable');let bytes:Uint8Array,mediaType:string;
   if(options.readBinary){const result=await options.readBinary({operation:'read_image',image_ref:image.image_ref},controller.signal);bytes=result.bytes;mediaType=result.media_type;
    if(bytes.length>2097152||!['image/png','image/jpeg','image/gif','image/webp'].includes(mediaType)){bytes.fill(0);throw Error('Image unavailable');}}
   else{const r=await api.fetch(path,{method:'POST',signal:controller.signal,body:JSON.stringify({operation:'read_image',record_id:options.recordId,image_ref:image.image_ref})});
   if(r.ok&&r.headers.get('x-deft-exposure-id')===scope.exposure_id&&r.headers.get('x-deft-exposure-epoch')===String(scope.exposure_epoch)&&r.headers.get('content-type')?.startsWith('image/')&&!['image/png','image/jpeg','image/gif','image/webp'].includes(r.headers.get('content-type')??'')){unsupported++;imageStates.set(image.image_ref,'unsupported');await r.body?.cancel();continue;}
   bytes=await readSourceBinary(r,scope,valid,{maxBytes:2097152,image:true});mediaType=r.headers.get('content-type')!;}
   try{if(!valid()||!wrap.isConnected)return;if(automatic&&(!await savedChoice()))throw Error('Saved image choice unavailable');if(loadedBytes+bytes.length>8388608){budgetExceeded=true;throw Error('Image budget exceeded');}const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:mediaType}));loadedBytes+=bytes.length;urls.set(image.image_ref,url);imageStates.delete(image.image_ref);render();}finally{bytes.fill(0);}}catch{failed++;imageStates.set(image.image_ref,budgetExceeded?'limit':'unavailable');}}};
  await consume();if(valid()&&queue.length){
   if(budgetExceeded){for(const image of presentation.images)if(!urls.has(image.image_ref)&&imageStates.get(image.image_ref)==='loading')imageStates.set(image.image_ref,'limit');}
   status.textContent=automaticDenied?'Your saved image choice changed or is unavailable. External images remain blocked.':budgetExceeded?'The 8 MiB image limit for this message was reached. Remaining images were not loaded.':failed||unsupported?[failed?'Some images could not be loaded. Retry to try them again.':'',unsupported?'Some image formats are unsupported. Download the original message to view them.':''].filter(Boolean).join(' '):kind==='remote'?'External images loaded for this message.':'';render();}
 };
 void options.load(controller.signal).then(async value=>{
  if(!valid()||!wrap.isConnected)return;expires=Date.parse(value.expires_at);presentation=value.presentation;arm();
  if(!valid())return;headerDetails=createExperiencePresentationHeaders(presentation);if(headerDetails)notices.prepend(headerDetails);
  render();wrap.querySelector('.ex-document-image-policy')?.remove();wrap.querySelector('.ex-document-truncation')?.remove();notice.textContent=[presentation.rendering_fallback==='plain_text'?'Shown as plain text. Download the original for full formatting.':'',presentation.truncated?'Only part of this message is shown. Download the original source for the complete message.':'',(presentation.omitted_file_count??0)>0?`${presentation.omitted_file_count} additional ${presentation.omitted_file_count===1?'file is':'files are'} not listed. Download the original to access every file.`:''].filter(Boolean).join(' ');imageStatus.textContent=presentation.images.some(image=>image.kind==='remote')?!options.automaticImages&&presentation.external_images==='always'?'External images load automatically using your saved choice for this account.':'External images are blocked until you choose to load them. Loading may tell the sender this message was opened.':'';
  if(presentation.rendering_fallback||presentation.truncated||(presentation.omitted_file_count??0)>0){
    const button=document.createElement('button');button.type='button';button.className='ex-button-ghost';button.textContent='Download original';button.setAttribute('aria-label','Download original message');
    button.onclick=async()=>{if(!valid()||button.disabled)return;button.disabled=true;try{
      let bytes:Uint8Array;if(options.readBinary){const result=await options.readBinary({operation:'read_source'},controller.signal);bytes=result.bytes;
       if(result.media_type!=='message/rfc822'||bytes.length>(options.maxSourceBytes??8388608)){bytes.fill(0);throw Error('Source unavailable');}}
      else{const response=await api.fetch(path,{method:'POST',signal:controller.signal,body:JSON.stringify({operation:'read_source',record_id:options.recordId})});
       bytes=await readSourceBinary(response,scope,valid,{mediaType:'message/rfc822',signal:controller.signal});}try{if(!valid())return;
        const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'message/rfc822'}));try{const anchor=document.createElement('a');anchor.href=url;anchor.download='message.eml';anchor.click();}finally{URL.revokeObjectURL(url);}
      }finally{bytes.fill(0);}
    }catch{if(valid())notice.textContent=`The original message could not be downloaded. This view supports originals up to ${(options.maxSourceBytes??8388608)/1048576} MiB. Try again.`;}finally{if(valid())button.disabled=false;}};
    notices.append(button);
  }
  // Supersede the small leaf print action with the authoritative complete source
  // body while retaining the current document's verified header labels.
  unregisterPrint=options.registerPrint?.(()=>{if(!valid()||!presentation)return true;const title=presentation.headers.find(row=>row.label==='Subject')?.value??'Message';printExperiencePresentation(presentation,title,presentation.headers,presentation.images,urls);return true;});
  let remoteAction:((automatic?:boolean)=>Promise<void>)|undefined;
  if(presentation.images.some(image=>image.kind==='remote')){const button=document.createElement('button');button.type='button';button.className='ex-button-ghost';button.textContent='Load external images';button.setAttribute('aria-label','Load external images for this message');remoteAction=async(automatic=false)=>{if(!valid()||button.disabled)return;button.disabled=true;button.setAttribute('aria-busy','true');await loadImages('remote',automatic);if(valid()){button.disabled=budgetExceeded;button.removeAttribute('aria-busy');if(presentation!.images.filter(image=>image.kind==='remote').every(image=>urls.has(image.image_ref))){button.remove();}else{button.textContent=budgetExceeded?'Image limit reached':'Retry external images';button.setAttribute('aria-label',budgetExceeded?'Image limit reached for this message':'Retry external images for this message');}}};button.onclick=()=>{automaticDenied=false;return remoteAction?.()??Promise.resolve();};controls.append(button);}
  await loadImages('cid');
  if(valid()&&remoteAction){
   if(options.automaticImages){try{const choice=await options.automaticImages(controller.signal);if((choice??presentation.external_images==='always')&&valid()){imageStatus.textContent='Loading external images…';await remoteAction?.(true);}}catch{if(valid())imageStatus.textContent='Your saved image choice is unavailable. External images remain blocked.';}}
   else if(presentation.external_images==='always')await remoteAction?.();
  }
 }).catch(()=>{if(valid()&&wrap.isConnected)notice.textContent=wrap.querySelector('.ex-safe-document')?.textContent?.trim()?'Full message formatting is unavailable. The loaded text is still shown.':'Message content is unavailable. Refresh the mailbox, then load this message again.';});
 return Object.assign(dispose,{attach:(next:HTMLElement)=>{if(!valid()){dispose();return;}wrap=next;if(body){wrap.querySelector('.ex-safe-document')?.remove();wrap.querySelector('.ex-document-image-policy')?.remove();wrap.querySelector('.ex-document-truncation')?.remove();}wrap.prepend(notices);if(body)wrap.append(body);}});
}
