import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NativeEmailComposer} from './native-email-composer';

test('native composer renders real Send with a capability gate, draft controls and explicit From choices',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailComposer,{accounts:[{account_id:'opaque-one',primary_address:'one@example.test',display_label:'Work'},
  {account_id:'opaque-two',primary_address:'two@example.test',display_label:'Personal'}],selection:{accountId:'opaque-one'},sessionScope:'human-session',onClose:()=>{},onSaved:()=>{}}));
 assert.match(html,/aria-label="Compose email"/);assert.match(html,/<button[^>]*aria-label="From one@example.test"[^>]*aria-expanded="false"/);assert.match(html,/one@example.test/);assert.doesNotMatch(html,/aria-label="Sending account"|aria-label="Sender address"|two@example.test/);
 assert.match(html,/Save draft/);assert.match(html,/Reconnect the sending account/);assert.match(html,/>Cc<\/button>/);assert.match(html,/>Bcc<\/button>/);
 assert.match(html,/aria-label="Subject"/);assert.match(html,/<label for="[^"]+"[^>]*>To<\/label>/);assert.match(html,/>Send<\/button>/);
 assert.doesNotMatch(html,/aria-invalid="true"/);
 assert.match(html,/aria-label="Choose attachments"/);assert.match(html,/Attach files/);assert.match(html,/25 MiB/);
});
test('a connected sending account has no invented unavailable status or extra access review',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailComposer,{accounts:[{account_id:'a',primary_address:'owner@example.test',display_label:'',capabilities:['read','send']}],selection:{accountId:'a'},sessionScope:'session',onClose:()=>{},onSaved:()=>{}}));
 assert.match(html,/>Send<\/button>/);assert.doesNotMatch(html,/Sending is not available yet|Reconnect the sending account|Exposure/);
 assert.match(html,/Schedule sending/);assert.doesNotMatch(html,/Undo window for this message/);assert.match(html,/aria-label="Send options"/);
 assert.match(html,/More compose actions/);
});
test('actual composer keeps all raw recipients visible and blocks Send/schedule above aggregate200 while allowing correction',()=>{
 const field=(count:number)=>Array.from({length:count},(_,i)=>`r${i}@example.test`).join(', '),content={mode:'compose' as const,to:field(100),cc:field(100),bcc:'extra@example.test',subject:'Subject',body:'Body',body_html:'',reply_record_id:'',attachments:[]};
 const html=renderToStaticMarkup(createElement(NativeEmailComposer,{accounts:[{account_id:'a',primary_address:'owner@example.test',display_label:'',capabilities:['read','send']}],selection:{accountId:'a',initialContent:content},sessionScope:'session',onClose:()=>{},onSaved:()=>{}}));
 assert.match(html,/Use at most 200 recipients across To, Cc, and Bcc/);assert.match(html,/Your input is kept for correction/);assert.match(html,/extra@example.test/);assert.equal((html.match(/aria-label="Remove /g)??[]).length,201);
 const buttons=html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gu)??[];assert.match(buttons.find(button=>button.endsWith('Send</button>'))??'',/disabled=""/);assert.match(buttons.find(button=>button.includes('aria-label="Schedule sending"'))??'',/disabled=""/);assert.doesNotMatch(buttons.find(button=>button.endsWith('Save draft</button>'))??'',/disabled=""/);
 const corrected=renderToStaticMarkup(createElement(NativeEmailComposer,{accounts:[{account_id:'a',primary_address:'owner@example.test',display_label:'',capabilities:['read','send']}],selection:{accountId:'a',initialContent:{...content,bcc:''}},sessionScope:'session',onClose:()=>{},onSaved:()=>{}}));assert.doesNotMatch(corrected,/Use at most 200 recipients/);assert.equal((corrected.match(/aria-label="Remove /g)??[]).length,200);
});
