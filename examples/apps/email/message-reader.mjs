// Provider content remains untrusted. Only the host document renderer sanitizes it.
export const EMAIL_READER_LIMITS = Object.freeze({body_bytes:16384,parts:200,depth:16,decoded_part_bytes:2097152,header_bytes:1000});
const fail = code => { throw Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\r\n\0]/u.test(value);
const header = value => String(value ?? '').replace(/[\r\n\0]/gu,' ').slice(0,EMAIL_READER_LIMITS.header_bytes);

export function boundedEmailContent(value,maxBytes=EMAIL_READER_LIMITS.body_bytes) {
  if(typeof value !== 'string' || value.includes('\0') || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > EMAIL_READER_LIMITS.body_bytes) fail('EMAIL_READER_CONTENT_INVALID');
  const bytes=Buffer.from(value,'utf8');
  if(bytes.length<=maxBytes)return {content:value,truncated:false};
  let end=maxBytes;while(end>0&&(bytes[end]&0xc0)===0x80)end--;
  return {content:bytes.subarray(0,end).toString('utf8'),truncated:true};
}

function decodePart(part) {
  const data=part.body?.data;
  if(data===undefined)return null; // A provider attachmentId is not an empty body.
  if(typeof data!=='string'||data.length>Math.ceil(EMAIL_READER_LIMITS.decoded_part_bytes*4/3)+4||!/^[A-Za-z0-9_-]*={0,2}$/u.test(data))fail('EMAIL_READER_MIME_INVALID');
  const bytes=Buffer.from(data,'base64url');
  if(bytes.toString('base64url')!==data.replace(/=+$/u,'')||bytes.length>EMAIL_READER_LIMITS.decoded_part_bytes)fail('EMAIL_READER_MIME_INVALID');
  const contentType=(part.headers??[]).find(row=>row.name?.toLowerCase()==='content-type')?.value??'';
  const charset=/charset\s*=\s*(?:"([^";]+)"|([^;\s]+))/iu.exec(contentType);
  try{return new TextDecoder(charset?.[1]??charset?.[2]??'utf-8',{fatal:true}).decode(bytes);}
  catch{fail('EMAIL_READER_ENCODING_UNSUPPORTED');}
}

function gmailBodies(payload) {
  let count=0;
  function visit(part,depth) {
    if(!object(part)||++count>EMAIL_READER_LIMITS.parts||depth>EMAIL_READER_LIMITS.depth||typeof part.mimeType!=='string'||part.mimeType.length>200||!Array.isArray(part.headers??[])||(part.headers??[]).length>200||(part.headers??[]).some(row=>!object(row)||typeof row.name!=='string'||typeof row.value!=='string'||row.name.length>200||row.value.length>16384))fail('EMAIL_READER_MIME_INVALID');
    const disposition=(part.headers??[]).find(row=>row.name?.toLowerCase()==='content-disposition')?.value??'';
    if(part.filename||/^\s*attachment(?:;|\s|$)/iu.test(disposition))return {plain:null,html:null};
    const mimeType=part.mimeType.toLowerCase();
    if(mimeType==='text/plain')return {plain:decodePart(part),html:null};
    if(mimeType==='text/html')return {plain:null,html:decodePart(part)};
    if(!mimeType.startsWith('multipart/'))return {plain:null,html:null};
    if(!Array.isArray(part.parts??[])||(part.parts??[]).length>EMAIL_READER_LIMITS.parts)fail('EMAIL_READER_MIME_INVALID');
    let plain=null,html=null;
    for(const child of part.parts??[]){const body=visit(child,depth+1);plain??=body.plain;html??=body.html;}
    return {plain,html};
  }
  return visit(payload,0);
}

export function normalizeEmailMessageDetail(detail,{account_id,logical_message_id}) {
  if(!identity(account_id)||!identity(logical_message_id)||!object(detail)||!object(detail.message)||detail.message.account_id!==account_id||!object(detail.body)||detail.body.untrusted!==true)fail('EMAIL_READER_IDENTITY_INVALID');
  let plain=null,html=null;
  if(detail.body.format==='gmail_mime')({plain,html}=gmailBodies(detail.body.payload));
  else if(detail.body.format==='text'&&typeof detail.body.content==='string')plain=detail.body.content;
  else if(detail.body.format==='html'&&typeof detail.body.content==='string')html=detail.body.content;
  else if(detail.body.format!=='unavailable')fail('EMAIL_READER_CONTENT_INVALID');
  const format=html!==null?'html':plain!==null?'plain':'unavailable';
  const selected=boundedEmailContent(html??plain??'');
  const fallback=boundedEmailContent(plain??'');
  return Object.freeze({schema_version:'deft.email_message_reader.v1',account_id,logical_message_id,
    message:{...detail.message},body:{format,content:selected.content,plain_text:fallback.content,truncated:selected.truncated,plain_text_truncated:fallback.truncated,untrusted:true,remote_content:'blocked'},
    source_status:'not_requested'});
}

export function createEmailMessageReader({runtime}) {
  if(!runtime||typeof runtime.readMessage!=='function')fail('EMAIL_READER_RUNTIME_REQUIRED');
  return Object.freeze({async read({account_id,logical_message_id}){
    if(!identity(account_id)||!identity(logical_message_id))fail('EMAIL_READER_IDENTITY_INVALID');
    return normalizeEmailMessageDetail(await runtime.readMessage(account_id,logical_message_id),{account_id,logical_message_id});
  }});
}

export function projectParsedEmailReaderFields(parsed) {
  if(!object(parsed))fail('EMAIL_READER_CONTENT_INVALID');
  const plain=boundedEmailContent(typeof parsed.text==='string'?parsed.text:'');
  const html=boundedEmailContent(typeof parsed.html==='string'?parsed.html:'');
  const address=parsedAddress;
  return {body:plain.content,body_html:html.content,body_format:typeof parsed.html==='string'?'html':typeof parsed.text==='string'?'plain':'unavailable',body_truncated:plain.truncated||html.truncated,
    reply_to:address(parsed.replyTo),cc:address(parsed.cc),bcc:address(parsed.bcc),sender:address(parsed.from),recipients:address(parsed.to),
    subject:header(parsed.subject),message_id:header(parsed.messageId),in_reply_to:header(parsed.inReplyTo),references:header(Array.isArray(parsed.references)?parsed.references.join(' '):parsed.references),
    date:parsed.date instanceof Date&&!Number.isNaN(parsed.date.getTime())?parsed.date.toISOString():''};
}

export function normalizeParsedEmailReaderBody(parsed) {
  if(!object(parsed))fail('EMAIL_READER_CONTENT_INVALID');
  const plain=typeof parsed.text==='string'?boundedEmailContent(parsed.text):null;
  const html=typeof parsed.html==='string'?boundedEmailContent(parsed.html):null;
  const selected=html??plain;
  return {format:html!==null?'html':plain!==null?'plain':'unavailable',content:selected?.content??'',
    plain_text:plain?.content??'',truncated:selected?.truncated??false,plain_text_truncated:plain?.truncated??false,
    untrusted:true,remote_content:'blocked'};
}

function parsedAddress(value) {
  if(value===undefined||value===null)return '';
  if(!object(value))fail('EMAIL_READER_HEADERS_INVALID');
  if(typeof value.text==='string')return header(value.text);
  if(!Array.isArray(value.value)||value.value.length>500||value.value.some(row=>!object(row)||typeof row.address!=='string'||(row.name!==undefined&&typeof row.name!=='string')))fail('EMAIL_READER_HEADERS_INVALID');
  return header(value.value.map(row=>row.name?`${row.name} <${row.address}>`:row.address).join(', '));
}

// Exactly the five optional fields in the reviewed legacy scalar resource.
// Original EML is a separate provider read; these display headers never claim it.
export function projectLegacyEmailReaderFields(parsed) {
  if(!object(parsed))fail('EMAIL_READER_CONTENT_INVALID');
  const html=boundedEmailContent(typeof parsed.html==='string'?parsed.html:'',4096);
  const lines=parsed.headerLines??[];
  if(!Array.isArray(lines))fail('EMAIL_READER_HEADERS_INVALID');
  let headers='',headersTruncated=lines.length>200;
  for(const row of lines.slice(0,200)){
    if(!object(row)||typeof row.key!=='string'||typeof row.line!=='string'||row.line.includes('\0'))fail('EMAIL_READER_HEADERS_INVALID');
    if(row.key.toLowerCase()==='bcc')continue;
    const appended=boundedEmailContent(headers+(headers?'\r\n':'')+row.line.slice(0,4097),4096);
    headers=appended.content;
    if(appended.truncated||row.line.length>4097){headersTruncated=true;break;}
  }
  const marker='\r\n[Headers truncated]';
  const bounded=boundedEmailContent(headers,4096);
  const source_headers=headersTruncated||bounded.truncated?boundedEmailContent(headers,4096-Buffer.byteLength(marker)).content+marker:bounded.content;
  return {body_html:html.content,body_html_truncated:html.truncated,reply_to:parsedAddress(parsed.replyTo),cc:parsedAddress(parsed.cc),source_headers};
}
