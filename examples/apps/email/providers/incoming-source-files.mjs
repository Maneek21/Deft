import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {simpleParser} from 'mailparser';
import {emailMediaAllowed} from '../email-attachments.mjs';
import {validMessageImage} from './remote-image-proxy.mjs';
import {parsedMailboxes,parsedNativeMailboxes} from './resource-reader.mjs';
import {calendarPartsFromParsed} from './calendar-source-parts.mjs';
import {NATIVE_INCOMING_LIMITS} from './contract.mjs';
const require=createRequire(import.meta.url),mimeRequire=createRequire(require.resolve('mailparser'));
const {parseDocument}=mimeRequire('htmlparser2'),{getOuterHTML}=mimeRequire('domutils');
const MAX_SOURCE=8388608,MAX_HTML=262144,MAX_FILES=32;
const PLAIN_TEXT_BLOCKS=new Set(['p','div','tr','li','h1','h2','h3','h4','h5','h6','blockquote','section','article','header','footer','main','aside','nav','address','pre','figure','figcaption','ul','ol','dl','dt','dd']);
const plainText=node=>{
 const stack=[{node,close:false}],chunks=[];let visited=0,truncated=false,last='';
 const append=text=>{chunks.push(text);if(text.length)last=text[text.length-1];};
 while(stack.length){const entry=stack.pop(),current=entry.node;if(entry.close){append(entry.separator??'\n');continue;}
  if(++visited>32768){truncated=true;break;}
  if(['script','style','noscript','template'].includes(current.name))continue;
  if(current.type==='text'){append(current.data);continue;}
  if(['td','th'].includes(current.name))stack.push({node:current,close:true,separator:'\t'});
  else if(PLAIN_TEXT_BLOCKS.has(current.name)){if(last&&last!=='\n')append('\n');stack.push({node:current,close:true});}
  else if(current.name==='br')stack.push({node:current,close:true});
  const children=current.children??[];for(let i=children.length-1;i>=0;i--)stack.push({node:children[i],close:false});
 }
 return {text:chunks.join(''),truncated};
};
const fail=()=>{throw Error('EMAIL_SOURCE_FILES_UNAVAILABLE');};
const digest=value=>createHash('sha256').update(value).digest('hex');
const bounded=value=>Buffer.from(value.slice(0,MAX_HTML),'utf8').subarray(0,MAX_HTML).toString('utf8').replace(/\ufffd$/u,'');
const safeName=(value,index)=>String(value??`Attachment ${index+1}`).normalize('NFC').replace(/[\u0000-\u001f\u007f/\\]/gu,'_').slice(0,200)||`Attachment ${index+1}`;
const cid=value=>String(value??'').replace(/^<|>$/gu,'').trim().slice(0,256);
function preview(bytes,type){
 if(bytes.length>2097152||!emailMediaAllowed(bytes,type))return 'unsupported';
 if(type==='application/pdf')return 'pdf';
 if(['text/plain','text/csv','application/json'].includes(type))return 'text';
 if(validMessageImage(bytes,type))return 'image';
 return 'unsupported';
}

/** Exact already-reviewed EML only. References select a part within this source;
 * they confer no authority and never contain a provider locator or remote URL. */
export async function inspectEmailSourceFiles(bytes,{file_ref,presentation=false,calendar_parts=false,image_ref,fetchRemote,check=async()=>{},max_bytes,account,conversation_id,profile='legacy'}={}){
 if(!['legacy','native'].includes(profile))fail();
 const sourceLimit=profile==='native'?NATIVE_INCOMING_LIMITS.source_bytes:MAX_SOURCE;
 max_bytes??=sourceLimit;if(!Number.isSafeInteger(max_bytes)||max_bytes<1)fail();
 const inventoryLimit=Math.min(sourceLimit,max_bytes),fileLimit=profile==='native'?NATIVE_INCOMING_LIMITS.file_bytes:inventoryLimit;
 if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>inventoryLimit||file_ref!==undefined&&!/^[a-f0-9]{64}$/u.test(file_ref)||image_ref!==undefined&&!/^[a-f0-9]{64}$/u.test(image_ref))fail();
 await check();
 // Bound MIME expansion before the parser allocates decoded parts. This counts
 // all multipart delimiters, including nested messages, not just file names.
 const raw=Buffer.from(bytes);let parsed;
 try{
 const framing=raw.toString('latin1');if((framing.match(/^--[^\r\n]{1,200}\r?$/gmu)??[]).length>256||(framing.match(/^Content-Type:\s*(?:multipart\/|message\/rfc822)/gmi)??[]).length>64)fail();
 const sourceDigest=digest(raw);parsed=await simpleParser(raw,{skipHtmlToText:true,skipTextToHtml:true,keepCidLinks:true});
 await check();
 if(calendar_parts){const result=calendarPartsFromParsed(parsed,sourceDigest);await check();return {calendar_parts:result};}
 let total=0,nominated=0;const parts=parsed.attachments.flatMap((part,index)=>{
  if(nominated>=MAX_FILES||part.content.length>inventoryLimit||total+part.content.length>inventoryLimit)return [];
  total+=part.content.length;nominated++;
  const type=/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(part.contentType)?part.contentType:'application/octet-stream';
  return [{part,metadata:{file_ref:digest(`${sourceDigest}:file:${index}`),filename:safeName(part.filename,index),media_type:type,size_bytes:part.content.length,disposition:part.contentDisposition==='inline'?'inline':'attachment',preview:preview(part.content,type),...(cid(part.contentId)?{content_id:cid(part.contentId)}:{})}}];
 });
  const files=parts.map(row=>row.metadata),omitted=parsed.attachments.length-parts.length;
  const inventory={files,...(omitted?{omitted_file_count:omitted}:{})};
  if(file_ref){const found=parts.find(row=>row.metadata.file_ref===file_ref);if(!found||found.part.content.length>fileLimit)fail();await check();return {...inventory,file_ref,bytes:new Uint8Array(found.part.content)};}
  if(!presentation&&!image_ref){await check();return inventory;}
  const html=typeof parsed.html==='string'?parsed.html:null,content=html??(parsed.text??'');
  const limited=bounded(content),tree=parseDocument(limited,{decodeEntities:true}),images=[],nominations=new Map();let nodes=0,complex=false;
  const walk=(node,depth=0)=>{if(complex)return;if(++nodes>8192||depth>64){complex=true;return;}if(node.type==='tag'&&node.name==='img'){
   const index=images.length,src=node.attribs?.src??'';let nomination=null;
   if(index<32&&/^cid:/iu.test(src)){let name;try{name=cid(decodeURIComponent(src.slice(4)));}catch{name='';}const matches=parts.filter(row=>row.metadata.content_id===name&&row.metadata.preview==='image');if(name&&matches.length===1&&parsed.attachments.filter(part=>cid(part.contentId)===name).length===1)nomination={kind:'cid',part:matches[0]};}
   else if(index<32){try{const url=new URL(src);if(url.protocol==='https:'&&!url.username&&!url.password&&url.href.length<=4096)nomination={kind:'remote',url:url.href};}catch{}}
   const untrusted=node.attribs;node.attribs={alt:String(untrusted?.alt??'').slice(0,200)};for(const name of ['width','height','style'])if(typeof untrusted?.[name]==='string')node.attribs[name]=untrusted[name].slice(0,name==='style'?2048:20);
   if(nomination){const ref=digest(`${sourceDigest}:image:${index}:${src}`);images.push({image_ref:ref,kind:nomination.kind,index,alt:node.attribs.alt});nominations.set(ref,nomination);node.attribs.src=`deft-image:${ref}`;}
  }for(const child of node.children??[])walk(child,depth+1);};
  if(html)walk(tree);
  if(complex){images.length=0;nominations.clear();}
  if(image_ref){const selected=nominations.get(image_ref);if(!selected)fail();let result;if(selected.kind==='cid')result={bytes:new Uint8Array(selected.part.part.content),media_type:selected.part.metadata.media_type};else{if(typeof fetchRemote!=='function')fail();result=await fetchRemote({url:selected.url});}try{await check();return {...result,image_ref,...inventory};}catch(error){result.bytes?.fill(0);throw error;}}
  let metadata,headers=[],replySeedUnavailable=[];
  if(account){
   const seedFields={from:'reply_from','reply-to':'reply_to',to:'reply_to_list',cc:'reply_cc'};
   const h=key=>{const rows=parsed.headerLines.filter(row=>row.key===key);if(rows.length>1){if(profile==='native'&&seedFields[key])replySeedUnavailable.push(seedFields[key]);else fail();}const value=parsed.headers.get(key);return typeof value==='string'?value:Array.isArray(value)?value.map(row=>typeof row==='string'?row:row?.text??'').join(' '):value?.text??'';};
   metadata={account_id:account.account_id,primary_address:account.primary_address,verified_sender_identities:JSON.stringify(account.verified_sender_identities),reply_from:h('from'),reply_to:h('reply-to'),reply_to_list:h('to'),reply_cc:h('cc'),subject:parsed.subject??'',message_id:h('message-id'),references:h('references'),conversation_id,conversation_coverage_state:'unknown',conversation_indexed_count:'0',conversation_exact_count:'',conversation_observed_at:'',conversation_drained:'false',mailbox_reset_required:'false'};
   const display={...metadata};
   for(const key of ['reply_from','reply_to','reply_to_list','reply_cc']){
    if(profile==='legacy')parsedMailboxes(metadata[key]);
    else{try{parsedNativeMailboxes(metadata[key]);}catch{replySeedUnavailable.push(key);}if(replySeedUnavailable.includes(key))metadata[key]='';}
   }
   replySeedUnavailable=[...new Set(replySeedUnavailable)];
   if(!/^<[^<>\s@]+@[^<>\s@]+>$/u.test(metadata.message_id)||metadata.references.split(/\s+/u).filter(Boolean).some(value=>!/^<[^<>\s@]+@[^<>\s@]+>$/u.test(value)))metadata.message_id='';
   headers=[['From',display.reply_from],['To',display.reply_to_list],['Cc',display.reply_cc],['Reply-To',display.reply_to],['Date',parsed.date instanceof Date&&!Number.isNaN(parsed.date.getTime())?parsed.date.toISOString():''],['Subject',metadata.subject]].filter(([,value])=>value).map(([label,value])=>({label,value:(profile==='native'?String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu,' '):String(value)).slice(0,2048)}));
  }
  const extracted=html?plainText(tree):{text:content,truncated:false};
  const useExtracted=html!==null&&(typeof parsed.text!=='string'||!parsed.text.trim());
  const plain=useExtracted?extracted.text:(parsed.text??extracted.text);
  const rendered=complex?plain:html?getOuterHTML(tree):limited;
  await check();return {...inventory,...(replySeedUnavailable.length?{reply_seed_unavailable:replySeedUnavailable}:{}),presentation:{format:html&&!complex?'html':'plain',content:bounded(rendered),plain_text:bounded(plain),
   truncated:Buffer.byteLength(content,'utf8')>MAX_HTML||Buffer.byteLength(rendered,'utf8')>MAX_HTML||Buffer.byteLength(plain,'utf8')>MAX_HTML||(useExtracted||typeof parsed.text!=='string')&&extracted.truncated,
   ...(complex?{rendering_fallback:'plain_text'}:{}),images,headers,...(metadata?{metadata}:{})}};
 }finally{raw.fill(0);for(const part of parsed?.attachments??[])part.content?.fill(0);}
}
