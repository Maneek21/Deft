import {parseNativeMailboxList,formatNativeMailboxList} from '../../../../packages/app-kit/src/mailbox-list';
import type {SourcePresentation} from './app-experience-source-view';
const addressFields:Readonly<Record<string,string>>={From:'reply_from',To:'reply_to_list',Cc:'reply_cc','Reply-To':'reply_to'};
/** Derive display only from the already scoped presentation. Metadata contains
 * the frozen reader's bounded complete address lists; never parse source again. */
export function experiencePresentationHeaders(presentation:SourcePresentation){
 return presentation.headers.map(header=>{
  const field=addressFields[header.label],raw=field?presentation.metadata?.[field]:undefined;
  let value=header.value,incomplete=!!field&&header.value.length>=2048;
  if(typeof raw==='string'&&raw.trim()){
   try{value=formatNativeMailboxList(parseNativeMailboxList(raw));incomplete=false;}
   catch{incomplete=true;}
  }
  return {label:header.label,value,incomplete};
 });
}
export function createExperiencePresentationHeaders(presentation:SourcePresentation):HTMLElement|undefined{
 const headers=experiencePresentationHeaders(presentation);if(!headers.length)return;
 const details=document.createElement('details');details.className='ex-message-details';
 const summary=document.createElement('summary');summary.className='ex-button-ghost';summary.textContent='Message details';details.append(summary);
 const list=document.createElement('dl');list.className='space-y-2 text-sm';
 for(const header of headers){const row=document.createElement('div'),label=document.createElement('dt'),value=document.createElement('dd');
  label.className='text-xs text-[var(--on-surface-variant)]';label.textContent=header.label;
  value.className='whitespace-pre-wrap break-words';value.textContent=header.value||'—';row.append(label,value);
  if(header.incomplete){const notice=document.createElement('p');notice.className='ex-text ex-text-caption';notice.textContent='This address header is incomplete. Download the original message for complete details.';row.append(notice);}
  list.append(row);
 }details.append(list);return details;
}
