import assert from 'node:assert/strict';import test from 'node:test';
import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {AttentionRow} from './attention-row';import type {AttentionItem} from '@/hooks/use-attention';
import {nativeEmailAttentionHref} from '../lib/email-native-notification-link';
import {nativeMessageUrl} from '../lib/email-native-message-links';
const id='mail_'+'a'.repeat(64),target={account_id:'account/one',logical_message_id:id};
const item:AttentionItem={id:'attention',org_id:'org',user_id:'owner',kind:'email_new_message',lane:'updates',priority:'normal',state:'open_unseen',source_type:'email',source_id:id,title:'Sensitive subject',body:'Private sender and preview',link:nativeMessageUrl(target),metadata:{account_id:target.account_id},last_event_at:'2026-10-04T00:00:00Z',event_count:1,snoozed_until:null,created_at:'2026-10-04T00:00:00Z',approval:null};
const render=(value:AttentionItem)=>renderToStaticMarkup(createElement(AttentionRow,{item:value,onSeen:()=>{},onAcknowledge:()=>{},onResolve:()=>{},onSnooze:()=>{}}));
test('Email attention stays contentless and opens only the exact account/message nomination',()=>{
 const markup=render(item);assert.match(markup,/New email/);assert.match(markup,/lucide-mail/);assert.match(markup,/href="\/email\?account=account%2Fone&amp;message=mail_/);assert.doesNotMatch(markup,/Sensitive subject|Private sender/);
 assert.equal(nativeEmailAttentionHref(item),nativeMessageUrl(target));
 for(const changed of [{metadata:{account_id:'other'}},{source_id:'mail_'+'b'.repeat(64)},{link:'https://outside.test/email'},{link:item.link+'&compose=1'},{link:item.link+'&account=other'}]){assert.equal(nativeEmailAttentionHref({...item,...changed}),null);assert.doesNotMatch(render({...item,...changed}),/<a /);}
});
test('other attention items retain their existing title and preview',()=>{assert.match(render({...item,source_type:'task',kind:'task',title:'Task title',body:'Task details',link:'/tasks'}),/Task title/);assert.match(render({...item,source_type:'task',kind:'task',title:'Task title',body:'Task details',link:'/tasks'}),/Task details/);});
