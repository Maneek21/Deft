import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NativeEmailTemplates,NativeTemplateEditorFields,NativeTemplateInsertionReview} from './native-email-templates';
import {emptyNativeDraft} from '@/lib/email-native-drafts';
const text={subject:'Template subject',body:'Hello <script>world</script>',body_html:''};
test('account template settings are compact, explicitly managed and contain no sender or credential controls',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailTemplates,{accountId:'private-account',sessionScope:'private-session'}));assert.match(html,/Manage templates/);assert.match(html,/More in Compose/);assert.doesNotMatch(html,/private-account|private-session|border-b|password|Send message/);
});
test('insertion preserves current text by default and replacement clearly reviews manually typed signature loss',()=>{
 const current={...emptyNativeDraft(),subject:'Current subject',body:'Current message\nSignature'};
 const render=(mode:'append'|'replace')=>renderToStaticMarkup(createElement(NativeTemplateInsertionReview,{current,text,mode,onMode:()=>{},onInsert:()=>{},disabled:false}));
 const append=render('append');assert.match(append,/Append and keep current subject/);assert.match(append,/Current subject/);assert.match(append,/Current message/);assert.match(append,/Signature/);assert.match(append,/&lt;script&gt;/);assert.doesNotMatch(append,/<script>/);assert.match(append,/From, recipients, reply context and attachments stay/);
 const replace=render('replace');assert.match(replace,/including any signature typed into it/);assert.match(replace,/Replace with reviewed template/);assert.match(replace,/Template subject/);assert.doesNotMatch(replace,/Current message/);
});
test('template editor exposes name and safe message fields with text-placeholder guidance, without raw HTML entry',()=>{
 const html=renderToStaticMarkup(createElement(NativeTemplateEditorFields,{content:{title:'Greeting',...text},disabled:false,onChange:()=>{}}));assert.match(html,/Template name/);assert.match(html,/Template subject/);assert.match(html,/Template message/);assert.match(html,/\{\{name\}\}/);assert.match(html,/Placeholders cannot change links/);assert.doesNotMatch(html,/dangerouslySetInnerHTML|HTML source|To recipients/);
});
