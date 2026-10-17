import test from 'node:test';
import assert from 'node:assert/strict';
import {experiencePresentationHeaders} from './app-experience-presentation-headers';
const presentation={format:'plain' as const,content:'exact body',plain_text:'exact body',truncated:false,images:[],headers:[{label:'To',value:'compact'},{label:'Cc',value:''},{label:'Date',value:'Fri, 9 Oct 2026 20:00:00 +0000'},{label:'Subject',value:'synthetic <script> text'}]};
test('full native list above 32 recipients uses bounded native metadata without changing source/body',()=>{
 const complete=Array.from({length:33},(_,i)=>`Person ${i} <person${i}@example.test>`).join(', '),source={...presentation,metadata:{reply_to_list:complete}},before=JSON.stringify(source),headers=experiencePresentationHeaders(source);
 assert.equal(headers[0].value,complete);assert.equal(headers[0].incomplete,false);assert.equal(headers[2].value,presentation.headers[2].value);assert.equal(headers[3].value,'synthetic <script> text');assert.equal(JSON.stringify(source),before);
});
test('truncated or malformed/over-limit recipient metadata never implies completeness',()=>{
 for(const raw of ['not a mailbox',Array.from({length:201},(_,i)=>`person${i}@example.test`).join(', ')])assert.equal(experiencePresentationHeaders({...presentation,metadata:{reply_to_list:raw}})[0].incomplete,true);
 assert.equal(experiencePresentationHeaders({...presentation,headers:[{label:'To',value:'a'.repeat(2048)}]})[0].incomplete,true);
});
