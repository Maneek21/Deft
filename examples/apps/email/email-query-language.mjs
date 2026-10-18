/** Shared, bounded user query syntax. This is a compiler, not a search grant or
 * index. Existing provider-native queries and metadata-only browser search are
 * separate contracts and are never silently reinterpreted here. */
export const EMAIL_QUERY_LIMITS=Object.freeze({characters:2048,terms:32,value:500});
export class EmailQueryError extends Error{constructor(code,position){super(code);this.name='EmailQueryError';this.code=code;this.position=position;}}
const bad=position=>{throw new EmailQueryError('EMAIL_QUERY_INVALID',position);};
const known=new Set(['text','from','to','cc','subject','after','before','on','is','has','larger','smaller','in']);
const byteSize=value=>{const match=/^([1-9]\d*)([KMG])?$/iu.exec(value);if(!match)return null;const bytes=Number(match[1])*({K:1000,M:1000000,G:1000000000}[match[2]?.toUpperCase()]??1);return Number.isSafeInteger(bytes)&&bytes<=4294967295?bytes:null;};
function instant(value,dayOnly=false){
 if(/^\d{4}-\d{2}-\d{2}$/u.test(value)){const time=Date.parse(value+'T00:00:00Z');if(Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value)return time/1000;return null;}
 if(dayOnly||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/u.test(value))return null;
 // Reject normalized invalid calendar days rather than Date.parse rollover.
 const day=instant(value.slice(0,10),true),time=Date.parse(value);return day!==null&&Number.isFinite(time)?time/1000:null;
}
export function parseEmailQuery(original_query){
 if(typeof original_query!=='string'||!original_query.trim()||original_query.length>EMAIL_QUERY_LIMITS.characters||/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(original_query))bad(0);
 const terms=[];let index=0,expectTerm=false;
 while(index<original_query.length){
  while(/\s/u.test(original_query[index]??'')&&index<original_query.length)index++;if(index===original_query.length)break;
  const start=index;let exclude=false,field='text',quoted=false,value='';
  if(original_query[index]==='-'){exclude=true;index++;if(index===original_query.length||/\s/u.test(original_query[index]))bad(start);}
  const operator=/^([A-Za-z_][A-Za-z_0-9]*):/u.exec(original_query.slice(index));if(operator){field=operator[1].toLowerCase();index+=operator[0].length;}
  if(index===original_query.length||/\s/u.test(original_query[index]))bad(index);
  if(original_query[index]==='"'){quoted=true;index++;let closed=false;
   while(index<original_query.length){const char=original_query[index++];if(char==='"'){closed=true;break;}
    if(char==='\\'){const next=original_query[index++];if(!['"','\\',':','-',' '].includes(next))bad(index-1);value+=next;}else value+=char;
   }
   if(!closed||index<original_query.length&&!/\s/u.test(original_query[index]))bad(index);
  }else{
   while(index<original_query.length&&!/\s/u.test(original_query[index])){const char=original_query[index++];if(char==='"')bad(index-1);
    if(char==='\\'){const next=original_query[index++];if(!['"','\\',':','-',' '].includes(next))bad(index-1);value+=next;}else value+=char;
   }
  }
  if(!value.trim()||value.length>EMAIL_QUERY_LIMITS.value)bad(start);
  if(!quoted&&field==='text'&&!exclude&&value==='AND'){if(!terms.length||expectTerm)bad(start);expectTerm=true;continue;}
  expectTerm=false;
  let unsupported=null;
  if(!known.has(field))unsupported='unknown_operator';
  else if(!quoted&&field==='text'&&(['OR','NOT'].includes(value)||/[(){}]/u.test(value)))unsupported='boolean_or_group_not_supported';
  let normalized=value;
  if(['after','before','on'].includes(field)){normalized=instant(value,field==='on');if(normalized===null)bad(start);}
  if(['larger','smaller'].includes(field)){normalized=byteSize(value);if(normalized===null)bad(start);}
  if(field==='is'){normalized=value.toLowerCase();if(!['unread','read','starred'].includes(normalized))unsupported='status_not_supported';}
  if(field==='in'){normalized=value.toLowerCase();if(!['inbox','sent','drafts','spam','trash'].includes(normalized))unsupported='folder_scope_not_supported';}
  if(field==='has'){normalized=value.toLowerCase();if(normalized!=='attachment')unsupported='attachment_operator_not_supported';}
  terms.push({field,value:normalized,exclude,quoted,position:start,unsupported});if(terms.length>EMAIL_QUERY_LIMITS.terms)bad(start);
 }
 if(expectTerm||!terms.length)bad(index);
 return Object.freeze({version:1,original_query,date_basis:'received_utc',size_unit:'bytes_decimal_suffix',terms:Object.freeze(terms.map(term=>Object.freeze(term)))});
}
const limitations={gmail:['provider_tokenization','no_alias_expansion','message_not_thread_search','provider_attachment_classification','epoch_seconds_date_precision'],
 microsoft:['provider_tokenization','provider_default_text_fields_from_subject_body','provider_result_cap_1000','non_inline_attachment_only'],
 imap_smtp:['provider_text_includes_headers_body','server_unicode_search_support','mailbox_scoped_search','size_is_rfc822_octets']};

/** Always recompiles the original text and rejects a modified caller AST. This
 * prevents unsupported fields, extra nodes or altered typed values from taking
 * a different execution path than the query preserved for the human. */
export function compileEmailQuery(provider,input){
 if(!Object.hasOwn(limitations,provider))throw new EmailQueryError('EMAIL_QUERY_PROVIDER_INVALID',0);
 const ast=typeof input==='string'?parseEmailQuery(input):parseEmailQuery(input?.original_query);
 if(typeof input!=='string'&&JSON.stringify(input)!==JSON.stringify(ast))throw new EmailQueryError('EMAIL_QUERY_AST_INVALID',0);
 const unsupported=[],clauses=[];let folderRole=null;
 for(const [index,term]of ast.terms.entries()){
  let reason=term.unsupported;
  if(!reason&&term.field==='in'&&term.exclude)reason='negated_folder_scope_not_supported';
  if(!reason&&term.field==='in'&&folderRole!==null&&folderRole!==term.value)reason='conflicting_folder_scopes';
  if(!reason&&['after','before','on'].includes(term.field)&&provider!=='gmail')reason=provider==='imap_smtp'?'internal_date_not_received_utc':'kql_received_utc_range_not_supported_by_current_port';
  if(!reason&&provider==='microsoft'&&term.field==='is')reason='status_not_searchable_in_message_kql';
  if(!reason&&provider==='imap_smtp'&&term.field==='has')reason='attachment_requires_reviewed_mime_evidence';
  if(!reason&&provider!=='imap_smtp'&&typeof term.value==='string'&&/["\\*?]/u.test(term.value))reason='literal_escape_or_wildcard_not_portable';
  if(!reason&&provider==='gmail'&&term.field==='on'&&term.exclude)reason='negated_day_range_not_supported';
  if(reason){unsupported.push({index,field:term.field,reason});continue;}
  const {field,value,exclude}=term;
  if(field==='in'){folderRole=value;continue;}
  if(provider==='imap_smtp'){
   let predicate;
   if(field==='is')predicate=value==='starred'?{flagged:true}:{seen:value==='read'};
   else predicate={[field]:value};
   clauses.push(exclude?{not:predicate}:predicate);continue;
  }
  const quote=typeof value==='string'?`"${value}"`:null;let clause;
  if(field==='is')clause='is:'+value;
  else if(field==='has')clause=provider==='gmail'?'has:attachment':'hasAttachments:true';
  else if(field==='on')clause=`(after:${value} before:${value+86400})`;
  else if(['after','before','larger','smaller'].includes(field))clause=provider==='microsoft'?`size${field==='larger'?'>':'<'}${value}`:`${field}:${value}`;
  else clause=field==='text'?quote:`${field}:${quote}`;
  clauses.push(exclude?(provider==='gmail'?'-'+clause:'NOT '+clause):clause);
 }
 const result={provider,original_query:ast.original_query,ast,limitations:[...limitations[provider]]};
 // Never expose an executable partial query if ANY term cannot be translated.
 if(unsupported.length)return {...result,status:'unsupported',unsupported};
 if(provider==='imap_smtp')return {...result,status:'supported',request:{search:clauses.length===0?{all:true}:clauses.length===1?clauses[0]:{not:{or:clauses.map(clause=>({not:clause}))}},uid:true,...(folderRole?{folder_role:folderRole}:{})}};
 const query=clauses.join(provider==='gmail'?' ':' AND ');if(query.length>2048)return {...result,status:'unsupported',unsupported:[{index:null,field:null,reason:'compiled_query_limit'}]};
 return {...result,status:'supported',request:{query,...(folderRole?{folder_role:folderRole}:{})}};
}
