export type EmailChatContext={accountId:string;messageId:string;spaceId:string};
const safeId=(value:unknown):value is string=>typeof value==='string'&&!!value&&value.length<=256&&value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export function parseEmailChatContext(search:string):EmailChatContext|null {
  const params=new URLSearchParams(search);
  if(!params.has('email_account')&&!params.has('email_message'))return null;
  if(['space','email_account','email_message'].some(key=>params.getAll(key).length!==1)||!safeId(params.get('space'))||!safeId(params.get('email_account'))||!/^mail_[a-f0-9]{64}$/u.test(params.get('email_message')??''))return null;
  return {spaceId:params.get('space')!,accountId:params.get('email_account')!,messageId:params.get('email_message')!};
}
export function parseEmailDeftyHandoff(raw:unknown,target:{accountId:string;messageId:string}):{spaceId:string;url:string} {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Defty could not be opened.');
  const value=raw as Record<string,unknown>;
  if(!safeId(value.space_id)||value.account_id!==target.accountId||value.logical_message_id!==target.messageId||typeof value.url!=='string'||!value.url.startsWith('/chat?'))throw Error('Defty could not be opened.');
  const url=new URL(value.url,'https://deft.invalid'),context=parseEmailChatContext(url.search);
  if(url.origin!=='https://deft.invalid'||url.pathname!=='/chat'||url.hash||[...url.searchParams.keys()].length!==3||context?.spaceId!==value.space_id||context.accountId!==target.accountId||context.messageId!==target.messageId)throw Error('Defty could not be opened.');
  return {spaceId:value.space_id,url:value.url};
}
export function appendEmailChatContext(content:string,context:EmailChatContext):string {
  const parsed=parseEmailChatContext(new URLSearchParams({space:context.spaceId,email_account:context.accountId,email_message:context.messageId}).toString());
  if(!parsed)throw Error('Email context is unavailable.');
  const url='/email?'+new URLSearchParams({account:context.accountId,message:context.messageId}).toString();
  return content+'<p>Email context: '+url.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')+'</p>';
}
