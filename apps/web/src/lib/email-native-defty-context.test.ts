import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseEmailChatContext,parseEmailDeftyHandoff,appendEmailChatContext} from './email-native-defty-context';
const context={accountId:'account-a',messageId:'mail_'+'a'.repeat(64),spaceId:'dm-a'};
const url='/chat?'+new URLSearchParams({space:context.spaceId,email_account:context.accountId,email_message:context.messageId}).toString();
test('Defty handoff binds exact native message, account and private destination',()=>{
  assert.deepEqual(parseEmailChatContext(url.slice(6)),context);
  assert.deepEqual(parseEmailDeftyHandoff({space_id:'dm-a',account_id:'account-a',logical_message_id:context.messageId,url},context),{spaceId:'dm-a',url});
  for(const invalid of [url+'&email_account=other',url.replace('account-a','account-b'),url+'&other=1','https://outside.invalid'+url])assert.throws(()=>parseEmailDeftyHandoff({space_id:'dm-a',account_id:'account-a',logical_message_id:context.messageId,url:invalid},context));
});
test('explicit send preserves user draft and adds only an escaped opaque native reference',()=>{
  const original='<p>Please summarize this agreement.</p>',sent=appendEmailChatContext(original,context);
  assert.ok(sent.startsWith(original));assert.ok(sent.includes('Email context: /email?account=account-a&amp;message=mail_'));assert.doesNotMatch(sent,/email body|auto-send/);
  assert.equal(parseEmailChatContext('space=dm&email_account=a&email_message=invalid'),null);
});
test('source context is confined to DM and consumes query only after successful explicit send',()=>{
  const code=readFileSync(new URL('../components/space-chat.tsx',import.meta.url),'utf8');
  const schedule=code.slice(code.indexOf('const handleScheduleSend'),code.indexOf('const handleRichSend'));
  assert.doesNotMatch(schedule,/appendEmailChatContext|onClearEmailContext/);
  const send=code.slice(code.indexOf('const handleRichSend'),code.indexOf('const handleEditLastMessage'));
  assert.match(send,/spaceType==='dm'/);assert.ok(send.indexOf('onClearEmailContext')>send.indexOf('await response.json()'));assert.ok(send.indexOf('appendEmailChatContext')<send.indexOf('api.post'));
  const page=readFileSync(new URL('../app/(app)/chat/page.tsx',import.meta.url),'utf8');assert.match(page,/activeSpace.type==='dm'/);assert.match(page,/context.messageId!==sent.messageId/);
});
