import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {NativeEmailContextTransferAction} from './native-email-context-transfer';

test('reader action stays compact and does not expose source text before explicit opening',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailContextTransferAction,{target:{account_id:'private-account',logical_message_id:'mail_'+'a'.repeat(64)},sessionScope:'session',plainText:'Private email text'}));
 assert.match(html,/aria-label="Save email to Notes, Knowledge or Chat"/);assert.doesNotMatch(html,/Private email text|private-account|aria-modal|border-b/);
});
test('current loaded reader owns the transfer target and source text inside More',()=>{
 const code=readFileSync(new URL('./native-email-reader.tsx',import.meta.url),'utf8');
 assert.ok(code.indexOf('<NativeEmailContextTransferAction')>code.indexOf('aria-label="More reader options"'));
 assert.match(code,/target=\{\{account_id:accountId,logical_message_id:logicalMessageId\}\}/);assert.match(code,/plainText=\{state\.value\.presentation\.plain_text\}/);
});
