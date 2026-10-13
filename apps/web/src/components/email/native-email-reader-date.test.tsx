import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NativeEmailHeaderDate,NativeEmailHeaderSummary} from './native-email-reader';
import {getUserTimezone,setUserTimezone} from '@/lib/time';
const list=(count:number)=>Array.from({length:count},(_,i)=>`Synthetic${String(i).padStart(3,'0')} <recipient${String(i).padStart(3,'0')}@example.test>`).join(', ');
const addressSummary=(headers:Array<{label:string;value:string}>,metadata?:Record<string,string>,replySeedUnavailable?:Array<'reply_from'|'reply_to'|'reply_to_list'|'reply_cc'>)=>renderToStaticMarkup(createElement(NativeEmailHeaderSummary,{headers,metadata,replySeedUnavailable}));
const primary=(html:string)=>html.slice(0,html.indexOf('<details'));
test('complete native33/200 recipients have bounded first-plus-count summary and complete collapsed details',()=>{
 for(const count of [33,200]){const value=list(count),html=addressSummary([{label:'From',value:'sender@example.test'},{label:'To',value:value.slice(0,2048)}],{reply_to_list:value}),closed=primary(html);assert.match(closed,new RegExp('To: Synthetic000 \\+'+(count-1)+' more'));assert.ok(closed.length<800);assert.doesNotMatch(closed,/recipient032|recipient199|incomplete/);assert.ok(html.includes(`recipient${String(count-1).padStart(3,'0')}@example.test`));assert.doesNotMatch(html,/<details[^>]*\sopen(?:[\s=>])/);assert.doesNotMatch(html,/header is incomplete/);}
});
test('unavailable seed flags supersede capped or short display and preserve truthful original guidance in details',()=>{
 const value=list(201).slice(0,2048),html=addressSummary([{label:'To',value}],{reply_to_list:''},['reply_to_list']),closed=primary(html);assert.match(closed,/To: Recipient list incomplete/);assert.doesNotMatch(closed,/Synthetic|recipient|2048/);assert.ok(html.includes(value.replace(/</g,'&lt;').replace(/>/g,'&gt;')));assert.match(html,/This address header is incomplete\. Download the original message/);
 const short=addressSummary([{label:'To',value:'recipient@example.test'}],{reply_to_list:'recipient@example.test'},['reply_to_list']);assert.match(primary(short),/Recipient list incomplete/);assert.doesNotMatch(primary(short),/recipient@example.test/);
 const missing=addressSummary([],{reply_to_list:''},['reply_to_list']);assert.match(primary(missing),/To: Recipient list incomplete/);assert.match(missing,/>To<\/dt>/);assert.match(missing,/Download the original message/);
});
test('at-cap legacy or invalid metadata marks incomplete; short legacy and inert details remain intact',()=>{
 for(const metadata of [undefined,{reply_to_list:'not a mailbox'},{reply_to_list:'x'.repeat(16385)}]){const html=addressSummary([{label:'To',value:list(201).slice(0,2048)}],metadata);assert.match(primary(html),/Recipient list incomplete/);assert.match(html,/header is incomplete/);}
 const short=addressSummary([{label:'From',value:'Alice <alice@example.test>'},{label:'To',value:'Bob <bob@example.test>'},{label:'Cc',value:'<script>alert(1)</script>'}]);assert.match(primary(short),/To: Bob &lt;bob@example.test&gt;/);assert.match(short,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.doesNotMatch(short,/<script>|header is incomplete/);
 const long=addressSummary([{label:'To',value:'legacy '.repeat(100)}]);assert.ok(primary(long).length<800);assert.match(primary(long),/…/);assert.match(long,/legacy legacy/);assert.doesNotMatch(long,/header is incomplete/);
});

test('reader Date uses existing user time zone and keeps exact instant accessible',()=>{
 const original=getUserTimezone();try{setUserTimezone('Asia/Kolkata');const value='2026-10-04T04:22:06.000Z',html=renderToStaticMarkup(createElement(NativeEmailHeaderDate,{value}));assert.match(html,/>Oct 4, 2026, 9:52 AM<\/time>/);assert.match(html,/dateTime="2026-10-04T04:22:06.000Z"/);assert.match(html,/title="2026-10-04T04:22:06.000Z · Asia\/Kolkata"/);assert.match(html,/aria-label=".*Original timestamp 2026-10-04T04:22:06.000Z/);}finally{setUserTimezone(original);}
});
test('reader preserves original RFC date or invalid values instead of guessing a zone',()=>{
 for(const value of ['Sun, 04 Oct 2026 04:22:06 +0000','Not a date','2026-02-30T04:22:06.000Z']){const html=renderToStaticMarkup(createElement(NativeEmailHeaderDate,{value}));assert.equal(html,value);assert.doesNotMatch(html,/<time/);}
});


test('reader keeps the full envelope in collapsed message details with a compact sender summary',()=>{
 const headers=[{label:'Subject',value:'A subject'},{label:'From',value:'Alice <alice@example.com>'},{label:'To',value:'Bob <bob@example.com>'},{label:'Cc',value:'Carol <carol@example.com>'},{label:'Reply-To',value:'support@example.com'},{label:'Date',value:'2026-10-04T04:22:06.000Z'}];
 const html=renderToStaticMarkup(createElement(NativeEmailHeaderSummary,{headers}));
 assert.match(html,/Alice &lt;alice@example.com&gt;/);
 assert.match(html,/To: Bob &lt;bob@example.com&gt;/);
 assert.match(html,/<details[^>]*><summary[^>]*>Message details<\/summary>/);
 assert.doesNotMatch(html,/<details[^>]*\sopen(?:[\s=>])/);
 for(const {label,value} of headers.filter(h=>!['Subject','Date'].includes(h.label))){assert.ok(html.includes(`<dt class="text-[var(--text-secondary)]">${label}</dt>`));assert.ok(html.includes(value.replace(/</g,'&lt;').replace(/>/g,'&gt;')));}
 assert.match(html,/<time dateTime="2026-10-04T04:22:06.000Z"/);
 assert.doesNotMatch(html,/A subject/);
});
test('reader header summary tolerates missing envelope fields',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailHeaderSummary,{headers:[]}));
 assert.match(html,/Unknown sender/);assert.match(html,/Message details/);assert.doesNotMatch(html,/To:/);
});
