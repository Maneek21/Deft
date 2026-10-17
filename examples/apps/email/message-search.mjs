import {fail,text,pageLimit,PROVIDER_LIMITS} from './providers/contract.mjs';

const common=['text','from','to','cc','bcc','subject','filename','has_attachments','received_on'];
export const EMAIL_SEARCH_CAPABILITIES=Object.freeze({gmail:Object.freeze([...common,'after','before','unread','flagged']),microsoft:Object.freeze([...common]),imap_smtp:Object.freeze([])});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const term=value=>{text(value,500);if(/["\\\u0000-\u001f\u007f]/u.test(value))fail('EMAIL_SEARCH_FILTER_INVALID');return `"${value}"`;};
function day(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/u.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail('EMAIL_SEARCH_FILTER_INVALID');return value;}
function instant(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().replace('.000Z','Z')!==value)fail('EMAIL_SEARCH_FILTER_INVALID');return Math.floor(Date.parse(value)/1000);}

// A full native query is deliberately separate from quoted structured values.
// Provider queries are not a local-index search and never broaden account scope.
export function compileEmailSearch(provider,input={}) {
 if(!Object.hasOwn(EMAIL_SEARCH_CAPABILITIES,provider)||!object(input)||Object.keys(input).some(key=>!['provider_query','filters','limit','cursor','folder_id','label_ids','include_spam_trash'].includes(key)))fail('EMAIL_SEARCH_REQUEST_INVALID');
 if(provider==='imap_smtp')fail('EMAIL_PROVIDER_OPERATION_UNSUPPORTED');
 const limit=pageLimit(input.limit),cursor=input.cursor??null;
 if(cursor!==null)text(cursor,PROVIDER_LIMITS.cursor_bytes);
 const filters=input.filters??{};
 if(!object(filters)||Object.keys(filters).some(key=>!EMAIL_SEARCH_CAPABILITIES[provider].includes(key)))fail('EMAIL_SEARCH_FILTER_UNSUPPORTED');
 const native=input.provider_query!==undefined;
 if(native&&Object.keys(filters).length)fail('EMAIL_SEARCH_REQUEST_INVALID');
 const clauses=[];
 for(const key of ['from','to','cc','bcc','subject'])if(filters[key]!==undefined)clauses.push(`${key}:${term(filters[key])}`);
 if(filters.text!==undefined)clauses.push(term(filters.text));
 if(filters.filename!==undefined)clauses.push(`${provider==='gmail'?'filename':'attachment'}:${term(filters.filename)}`);
 if(filters.has_attachments!==undefined){if(typeof filters.has_attachments!=='boolean')fail('EMAIL_SEARCH_FILTER_INVALID');clauses.push(provider==='gmail'?`${filters.has_attachments?'':'-'}has:attachment`:`hasAttachments:${filters.has_attachments}`);}
 if(filters.received_on!==undefined){
  const date=day(filters.received_on);
  if(provider==='gmail'){const start=Date.parse(date)/1000;clauses.push(`after:${start}`,`before:${start+86400}`);}
  else clauses.push(`received:${date.slice(5,7)}/${date.slice(8,10)}/${date.slice(0,4)}`);
 }
 if(filters.after!==undefined||filters.before!==undefined){
  if(filters.received_on!==undefined)fail('EMAIL_SEARCH_FILTER_INVALID');
  const after=filters.after===undefined?null:instant(filters.after),before=filters.before===undefined?null:instant(filters.before);
  if(after!==null&&before!==null&&after>=before)fail('EMAIL_SEARCH_FILTER_INVALID');
  if(after!==null)clauses.push(`after:${after}`);if(before!==null)clauses.push(`before:${before}`);
 }
 for(const [key,operator]of [['unread','is:unread'],['flagged','is:starred']])if(filters[key]!==undefined){if(typeof filters[key]!=='boolean')fail('EMAIL_SEARCH_FILTER_INVALID');clauses.push(`${filters[key]?'':'-'}${operator}`);}
 const query=native?text(input.provider_query,2048):clauses.join(provider==='microsoft'?' AND ':' ');
 text(query,2048);
 const request={query,limit,cursor};
 if(provider==='gmail'){
  if(input.folder_id!==undefined)fail('EMAIL_SEARCH_FILTER_UNSUPPORTED');
  if(input.label_ids!==undefined){if(!Array.isArray(input.label_ids)||input.label_ids.length>100||new Set(input.label_ids).size!==input.label_ids.length)fail('EMAIL_SEARCH_FILTER_INVALID');request.label_ids=input.label_ids.map(value=>text(value));}
  if(input.include_spam_trash!==undefined){if(typeof input.include_spam_trash!=='boolean')fail('EMAIL_SEARCH_FILTER_INVALID');request.include_spam_trash=input.include_spam_trash;}
 }else{
  if(input.label_ids!==undefined||input.include_spam_trash!==undefined)fail('EMAIL_SEARCH_FILTER_UNSUPPORTED');
  if(input.folder_id!==undefined)request.folder_id=text(input.folder_id);
 }
 return {provider,mode:native?'native':'filters',request,limitations:provider==='microsoft'?['provider_result_cap_1000','non_inline_attachment_filter','provider_date_timezone']:['no_alias_expansion','message_not_thread_search','provider_after_before_boundaries']};
}

export function createEmailMessageSearch({runtime}) {
 if(!runtime||typeof runtime.listAccounts!=='function'||typeof runtime.searchMessages!=='function')fail('EMAIL_SEARCH_RUNTIME_REQUIRED');
 return Object.freeze({async search({account_id,...input}){
  text(account_id,256);const accounts=await runtime.listAccounts();
  if(!Array.isArray(accounts)||accounts.length>32)fail('EMAIL_SEARCH_RUNTIME_INVALID');
  const account=accounts.find(row=>row.account_id===account_id);if(!account)fail('EMAIL_ACCOUNT_NOT_FOUND');
  const compiled=compileEmailSearch(account.provider,input);
  // The runtime rederives current search authority; a visible descriptor is not
  // itself permission to read, nor can a request choose a native account ID.
  const page=await runtime.searchMessages(account_id,compiled.request);
  if(!object(page)||page.account_id!==account_id||!Array.isArray(page.messages)||page.messages.length>compiled.request.limit||page.messages.some(row=>row.account_id!==account_id)||typeof page.complete!=='boolean'||typeof page.has_more!=='boolean')fail('EMAIL_SEARCH_RUNTIME_INVALID');
  if(account.provider==='microsoft'&&page.complete!==false)fail('EMAIL_SEARCH_RUNTIME_INVALID');
  return {...page,search:{provider:compiled.provider,mode:compiled.mode,provider_query:compiled.request.query,limitations:compiled.limitations}};
 }});
}
