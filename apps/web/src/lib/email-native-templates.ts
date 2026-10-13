import {parseNativeSafeComposeHtml as parseSafeComposeHtml,plainTextToNativeComposeHtml} from '../../../../packages/app-kit/src/safe-compose-html';
import {parseNativeDraftContent,type NativeDraftContent} from './email-native-drafts';
import {detachNativeSignatureRegion} from './email-native-signature-region';

export type NativeTemplateContent={title:string;subject:string;body:string;body_html:string};
export type NativeEmailTemplate={template_id:string;account_id:string;revision:number;status:'active'|'archived';content:NativeTemplateContent;created_at:string;updated_at:string};
export type NativeTemplateText=Pick<NativeTemplateContent,'subject'|'body'|'body_html'>;
export class NativeTemplateError extends Error{
 constructor(readonly kind:'denied'|'conflict'|'missing'|'invalid'|'unavailable',message?:string){super(message??(kind==='denied'?'Template access changed. Reconnect this account in Email settings.':kind==='conflict'?'This template changed elsewhere. Your edits are kept here. Reload its saved version before saving again.':kind==='missing'?'This template is no longer available.':kind==='invalid'?'Check the template title, text, placeholders and size.':'The template change could not be confirmed. Check its saved version before saving again.'));}
}
const closed=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=1&&value<=2147483647;
const marker=/\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}/gu;
export function nativeTemplatePlaceholders(content:NativeTemplateText){return [...new Set([content.subject,content.body,content.body_html].flatMap(text=>[...text.matchAll(marker)].map(match=>match[1]!)))].sort();}
export function parseNativeTemplateContent(value:unknown):NativeTemplateContent{
 const invalid=()=>{throw new NativeTemplateError('invalid');};
 if(!closed(value,['title','subject','body','body_html'])||typeof value.title!=='string'||!value.title.trim()||value.title.trim().length>120||/[\u0000-\u001f\u007f-\u009f]/u.test(value.title)||typeof value.subject!=='string'||value.subject.length>998||/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value.subject)||typeof value.body!=='string'||value.body.length>262144||/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value.body)||typeof value.body_html!=='string'||value.body_html.length>262144)return invalid();
 const content={title:value.title.trim(),subject:value.subject,body:value.body,body_html:value.body_html};
 if(new TextEncoder().encode(JSON.stringify(content)).byteLength>480*1024)return invalid();
 for(const text of [content.subject,content.body,content.body_html]){
  const remainder=text.replace(marker,'');if(remainder.includes('{{')||remainder.includes('}}'))return invalid();
  if([...text.matchAll(/\b(?:https?:\/\/|mailto:|www\.)[^\s<>]*/giu)].some(match=>match[0].includes('{{')||match[0].includes('}}')))throw new NativeTemplateError('invalid','Placeholders can appear in message text, but cannot change a URL.');
 }
 try{if(content.body_html&&parseSafeComposeHtml(content.body_html).plainText!==content.body)return invalid();}catch{return invalid();}
 if(nativeTemplatePlaceholders(content).length>64)return invalid();return content;
}
export function parseNativeEmailTemplate(value:unknown,accountId:string):NativeEmailTemplate{
 if(!closed(value,['template_id','account_id','revision','status','content','created_at','updated_at'])||value.account_id!==accountId||!uuid(value.template_id)||!positive(value.revision)||!['active','archived'].includes(String(value.status))||![value.created_at,value.updated_at].every(date=>typeof date==='string'&&date.length<=40&&Number.isFinite(Date.parse(date))))throw new NativeTemplateError('unavailable');
 return {...value,content:parseNativeTemplateContent(value.content)} as NativeEmailTemplate;
}
export function renderNativeTemplate(contentRaw:NativeTemplateContent,values:Readonly<Record<string,string>>):NativeTemplateText&{unresolved_placeholders:string[]}{
 const content=parseNativeTemplateContent(contentRaw);
 if(Object.keys(values).length>64||Object.entries(values).some(([key,value])=>!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)||typeof value!=='string'||value.length>8192||value.includes('{{')||value.includes('}}')))throw new NativeTemplateError('invalid');
 const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 const substitute=(text:string,html=false)=>text.replace(marker,(match,name:string)=>Object.hasOwn(values,name)?html?escape(values[name]!):values[name]!:match);
 const body_html=content.body_html?content.body_html.split(/(<[^>]*>)/gu).map(part=>{if(part.startsWith('<')){if(marker.test(part)){marker.lastIndex=0;throw new NativeTemplateError('invalid');}marker.lastIndex=0;return part;}return substitute(part,true);}).join(''):'';
 const body=body_html?parseSafeComposeHtml(body_html).plainText:substitute(content.body);
 const rendered=parseNativeTemplateContent({...content,subject:substitute(content.subject),body,body_html});
 return {subject:rendered.subject,body:rendered.body,body_html:rendered.body_html,unresolved_placeholders:nativeTemplatePlaceholders(rendered)};
}
/** Only message scalars change. Current identity, recipients, files and reply context remain owned by the draft. */
export function insertNativeTemplate(current:NativeDraftContent,text:NativeTemplateText,mode:'append'|'replace'):NativeDraftContent{
 const rendered=parseNativeTemplateContent({title:'Template',subject:text.subject,body:text.body,body_html:text.body_html});let subject=rendered.subject,body=rendered.body,body_html=rendered.body_html;
 if(mode==='append'){
  subject=current.subject||subject;
  if(current.body&&body){
   body=current.body+'\n\n'+body;
   if(current.body_html||body_html){try{
    if(current.body_html&&parseSafeComposeHtml(current.body_html,{inlineAttachments:current.attachments}).plainText!==current.body)throw Error();
    body_html=(current.body_html||plainTextToNativeComposeHtml(current.body))+'<p></p>'+(body_html||plainTextToNativeComposeHtml(rendered.body));
    if(parseSafeComposeHtml(body_html,{inlineAttachments:current.attachments}).plainText!==body)throw Error();
   }catch{throw new NativeTemplateError('invalid','The combined formatting exceeds its limit. Keep your existing message or review replacing its text.');}}
  }else if(current.body){body=current.body;body_html=current.body_html;}
 }
 return parseNativeDraftContent({...detachNativeSignatureRegion(current),subject,body,body_html});
}
export function createNativeTemplateApi(ports:{fetch:(path:string,init:RequestInit)=>Promise<Response>;current:()=>boolean}){
 const controller=new AbortController();let active=true;const current=()=>active&&!controller.signal.aborted&&ports.current();
 const base=(account:string)=>{if(!account||account.length>256||account.trim()!==account||/[\u0000-\u001f\u007f-\u009f]/u.test(account))throw new NativeTemplateError('invalid');return '/api/email/accounts/'+encodeURIComponent(account)+'/templates';};
 const path=(account:string,id:string)=>{if(!uuid(id))throw new NativeTemplateError('invalid');return base(account)+'/'+id;};
 const request=async(url:string,method='GET',input?:unknown,max=512*1024)=>{
  if(!current())throw new NativeTemplateError('denied');const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(45000)]);let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{const response=await ports.fetch(url,{method,cache:'no-store',signal,headers:{'Content-Type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});if(!current()){await response.body?.cancel().catch(()=>{});throw new NativeTemplateError('denied');}
   if(!response.body)throw Error();reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let count=0,text='';
   const abort=()=>{void reader?.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
   try{for(;;){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;count+=next.value.byteLength;if(count>max)throw Error();text+=decoder.decode(next.value,{stream:true});}text+=decoder.decode();}finally{signal.removeEventListener('abort',abort);}
   if(!current())throw new NativeTemplateError('denied');const value:unknown=JSON.parse(text);
   if(!response.ok)throw new NativeTemplateError([401,403].includes(response.status)?'denied':response.status===409?'conflict':response.status===404?'missing':[400,413,422].includes(response.status)?'invalid':'unavailable');return value;
  }catch(error){if(error instanceof NativeTemplateError)throw error;throw new NativeTemplateError('unavailable');}finally{await reader?.cancel().catch(()=>{});reader?.releaseLock();}
 };
 const read=async(account:string,id:string)=>{const row=parseNativeEmailTemplate(await request(path(account,id)),account);if(row.template_id!==id||row.status!=='active')throw new NativeTemplateError('unavailable');return row;};
 return {read,
  async list(account:string,cursor:string|null=null){if(cursor!==null&&(!cursor||cursor.length>8192))throw new NativeTemplateError('invalid');const value=await request(base(account)+'?limit=10'+(cursor?'&cursor='+encodeURIComponent(cursor):''),'GET',undefined,5*1024*1024);
   if(!closed(value,['items','next_cursor','has_more'])||!Array.isArray(value.items)||value.items.length>10||typeof value.has_more!=='boolean'||value.next_cursor!==null&&(typeof value.next_cursor!=='string'||!value.next_cursor||value.next_cursor.length>8192)||value.has_more!==(value.next_cursor!==null))throw new NativeTemplateError('unavailable');
   const items=value.items.map(item=>parseNativeEmailTemplate(item,account));if(items.some(item=>item.status!=='active')||new Set(items.map(item=>item.template_id)).size!==items.length)throw new NativeTemplateError('unavailable');return {items,next_cursor:value.next_cursor as string|null,has_more:value.has_more};},
  async save(account:string,id:string,revision:number|null,raw:NativeTemplateContent){const content=parseNativeTemplateContent(raw);if(!uuid(id)||revision!==null&&(!positive(revision)||revision>=2147483647))throw new NativeTemplateError('invalid');
   const row=parseNativeEmailTemplate(await request(revision===null?base(account):path(account,id),revision===null?'POST':'PUT',revision===null?{template_id:id,content}:{expected_revision:revision,content}),account);
   if(row.template_id!==id||row.status!=='active'||row.revision!==(revision===null?1:revision+1)||JSON.stringify(row.content)!==JSON.stringify(content))throw new NativeTemplateError('unavailable');return row;},
  async archive(row:NativeEmailTemplate){const next=parseNativeEmailTemplate(await request(path(row.account_id,row.template_id)+'/archive','POST',{expected_revision:row.revision}),row.account_id);if(next.template_id!==row.template_id||next.revision!==row.revision+1||next.status!=='archived'||JSON.stringify(next.content)!==JSON.stringify(row.content))throw new NativeTemplateError('unavailable');return next;},
  dispose(){active=false;controller.abort();}
 };
}
