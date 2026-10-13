import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NativeEmailActionStatus} from './native-email-action-status';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import type {NativeTriageGroup,NativeTriageState} from '../../lib/email-native-triage';
const noop=()=>{},accounts=[{account_id:'a',primary_address:'a@example.test'},{account_id:'b',primary_address:'b@example.test'}];
const group=(accountId:string,state:'succeeded'|'failed'|'unknown'='succeeded'):NativeTriageGroup=>({accountId,operationId:'private-operation',kind:'star',ids:['mail_'+'a'.repeat(64)],state:'complete',notice:state==='unknown'?'Check status before another action.':'',result:{schema_version:'deft.email_native_triage_result.v1',account_id:accountId,operation_id:'private-operation',operation:'star',items:[{logical_message_id:'mail_'+'a'.repeat(64),state,undo_supported:state==='succeeded'}],undo_available:state==='succeeded',automatic_retry:false}});
const render=(state:NativeTriageState,refreshing=false)=>renderToStaticMarkup(createElement(NativeEmailActionStatus,{state,accounts,refreshing,onCheck:noop,onUndo:noop}));
test('actual host hides only typed mutation pending/success and preserves attention or unrelated refresh notices',()=>{
 const source=ts.createSourceFile('page.tsx',readFileSync(new URL('../../app/(app)/email/page.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let expression:ts.Expression|undefined;const visit=(n:ts.Node)=>{if(ts.isVariableDeclaration(n)&&n.name.getText(source)==='visibleNotice')expression=n.initializer;ts.forEachChild(n,visit);};visit(source);assert.ok(expression);const text=expression.getText(source);
 const evaluate=(kind:string,groups=true)=>runInNewContext(ts.transpileModule('('+text+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{mailboxNotice:{kind},notice:'Exact original notice',triageState:groups?{groups:[{}]}:null,visibleTriageState:groups?{groups:[{}]}:null});
 for(const kind of ['mutation_pending','mutation_success'])assert.equal(evaluate(kind),'');for(const kind of ['mutation_attention','general'])assert.equal(evaluate(kind),'Exact original notice');assert.equal(evaluate('mutation_success',false),'Exact original notice');
});
test('completed action puts summary Undo and named account-details control in one compact row',()=>{
 const html=render({busy:false,summary:'1 updated',groups:[group('a')]});assert.match(html,/flex flex-wrap items-center/);assert.match(html,/aria-label="Undo message action"/);assert.match(html,/aria-label="Message action details by account"[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+"/);assert.match(html,/<div[^>]*hidden=""/);assert.match(html,/a@example.test: 1 updated/);assert.equal((html.match(/role="status"/g)??[]).length,1);assert.doesNotMatch(html,/private-operation/);
 assert.match(render({busy:false,summary:'1 updated',groups:[group('a')]},true),/aria-label="Undo message action" disabled=""/);
});
test('mixed partial and unconfirmed outcomes remain account-attributed above hidden details; unknown permits status only',()=>{
 const html=render({busy:false,summary:'1 updated · 1 unconfirmed',groups:[group('a'),group('b','unknown')]});
 const visible=html.split('<div id=')[0];assert.match(visible,/b@example.test: 1 unconfirmed/);assert.match(visible,/Check status before another action/);assert.match(visible,/aria-label="Check message action status"/);assert.doesNotMatch(html,/Undo message action|Retry action/);assert.equal((html.match(/role="status"/g)??[]).length,1);
 const failed=render({busy:false,summary:'1 updated · 1 not updated',groups:[group('a'),group('b','failed')]});assert.match(failed.split('<div id=')[0],/b@example.test: 1 not updated/);assert.match(failed,/a@example.test: 1 updated/);
 const denied=render({busy:false,summary:'1 unconfirmed',groups:[{...group('b'),state:'denied',result:null,notice:'Account access changed.'}]});assert.match(denied.split('<div id=')[0],/b@example.test: 1 unconfirmed · Account access changed/);assert.doesNotMatch(denied,/Undo message action/);
});
