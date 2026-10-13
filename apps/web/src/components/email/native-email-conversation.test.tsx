import test from 'node:test';
import assert from 'node:assert/strict';
import {Children,createElement,isValidElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {nativeMessageUrl,parseNativeMessageLink} from '@/lib/email-native-message-links';
import {NativeEmailConversation,NativeEmailConversationList} from './native-email-conversation';
const id='mail_'+'a'.repeat(64);
test('conversation is an explicit compact control without auto-expanded provider results',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailConversation,{accountId:'a',anchorId:id,sessionScope:'session',address:'owner@example.test',selectedId:id,open:false,onOpen:()=>{},onClose:()=>{},onSelect:()=>{},onDenied:()=>{}}));
 assert.match(html,/aria-expanded="false"/);assert.match(html,/>Conversation<\/button>/);assert.doesNotMatch(html,/Loading related|mail_aaaa|border-b/);
 const unsupported=renderToStaticMarkup(createElement(NativeEmailConversation,{accountId:'a',anchorId:id,sessionScope:'session',address:'owner@example.test',selectedId:id,open:false,supported:false,onOpen:()=>{},onClose:()=>{},onSelect:()=>{},onDenied:()=>{}}));assert.match(unsupported,/disabled=""/);assert.match(unsupported,/not available for this account provider/);
});
test('real conversation list renders safe summaries, loaded count, partial result hint and explicit More',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailConversationList,{state:{state:'available',busy:false,items:[{account_id:'a',logical_message_id:id,revision:'v1',received_at:'2026-10-04T00:00:00Z',folders:['inbox'],flags:{seen:true,flagged:false,answered:false},data:{from:'sender@example.test',subject:'<img src=x onerror=alert(1)>'}}],nextCursor:'private_sealed_cursor',complete:false,limited:false,failureCount:1,notice:'Some related messages could not be loaded.'},address:'owner@example.test',selectedId:id,onClose:()=>{},onSelect:()=>{},onMore:()=>{},onReload:()=>{}}));
 assert.match(html,/1 messages loaded · more messages may exist/);assert.match(html,/Load more/);assert.match(html,/aria-pressed="true"/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|private_sealed_cursor|mail_aaaa|border-b/);
});

test('selecting an actual conversation row nominates its exact account/message for native navigation',()=>{
 const message={account_id:'account/one',logical_message_id:id,revision:'r1',received_at:null,folders:['inbox'],flags:{seen:true,flagged:false,answered:false},data:{subject:'Related'}};let url='';
 const tree=NativeEmailConversationList({state:{state:'available',busy:false,items:[message],nextCursor:null,complete:true,limited:false,failureCount:0,notice:''},address:'owner@example.test',selectedId:id,onClose:()=>{},onSelect:row=>{url=nativeMessageUrl(row);},onMore:()=>{},onReload:()=>{}});
 const buttons:(()=>void)[]=[];const visit=(node:ReactNode)=>{Children.forEach(node,child=>{if(!isValidElement<{children?:ReactNode;onClick?:()=>void;'aria-pressed'?:boolean}>(child))return;if(child.type==='button'&&child.props['aria-pressed']!==undefined&&child.props.onClick)buttons.push(child.props.onClick);visit(child.props.children);});};visit(tree);
 assert.equal(buttons.length,1);buttons[0]!();assert.deepEqual(parseNativeMessageLink(url.split('?')[1]!),{account_id:message.account_id,logical_message_id:message.logical_message_id});
});
test('IMAP opens an honest Related messages control and never presents header matches as a complete provider thread',()=>{
 const control=renderToStaticMarkup(createElement(NativeEmailConversation,{accountId:'imap',anchorId:id,sessionScope:'session',address:'owner@example.test',selectedId:id,open:false,headerRelated:true,onOpen:()=>{},onClose:()=>{},onSelect:()=>{},onDenied:()=>{}}));assert.match(control,/>Related messages<\/button>/);assert.doesNotMatch(control,/>Conversation<\/button>|disabled=""/);
 const html=renderToStaticMarkup(createElement(NativeEmailConversationList,{state:{state:'available',busy:false,items:[],nextCursor:null,complete:false,limited:false,failureCount:0,notice:'',threadBasis:'message_headers',limitations:['Header lookup is partial.']},address:'owner@example.test',selectedId:id,onClose:()=>{},onSelect:()=>{},onMore:()=>{},onReload:()=>{}}));assert.match(html,/aria-label="Related messages"/);assert.match(html,/related by their headers/);assert.match(html,/may not include the full exchange/);assert.match(html,/more messages may exist/);assert.doesNotMatch(html,/No related messages found|>Conversation<|complete thread/);
});
