import {readFileSync} from 'node:fs';
import {simpleParser} from 'mailparser';
import {LogicalMailIndex} from './logical-mail-index.mjs';
import {validateEmailScope} from './account-registry.mjs';
import {projectEmailMetadata} from './metadata-resource.mjs';

// Deterministic, offline Stage 0 input mapping. Parsing fixture MIME here does
// not represent a production metadata-only network read or live certification.
const root=new URL('./fixtures/launch-stage0/',import.meta.url);
const fixtures=JSON.parse(readFileSync(new URL('fixtures.json',root),'utf8'));
const bounded=value=>String(value??'').replace(/[\r\n\0]/g,' ').slice(0,1000);
export async function loadEmailMetadataFixtureSummaries(account_id){
 const account=fixtures.accounts.find(row=>row.id===account_id);if(!account)throw Error('EMAIL_METADATA_FIXTURE_ACCOUNT_INVALID');
 const messages=[];
 for(const row of fixtures.messages.filter(row=>row.account_id===account_id)){
  if(!/^[a-z0-9-]+\.eml$/.test(row.source))throw Error('EMAIL_METADATA_FIXTURE_SOURCE_INVALID');
  const source=readFileSync(new URL(row.source,root));if(source.length>65536)throw Error('EMAIL_METADATA_FIXTURE_LIMIT');
  const parsed=await simpleParser(source,{skipHtmlToText:true,skipTextToHtml:true}),provider=account.provider_hint==='imap'?'imap_smtp':account.provider_hint;
  let locator;
  if(provider==='gmail')locator={kind:provider,...row.locator};else if(provider==='microsoft')locator={kind:provider,...row.locator,id_type:'immutable'};else{const [,uidvalidity,uid]=row.locator.resource_id.split(':');locator={kind:provider,mailbox:row.locator.mailbox,uidvalidity,uid:Number(uid)};}
  messages.push({account_id,provider,locator,subject:bounded(parsed.subject),sender:bounded(parsed.from?.text),recipients:bounded(parsed.to?.text),cc:bounded(parsed.cc?.text),date:parsed.date?.toISOString()??null,folders:provider==='gmail'?[...locator.label_ids]:[provider==='microsoft'?locator.folder_id:locator.mailbox],flags:{seen:true,flagged:locator.label_ids?.includes('STARRED')??false,answered:false},message_id:bounded(parsed.messageId),references:bounded(Array.isArray(parsed.references)?parsed.references.join(' '):parsed.references),in_reply_to:bounded(parsed.inReplyTo),body_status:'lazy',files_status:provider==='microsoft'&&parsed.attachments.length?'lazy':'unknown'});
 }
 return messages;
}
export async function buildEmailMetadataFixturePages({scope,account_id,limit=2,index=null}={}){
 validateEmailScope(scope);if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('EMAIL_METADATA_FIXTURE_LIMIT');
 const summaries=await loadEmailMetadataFixtureSummaries(account_id),logical=index??new LogicalMailIndex(scope),pages=[];
 const folder_map=account_id==='microsoft'?{inbox:['synthetic-graph-inbox'],sent:[],archive:[]}:account_id==='imap'?{inbox:['INBOX'],sent:[],archive:['Archive']}:null;
 for(let offset=0;offset<summaries.length;offset+=limit)pages.push({schema_version:'deft.app_sync_page.v2',upserts:summaries.slice(offset,offset+limit).map(summary=>projectEmailMetadata(logical.upsert(scope,summary),{folder_map})),tombstones:[],next_cursor:offset+limit<summaries.length?`fixture-page-${offset+limit}`:null,has_more:offset+limit<summaries.length});
 return {pages,index:logical};
}
