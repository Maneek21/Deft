import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {NativeEmailForwardFiles} from './native-email-forward-files';
test('oversized original remains visible as source-only without selectable inclusion or blocked text-only Forward',()=>{
 const html=renderToStaticMarkup(<NativeEmailForwardFiles value={{files:[{file_ref:'b'.repeat(64),filename:'large.dat',size_bytes:26*1024*1024,state:'source_only',notice:'This file exceeds the 25 MiB attachment limit. Download the original message to access it; it cannot be included here.'}],busy:false,blocked:false,notice:''}} disabled={false} onInclude={()=>assert.fail('No inclusion')} onOmit={()=>assert.fail('No omission')} onCheck={()=>{}}/>);
 assert.match(html,/large.dat/);assert.match(html,/original message only/);assert.match(html,/25 MiB attachment limit/);assert.doesNotMatch(html,/type="checkbox"|Include selected originals|Finish including|bbbbbbbb/);
});
test('original-file choices are explicit with per-file failure and no raw source authority IDs',()=>{
 const html=renderToStaticMarkup(<NativeEmailForwardFiles value={{files:[{file_ref:'b'.repeat(64),filename:'report.txt',size_bytes:5,state:'failed',notice:'Could not include file.'}],busy:false,blocked:true,notice:''}} disabled={false} onInclude={()=>{}} onOmit={()=>{}} onCheck={()=>{}}/>);
 assert.match(html,/Include selected originals/);assert.match(html,/Include report.txt/);assert.match(html,/Omit report.txt/);assert.match(html,/before sending/);assert.doesNotMatch(html,/bbbbbbbb|source_digest|file_ref/);
});
test('unconfirmed upload offers exact saved-draft check and neither omit nor a new inclusion',()=>{
 const html=renderToStaticMarkup(<NativeEmailForwardFiles value={{files:[{file_ref:'b'.repeat(64),filename:'report.txt',size_bytes:5,state:'unconfirmed',notice:''}],busy:false,blocked:true,notice:''}} disabled={false} onInclude={()=>{}} onOmit={()=>{}} onCheck={()=>{}}/>);
 assert.match(html,/Check saved attachments/);assert.doesNotMatch(html,/Omit report|Include selected originals/);
 const source=readFileSync(new URL('./native-email-composer.tsx',import.meta.url),'utf8');assert.match(source,/mutationDisabled=disabled\|\|recoveryPaused/);
 const tree=ts.createSourceFile('composer.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let handler:ts.Expression|undefined,disabledExpression:ts.Expression|undefined;const visit=(node:ts.Node)=>{if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(tree)==='button'&&node.getText(tree).includes('<Send size=')){for(const attr of node.openingElement.attributes.properties){if(ts.isJsxAttribute(attr)&&attr.initializer&&ts.isJsxExpression(attr.initializer)){if(attr.name.getText(tree)==='onClick')handler=attr.initializer.expression;if(attr.name.getText(tree)==='disabled')disabledExpression=attr.initializer.expression;}}}ts.forEachChild(node,visit);};visit(tree);assert.ok(handler);assert.ok(disabledExpression);
 const buttonContext={mutationDisabled:false,canSend:true,senderUnavailable:false,recipientNotice:'',preparingFiles:false,forwardState:{blocked:false},state:{state:'clean',fileMutation:null,content:{to:'owner@example.test',cc:'',bcc:''}}};
 const isDisabled=runInNewContext(ts.transpileModule('(()=>('+disabledExpression.getText(tree)+'))',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,buttonContext);assert.equal(isDisabled(),false);
 buttonContext.forwardState.blocked=true;assert.equal(isDisabled(),true);buttonContext.forwardState.blocked=false;buttonContext.preparingFiles=true;assert.equal(isDisabled(),true);buttonContext.preparingFiles=false;buttonContext.mutationDisabled=true;assert.equal(isDisabled(),true);buttonContext.mutationDisabled=false;buttonContext.recipientNotice='Too many recipients';assert.equal(isDisabled(),true);
 let sent=0;const context={intakeOwner:{current:null},recoveryPaused:true,recipientNotice:'',forwardBlocked:{current:false},sender:{current:{send:()=>{sent++;}}}};const click=runInNewContext(ts.transpileModule('('+handler.getText(tree)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);
 click();assert.equal(sent,0);context.recoveryPaused=false;context.forwardBlocked.current=true;click();assert.equal(sent,0);context.forwardBlocked.current=false;context.recipientNotice='Too many recipients';click();assert.equal(sent,0);context.recipientNotice='';click();assert.equal(sent,1);
});
