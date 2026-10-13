'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {CircleHelp} from 'lucide-react';
import type {NativeSearchAccount} from '@/lib/email-native-search';

export const nativeSearchExamples=['from:person@example.com subject:report','"project update" -subject:newsletter','in:drafts subject:report'] as const;
export function nativeSearchUnsupportedReason(value:NativeSearchAccount['unsupported'][number]):string{
 const field=value.field?`“${value.field}:”`:'This filter';
 switch(value.reason){
  case 'unknown_operator':return `${field} is not recognized in native search. Try words, from:, to:, cc: or subject:.`;
  case 'boolean_or_group_not_supported':return 'OR, NOT and grouped expressions are not supported. Combine terms and use - to exclude a term.';
  case 'status_not_supported':return 'This state filter is not supported. Use is:unread, is:read or is:starred where the account supports it.';
  case 'attachment_operator_not_supported':return 'Use has:attachment for attachment searches where the account supports it.';
  case 'internal_date_not_received_utc':case 'kql_received_utc_range_not_supported_by_current_port':return 'Date filters are not supported for this account. Edit the query to search this account.';
  case 'status_not_searchable_in_message_kql':return 'Read and starred state filters are not supported for this account. Edit the query to search this account.';
  case 'attachment_requires_reviewed_mime_evidence':return 'Attachment filters are not supported for this account. Edit the query to search this account.';
  case 'literal_escape_or_wildcard_not_portable':return 'Literal quotes, backslashes and wildcard characters are not supported for this account. Edit the query and search again.';
  case 'negated_day_range_not_supported':return 'Excluding a day with -on: is not supported for this account. Edit the query and search again.';
  case 'compiled_query_limit':return 'This search is too long for this account. Shorten it and search again.';
  case 'folder_scope_not_supported':return 'Use in:inbox, in:sent, in:drafts, in:spam or in:trash to search a provider folder.';
  case 'negated_folder_scope_not_supported':return 'Excluding a folder with -in: is not supported. Choose one positive in: folder filter.';
  case 'conflicting_folder_scopes':return 'Choose one provider folder per query. Different in: folder filters cannot be combined.';
  case 'folder_scope_unavailable':return 'This account could not identify a selectable provider folder for this filter. Choose another folder or edit the query.';
  default:return 'This account cannot use part of this query. Edit the query and search again.';
 }
}
export function NativeEmailSearchHelp(){
 const id=useId(),menu=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),[open,setOpen]=useState(false);
 const close=()=>{setOpen(false);trigger.current?.focus();};
 useEffect(()=>{if(!open)return;const outside=(event:PointerEvent)=>{if(menu.current&&!menu.current.contains(event.target as Node))close();};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[open]);
 return <div ref={menu} data-email-menu-open={open?'true':undefined} className="relative shrink-0" onKeyDown={event=>{if(open&&event.key==='Escape'&&!event.defaultPrevented&&!document.querySelector('[aria-modal="true"]')){event.preventDefault();event.stopPropagation();close();}}}>
  <button ref={trigger} type="button" aria-label="Search help" title="Search help" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)} className="flex items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"><CircleHelp size={14} aria-hidden="true"/>Help</button>
  <div id={id} hidden={!open} role="region" aria-label="Search syntax" className="absolute right-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] space-y-2 rounded-xl bg-[var(--surface-container-low)] p-3 text-xs leading-5 text-[var(--text-secondary)] shadow-xl ring-1 ring-[var(--border)]">
   <p>Combine words or from:, to:, cc: and subject: filters. Quotes keep a phrase together; - excludes a term.</p>
   <ul className="space-y-1">{nativeSearchExamples.map(example=><li key={example}><code className="break-words">{example}</code></li>)}</ul>
   <p>Search one provider folder with in:inbox, in:sent, in:drafts, in:spam or in:trash. in:drafts searches provider Drafts, separate from Deft’s saved drafts.</p>
   <p>Date, read/starred state and attachment filters vary by account. Custom folder names, label: and -in: are not supported.</p>
  </div>
 </div>;
}
