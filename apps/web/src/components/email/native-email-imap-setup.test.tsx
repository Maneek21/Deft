import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NativeEmailImapFields} from './native-email-imap-setup';
test('compact IMAP setup uses secure ports, password inputs and explicit optional SMTP without technical IDs',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailImapFields,{busy:false,smtp:true,onSmtp:()=>{}}));assert.match(html,/IMAP/);assert.match(html,/SMTP/);for(const port of ['993','143','465','587'])assert.match(html,new RegExp('port '+port));assert.equal((html.match(/type="password"/g)??[]).length,2);assert.match(html,/stored encrypted/);assert.doesNotMatch(html,/resource_binding_id|account_id|localStorage|Exposure|border-b/);
 const busy=renderToStaticMarkup(createElement(NativeEmailImapFields,{busy:true,smtp:false,onSmtp:()=>{}}));assert.match(busy,/<fieldset disabled=""/);assert.doesNotMatch(busy,/Outgoing mail/);
});
