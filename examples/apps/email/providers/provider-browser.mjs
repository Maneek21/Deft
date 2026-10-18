import {LogicalMailIndex,validateProviderLocator} from '../logical-mail-index.mjs';
import {projectEmailMetadata} from '../metadata-resource.mjs';
import {projectProviderDocument} from './resource-reader.mjs';
import {oauthFail} from './oauth-contract.mjs';
import {compileEmailSearch} from '../message-search.mjs';

const SOURCE_VERSION='deft.email_provider_source.v1';
const sourceKeys='account_id,authority_epoch,conversation_id,locator,logical_message_id,provider,schema_version';
const fail=()=>oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');
const text=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
const labels={inbox:['INBOX'],sent:['SENT'],spam:['SPAM'],trash:['TRASH'],archive:[],all:[]};
const searchOperators={subject:'subject',sender:'from',recipients:'to',cc:'cc'};
const folded=value=>value.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
function metadataSearch(query,allowed){
 if(!Array.isArray(allowed)||allowed.length>64||allowed.some(field=>typeof field!=='string'||field.length>200))fail();
 const fields=Object.keys(searchOperators).filter(field=>allowed.includes(field)),words=query.match(/[\p{L}\p{N}_@.+-]+/gu)?.slice(0,16);
 if(!fields.length||!words?.length)fail();
 // Only quoted word tokens reach Gmail. Caller punctuation cannot introduce
 // an operator, body term, alternate header or boolean query expression.
 const scoped='('+fields.map(field=>'('+words.map(word=>searchOperators[field]+':"'+word+'"').join(' ')+')').join(' OR ')+')';
 const needle=folded(query);
 return {query:scoped,matches:message=>fields.some(field=>typeof message[field]==='string'&&folded(message[field]).includes(needle))};
}
const stopped=signal=>{if(signal!==undefined&&!(signal instanceof AbortSignal))fail();signal?.throwIfAborted();};
function identity(scope,account,message){
 if(message?.account_id!==account.account_id||message.provider!==account.provider)fail();
 // This short-lived index computes the existing stable logical identities only.
 // It is never loaded from disk, committed, checkpointed or used as a cache.
 return new LogicalMailIndex(scope).upsert(scope,message);
}
export function providerSourceForParent(account,parent){return {schema_version:SOURCE_VERSION,account_id:account.account_id,provider:account.provider,authority_epoch:account.authority_epoch,logical_message_id:parent.logical_message_id,conversation_id:parent.conversation_id,locator:structuredClone(parent.locator)};}
export function resolveProviderSource({scope,account,source}){
 if(!source||Array.isArray(source)||Object.keys(source).sort().join(',')!==sourceKeys||source.schema_version!==SOURCE_VERSION
  ||source.account_id!==account.account_id||source.provider!==account.provider||source.authority_epoch!==account.authority_epoch)fail();
 const locator=validateProviderLocator(source.locator);
 const parent=identity(scope,account,{account_id:account.account_id,provider:account.provider,locator});
 if(parent.logical_message_id!==source.logical_message_id||parent.conversation_id!==source.conversation_id)fail();
 return parent;
}
function itemFor(scope,account,message){
 const parent=identity(scope,account,message),projection=projectEmailMetadata(parent);
 return {revision:projection.revision,label:projection.data.label,data:projection.data,provider_source:providerSourceForParent(account,parent)};
}
function normalized(input){
 if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!==(input.filters?'cursor,filters,folder,limit,operation,query,source':'cursor,folder,limit,operation,query,source')
  ||!['list','search','conversation'].includes(input.operation)||!Object.hasOwn(labels,input.folder)||!text(input.query,200)
  ||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>10
  ||input.cursor!==null&&(!text(input.cursor,8192)||!input.cursor)
  ||input.operation==='search'&&(!!input.query.trim()===!!input.filters)||input.operation!=='search'&&(input.query!==''||input.filters!==undefined)
  ||(input.operation==='conversation'?!input.source:input.source!==null))fail();
 return input;
}
export async function browseProviderResource({input,scope,account,adapter,check,signal,search_fields,search_filters}){
 input=normalized(input);stopped(signal);await check();stopped(signal);
 // Gmail's label semantics are explicit. Other providers must supply their
 // own reviewed folder mapping rather than pretending Gmail labels are portable.
 if(!['gmail','microsoft'].includes(account.provider))oauthFail('EMAIL_PROVIDER_OPERATION_UNSUPPORTED');
 if(input.filters&&(!Array.isArray(search_filters)||Object.keys(input.filters).some(key=>!search_filters.includes(key))))fail();
 let page,search=null;
 if(input.operation==='conversation'){
  const parent=resolveProviderSource({scope,account,source:input.source});
  page=await adapter.readConversation({...(account.provider==='gmail'?{thread_id:parent.locator.thread_id}:{conversation_id:parent.conversation_id}),limit:input.limit,cursor:input.cursor});
 }else{
  const archive=input.folder==='archive'?'-in:inbox -in:sent -in:drafts -in:spam -in:trash':'';
  search=input.operation==='search'&&!input.filters?metadataSearch(input.query,search_fields):null;
  const query=[archive,search?.query??''].filter(Boolean).join(' ');
  const folder=account.provider==='gmail'?{label_ids:labels[input.folder],include_spam_trash:['all','spam','trash'].includes(input.folder)}:{...(input.folder==='all'?{}:{folder_id:{inbox:'inbox',sent:'sentitems',spam:'junkemail',trash:'deleteditems',archive:'archive'}[input.folder]})};
  const request=input.filters?compileEmailSearch(account.provider,{filters:input.filters,limit:input.limit,cursor:input.cursor,...folder}).request:{limit:input.limit,cursor:input.cursor,query:account.provider==='gmail'?query:search?.query??'',...folder};
  if(input.filters&&account.provider==='gmail'&&archive)request.query=[archive,request.query].join(' ');
  page=await (input.operation==='search'?adapter.searchMessages(request):adapter.listMessages(request));
 }
 stopped(signal);await check();stopped(signal);
 if(page?.account_id!==account.account_id||!Array.isArray(page.messages)||page.messages.length>input.limit
  ||!Array.isArray(page.failures)||page.failures.length>input.limit||typeof page.complete!=='boolean'
  ||page.next_cursor!==null&&(!text(page.next_cursor,8192)||!page.next_cursor)
  ||typeof page.observed_at!=='string'||!Number.isFinite(Date.parse(page.observed_at)))fail();
 const items=page.messages.filter(message=>!search||search.matches(message)).map(message=>itemFor(scope,account,message));
 if(input.operation==='conversation'&&items.some(item=>item.provider_source.conversation_id!==input.source.conversation_id))fail();
 await check();stopped(signal);
 return {schema_version:'deft.app_provider_browse_page.v1',items,next_cursor:page.next_cursor,complete:page.complete,
  observed_at:page.observed_at,count:{returned:items.length,exact_total:null},failure_count:page.failures.length};
}
export async function readProviderSource({source,scope,account,adapter,check,max_characters,signal,formats=['plain']}){
 stopped(signal);const parent=resolveProviderSource({scope,account,source});await check();stopped(signal);
 const detail=await adapter.readMessage(parent.locator);stopped(signal);await check();
 const actual=identity(scope,account,detail.message);
 if(actual.logical_message_id!==parent.logical_message_id||actual.conversation_id!==parent.conversation_id)fail();
 const result=await projectProviderDocument({account,logical_message_id:parent.logical_message_id,detail,max_characters,formats});
 result.document.metadata={...result.document.metadata,conversation_id:parent.conversation_id,
  conversation_coverage_state:'unknown',conversation_indexed_count:'0',conversation_exact_count:'',
  conversation_observed_at:'',conversation_drained:'false',mailbox_reset_required:'false'};
 await check();stopped(signal);return result;
}
