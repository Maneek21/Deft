/** Closed compose grammar shared by the host editor and payload capture.
 * It never repairs HTML or loads external content: noncanonical input is invalid. */
import {parseMailboxList} from './mailbox-list.js';
export type SafeComposeDocument = Readonly<{ html: string; plainText: string }>;
/** Native body budgets mirror existing saved fields. The complete draft still
 * has an independent 480 KiB JSON gate; signatures may select lower bounds. */
export const NATIVE_COMPOSE_BODY_LIMITS=Object.freeze({maxCharacters:256*1024,maxBytes:480*1024,maxPlainCharacters:256*1024,maxNodes:16_384,maxDepth:16});
export type NativeComposeInlineAttachment=Readonly<{file_id:string;filename:string;media_type:string;size_bytes:number;sha256:string}>;
export type NativeComposeOptions={maxCharacters?:number;maxBytes?:number;inlineAttachments?:readonly NativeComposeInlineAttachment[]};
type Tag = 'p' | 'strong' | 'em' | 'br' | 'ul' | 'ol' | 'li' | 'a' | 'img';
type Node = string | { tag: Tag; children: Node[]; href?:string;fileId?:string;alt?:string };
const tags = new Set(['p', 'strong', 'em', 'br', 'ul', 'ol', 'li']);
const invalid = () => { throw new Error('SAFE_COMPOSE_HTML_INVALID'); };
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeAttribute=(text:string)=>escape(text).replaceAll('"','&quot;');
const validText = (text: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]/u.test(text);
const imageId=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const rasterTypes=new Set(['image/png','image/jpeg','image/gif','image/webp']);
export function nativeComposeImageCid(fileId:string):string{if(typeof fileId!=='string'||!imageId.test(fileId))invalid();return `deft-${fileId}@deft.invalid`;}
function inlineFiles(options:NativeComposeOptions):Map<string,NativeComposeInlineAttachment>{
 const files=new Map<string,NativeComposeInlineAttachment>();
 if(options.inlineAttachments===undefined)return files;
 if(!Array.isArray(options.inlineAttachments)||options.inlineAttachments.length>32)invalid();
 let total=0;
 for(const file of options.inlineAttachments){
  if(!file||typeof file!=='object'||Object.keys(file).sort().join(',')!=='file_id,filename,media_type,sha256,size_bytes'
   ||typeof file.file_id!=='string'||!file.file_id||file.file_id.length>256||file.file_id.trim()!==file.file_id||/[\u0000-\u001f\u007f-\u009f]/u.test(file.file_id)||files.has(file.file_id)
   ||typeof file.filename!=='string'||file.filename.length<1||file.filename.length>255||/[\/\\\u0000-\u001f\u007f-\u009f]/u.test(file.filename)||!validText(file.filename)
   ||typeof file.media_type!=='string'||!/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/u.test(file.media_type)
   ||!Number.isSafeInteger(file.size_bytes)||file.size_bytes<0||file.size_bytes>25*1024*1024
   ||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(file.sha256)||(total+=file.size_bytes)>25*1024*1024)invalid();
  files.set(file.file_id,file);
 }
 return files;
}
function imageAlt(alt:unknown):string{if(typeof alt!=='string'||!alt.trim()||alt.length>255||!validText(alt)||/[\u0000-\u001f\u007f-\u009f]/u.test(alt))invalid();return alt as string;}
const imagePlain=(alt:string)=>`[Image: ${alt}]`;
const serialize = (node: Node): string => typeof node === 'string' ? escape(node)
  : node.tag === 'br' ? '<br>' : node.tag==='img'?`<img src="cid:${nativeComposeImageCid(node.fileId!)}" alt="${escapeAttribute(node.alt!)}">` : `<${node.tag}${node.tag==='a'?` href="${escapeAttribute(node.href!)}"`:''}>${node.children.map(serialize).join('')}</${node.tag}>`;
function plain(node: Node, depth = 0): string {
  if (typeof node === 'string') return node;
  if (node.tag === 'br') return '\n';
  if(node.tag==='img')return imagePlain(node.alt!);
  if(node.tag==='a'){const label=node.children.map(child=>plain(child,depth)).join('');return label===node.href?label:`${label} (${node.href})`;}
  if (node.tag === 'ul' || node.tag === 'ol') return node.children.map((child, index) => {
    const value = plain(child, depth + 1), prefix = node.tag === 'ul' ? '- ' : `${index + 1}. `;
    return prefix + value.replaceAll('\n', '\n  ');
  }).join('\n');
  if (node.tag === 'li') return node.children.map(child => plain(child, depth)).join('\n');
  return node.children.map(child => plain(child, depth)).join('');
}
function accepts(parent: Tag | 'root', child: Tag | 'text',native=false): boolean {
  if (parent === 'root' || parent === 'li') return ['p', 'ul', 'ol'].includes(child);
  if (parent === 'ul' || parent === 'ol') return child === 'li';
  return ['p', 'strong', 'em',...(native?['a']:[])].includes(parent) && ['text', 'strong', 'em', 'br',...(native?['a','img']:[])].includes(child);
}
export function parseSafeComposeHtml(html: string, { maxCharacters = 16_384, maxBytes = 65_536 } = {}): SafeComposeDocument {
  return parseComposeHtml(html,maxCharacters,maxBytes,false);
}
/** Explicit native profile. Canonical anchors are inert data; no URL is fetched. */
export function parseNativeSafeComposeHtml(html:string,options:NativeComposeOptions={}):SafeComposeDocument{
 return parseComposeHtml(html,options.maxCharacters??NATIVE_COMPOSE_BODY_LIMITS.maxCharacters,options.maxBytes??NATIVE_COMPOSE_BODY_LIMITS.maxBytes,true,false,options);
}
function parseComposeHtml(html:string,maxCharacters:number,maxBytes:number,native:boolean,preserveDraft=false,options:NativeComposeOptions={}):SafeComposeDocument{
  const files=native?inlineFiles(options):new Map<string,NativeComposeInlineAttachment>();
  const characterCap=(native||preserveDraft)?NATIVE_COMPOSE_BODY_LIMITS.maxCharacters:16_384,byteCap=(native||preserveDraft)?NATIVE_COMPOSE_BODY_LIMITS.maxBytes:65_536;
  if (typeof html !== 'string' || !Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > characterCap
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > byteCap || html.length > maxCharacters
    || new TextEncoder().encode(html).byteLength > maxBytes || !validText(html)) invalid();
  const root: { tag: 'root'; children: Node[]; href?:string } = { tag: 'root', children: [] };
  const stack: Array<{ tag: Tag | 'root'; children: Node[]; href?:string }> = [root];
  let offset = 0, nodes = 0;
  while (offset < html.length) {
    if (++nodes > (native?NATIVE_COMPOSE_BODY_LIMITS.maxNodes:2048) || stack.length > (native?NATIVE_COMPOSE_BODY_LIMITS.maxDepth:16)) invalid();
    const parent = stack[stack.length - 1]!;
    if (html[offset] === '<') {
      if(native&&html.startsWith('<img ',offset)){
       const token=/^<img src="cid:deft-([a-f0-9-]{36})@deft\.invalid" alt="([^"]*)">/u.exec(html.slice(offset));
       if(!token||!accepts(parent.tag,'img',true)||stack.some(node=>node.tag==='a')||!imageId.test(token[1]!))invalid();
       const file=files.get(token![1]!);if(!file||!rasterTypes.has(file.media_type))invalid();
       const raw=token![2]!;if(/&(?!amp;|quot;|lt;|gt;)/u.test(raw))invalid();
       const alt=imageAlt(raw.replace(/&(amp|quot|lt|gt);/gu,(_,entity:string)=>({amp:'&',quot:'"',lt:'<',gt:'>'})[entity]!));
       parent.children.push({tag:'img',children:[],fileId:token![1]!,alt});offset+=token![0].length;continue;
      }
      const token = (native?/^<(\/)?([a-z]+)(?: href="([^"]*)")?>/u:/^<(\/)?([a-z]+)>/u).exec(html.slice(offset));
      if (!token || !(tags.has(token[2]!)||native&&token[2]==='a') || token[3]!==undefined&&(token[1]||token[2]!=='a')) invalid();
      const tag = token![2] as Tag; offset += token![0].length;
      if (token![1]) { if (parent.tag !== tag || tag === 'br') invalid(); stack.pop(); }
      else {
        if (!accepts(parent.tag, tag,native)) invalid();
        let href:string|undefined;
        if(tag==='a'){
         if(token![3]===undefined||stack.some(node=>node.tag==='a'))invalid();
         const raw=token![3]!;if(/&(?!amp;|quot;|lt;|gt;)/u.test(raw))invalid();
         href=raw.replace(/&(amp|quot|lt|gt);/gu,(_,entity:string)=>({amp:'&',quot:'"',lt:'<',gt:'>'})[entity]!);
         if(canonicalNativeComposeLink(href)!==href)invalid();
        }
        const node = { tag, children: [] as Node[],...(href===undefined?{}:{href}) }; parent.children.push(node);
        if (tag !== 'br') stack.push(node);
      }
    } else {
      const end = html.indexOf('<', offset), raw = html.slice(offset, end < 0 ? html.length : end);
      if (!accepts(parent.tag, 'text',native) || /[>]/u.test(raw) || /&(?!amp;|lt;|gt;)/u.test(raw)) invalid();
      const text = raw.replace(/&(amp|lt|gt);/gu, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>' })[entity]!);
      parent.children.push(text); offset += raw.length;
    }
  }
  if (stack.length !== 1 || root.children.map(serialize).join('') !== html) invalid();
  // Lists must contain real items; an item must start with a paragraph. This is
  // the same restricted document tree emitted by the host editor.
  const check = (node: Node): void => {
    if (typeof node === 'string') return;
    if ((node.tag === 'ul' || node.tag === 'ol') && node.children.length === 0) invalid();
    if (node.tag === 'li' && (typeof node.children[0] === 'string' || node.children[0]?.tag !== 'p')) invalid();
    if(node.tag==='a'&&!node.children.map(child=>plain(child)).join('').trim())invalid();
    node.children.forEach(check);
  };
  root.children.forEach(check);
  const plainText=root.children.map(node => plain(node)).join('\n');
  if(native&&plainText.length>NATIVE_COMPOSE_BODY_LIMITS.maxPlainCharacters)invalid();
  return Object.freeze({ html, plainText });
}
/** Only explicit link submission canonicalizes. Parsers require this exact value. */
export function canonicalNativeComposeLink(raw:string):string{
 if(typeof raw!=='string'||!raw||!validText(raw)||/[\s\\\u202a-\u202e\u2066-\u2069]/u.test(raw)||/%(?![a-f0-9]{2})/iu.test(raw)||new TextEncoder().encode(raw).byteLength>4096)invalid();
 let decoded:string;try{decoded=decodeURIComponent(raw);}catch{invalid();}
 if(!validText(decoded!)||/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(decoded!))invalid();
 let canonical:string;
 if(/^mailto:/iu.test(raw)){
  if(/[?#]/u.test(raw.slice(7)))invalid();
  const address=decoded!.slice(7);let rows:ReturnType<typeof parseMailboxList>;
  try{rows=parseMailboxList(address,{maxItems:1});}catch{invalid();}
  if(rows![0]!.displayName||rows![0]!.address.toLowerCase()!==address.toLowerCase())invalid();
  canonical='mailto:'+encodeURIComponent(rows![0]!.address).replaceAll('%40','@');
 }else{
  let url:URL;try{url=new URL(raw);}catch{invalid();}
  if(!['http:','https:'].includes(url!.protocol)||!url!.hostname||url!.username||url!.password||/^https?:\/\/[^/?#]*@/iu.test(raw))invalid();
  canonical=url!.href;
 }
 if(new TextEncoder().encode(canonical!).byteLength>4096)invalid();return canonical!;
}
export function plainTextToSafeComposeHtml(text: string): string {
  if (typeof text !== 'string' || text.length > 16_384 || !validText(text)) invalid();
  const html = text === '' ? '' : text.split('\n').map(line => `<p>${escape(line)}</p>`).join('');
  parseSafeComposeHtml(html); return html;
}
/** Native-only explicit conversion; legacy plain conversion remains unchanged. */
export function plainTextToNativeComposeHtml(text:string,options:NativeComposeOptions={}):string{
 if(typeof text!=='string'||text.length>NATIVE_COMPOSE_BODY_LIMITS.maxPlainCharacters||!validText(text))invalid();
 const html=text===''?'':text.split('\n').map(line=>`<p>${escape(line)}</p>`).join('');
 parseNativeSafeComposeHtml(html,options);return html;
}
/** Converts only the host editor's closed document tree, never author HTML. */
export function safeComposeHtmlFromEditorDocument(value: unknown): SafeComposeDocument {
 return composeHtmlFromEditorDocument(value,false,false);
}
export function nativeSafeComposeHtmlFromEditorDocument(value:unknown,options:NativeComposeOptions={}):SafeComposeDocument{
 return composeHtmlFromEditorDocument(value,true,false,options);
}
/** Explicit editor publication only: preserves an unsendable native draft when
 * its rich size cap is crossed. Review/serialization still use the strict parser. */
export function nativeComposeDraftFromEditorDocument(value:unknown,options:NativeComposeOptions={}):SafeComposeDocument{
 return composeHtmlFromEditorDocument(value,true,true,options);
}
function composeHtmlFromEditorDocument(value:unknown,native:boolean,preserveDraft:boolean,options:NativeComposeOptions={}):SafeComposeDocument{
  let count = 0, textCharacters = 0;
  const files=native?inlineFiles(options):new Map<string,NativeComposeInlineAttachment>();
  const object = (input: unknown): input is Record<string, unknown> => Boolean(input) && typeof input === 'object' && !Array.isArray(input);
  type Run={html:string;href?:string};
  const bounded=(html:string)=>{if(native&&html.length>NATIVE_COMPOSE_BODY_LIMITS.maxCharacters)invalid();return html;};
  const join=(runs:Iterable<Run>)=>{
   let body='',href:string|undefined,parts='';
   const flush=()=>{if(href!==undefined){body=bounded(body+`<a href="${escapeAttribute(href)}">${parts}</a>`);href=undefined;parts='';}};
   for(const run of runs){if(run.href===undefined){flush();body=bounded(body+run.html);}else{if(href!==run.href){flush();href=run.href;}parts=bounded(parts+run.html);}}
   flush();return body;
  };
  const convert = (input: unknown, depth: number): Run => {
    if (!object(input) || ++count > (native?NATIVE_COMPOSE_BODY_LIMITS.maxNodes:2048) || depth > (native?NATIVE_COMPOSE_BODY_LIMITS.maxDepth:16) || typeof input.type !== 'string'
      || Object.keys(input).some(key => !['type', 'content', 'text', 'marks', 'attrs'].includes(key))) invalid();
    const node = input as Record<string, unknown>;
    if(native&&node.type==='nativeInlineImage'){
     const attrs=node.attrs;if(!object(attrs))return invalid();
     if(Object.keys(attrs).sort().join(',')!=='alt,fileId'||node.content!==undefined||node.text!==undefined||node.marks!==undefined)invalid();
     const fileId=attrs.fileId;if(typeof fileId!=='string')invalid();const file=files.get(fileId as string);
     if(!file||!rasterTypes.has(file.media_type))invalid();const alt=imageAlt(attrs.alt);
     return {html:`<img src="cid:${nativeComposeImageCid(fileId as string)}" alt="${escapeAttribute(alt)}">`};
    }
    if (node.type === 'text'||native&&node.type==='hardBreak') {
      const hardBreak=node.type==='hardBreak';
      if(native&&!hardBreak){if(typeof node.text!=='string'||(textCharacters+=node.text.length)>NATIVE_COMPOSE_BODY_LIMITS.maxPlainCharacters)invalid();}
      if ((!hardBreak&&(typeof node.text !== 'string'||!validText(node.text)))||(hardBreak&&node.text!==undefined)||node.content !== undefined || node.attrs !== undefined) invalid();
      let text = hardBreak?'<br>':escape(node.text as string),href:string|undefined;
      if (node.marks !== undefined) {
        if (!Array.isArray(node.marks) || node.marks.length > (native?3:2)) invalid();
        const marks = (node.marks as unknown[]).map(mark => {
          if(native&&object(mark)&&mark.type==='link'){
           const attrs=mark.attrs;if(!object(attrs))return invalid();
           if(Object.keys(mark).some(key=>!['type','attrs'].includes(key))||Object.keys(attrs).some(key=>!['href','target','rel','class','title'].includes(key))
            ||Object.entries(attrs).some(([key,v])=>key!=='href'&&v!==null))invalid();
           const suppliedHref=attrs.href;if(typeof suppliedHref!=='string')return invalid();
           href=canonicalNativeComposeLink(suppliedHref);if(href!==suppliedHref)invalid();return 'link';
          }
          if (!object(mark) || Object.keys(mark).join(',') !== 'type' || !['bold', 'italic'].includes(String(mark.type))) invalid();
          return String((mark as Record<string, unknown>).type);
        });
        if (new Set(marks).size !== marks.length) invalid();
        // A fixed mark order keeps unchanged content byte-for-byte stable.
        if (marks.includes('italic')) text = `<em>${text}</em>`;
        if (marks.includes('bold')) text = `<strong>${text}</strong>`;
      }
      return {html:bounded(text),...(href===undefined?{}:{href})};
    }
    if (node.text !== undefined || node.marks !== undefined) invalid();
    const map: Record<string, string> = { paragraph: 'p', bulletList: 'ul', orderedList: 'ol', listItem: 'li', hardBreak: 'br' };
    if (node.attrs !== undefined && !(node.type === 'orderedList' && object(node.attrs)
      && Object.keys(node.attrs).every(key => key === 'start' || key === 'type') && node.attrs.start === 1
      && (node.attrs.type === undefined || node.attrs.type === null))) invalid();
    if (node.type === 'hardBreak') { if (node.content !== undefined) invalid(); return {html:'<br>'}; }
    const content = node.content === undefined ? [] : node.content;
    if (!Array.isArray(content)) invalid();
    const children=function*(){for(const child of content as unknown[])yield convert(child,depth+1);};
    const body = join(native?children():(content as unknown[]).map(child => convert(child, depth + 1)));
    if (node.type === 'doc') { if (depth !== 0 || node.attrs !== undefined) invalid(); return {html:body}; }
    const tag = map[String(node.type)]; if (!tag) invalid(); return {html:bounded(`<${tag}>${body}</${tag}>`)};
  };
  const html=join([convert(value,0)]);
  const result=parseComposeHtml(html,native?options.maxCharacters??NATIVE_COMPOSE_BODY_LIMITS.maxCharacters:preserveDraft?256*1024:16_384,native?options.maxBytes??NATIVE_COMPOSE_BODY_LIMITS.maxBytes:preserveDraft?480*1024:65_536,native,preserveDraft,options);
  if(preserveDraft&&result.plainText.length>256*1024)invalid();return result;
}
/** References are nominations only. Current bytes and scoped custody are still
 * independently checked by the host before either MIME stage. */
export function nativeComposeInlineFileIds(html:string,options:NativeComposeOptions={}):readonly string[]{
 parseNativeSafeComposeHtml(html,options);const found=new Set<string>();
 for(const token of html.matchAll(/<img src="cid:deft-([a-f0-9-]{36})@deft\.invalid" alt="[^"]*">/gu))found.add(token[1]!);
 return Object.freeze([...found]);
}
/** Explicit text-only copying removes image atoms without transplanting files.
 * All other canonical rich formatting and the central plain projection remain. */
export function removeNativeComposeInlineFiles(html:string,removedFileIds:readonly string[],options:NativeComposeOptions={}):SafeComposeDocument{
 parseNativeSafeComposeHtml(html,options);const files=inlineFiles(options);
 if(!Array.isArray(removedFileIds)||removedFileIds.length>32||new Set(removedFileIds).size!==removedFileIds.length||removedFileIds.some(id=>!files.has(id)))invalid();
 const removed=new Set(removedFileIds),kept=html.replace(/<img src="cid:deft-([a-f0-9-]{36})@deft\.invalid" alt="([^"]*)">/gu,(token,id:string,raw:string)=>{
  if(!removed.has(id))return token;
  return escape(imagePlain(raw.replace(/&(amp|quot|lt|gt);/gu,(_,entity:string)=>({amp:'&',quot:'"',lt:'<',gt:'>'})[entity]!)));
 });
 return parseNativeSafeComposeHtml(kept,{...options,inlineAttachments:[...files.values()].filter(file=>!removed.has(file.file_id))});
}
