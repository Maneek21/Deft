import test from 'node:test';import assert from 'node:assert/strict';import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {NativeEmailDraftRecovery} from './native-email-draft-recovery';
import {emptyNativeDraft,createNativeDraftWriter,type NativeDraftSaveState,type NativeDraft} from '@/lib/email-native-drafts';
import {createNativeDraftRecovery} from '@/lib/email-native-draft-recovery';
import type {NativeDraftRecoveryState} from '@/lib/email-native-draft-recovery';
import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';import ts from 'typescript';
const editor:NativeDraftSaveState={content:emptyNativeDraft(),revision:2,dirty:false,state:'idle',notice:''};
const value:NativeDraftRecoveryState={checking:false,status:'ready',notice:'',candidate:{content:{...emptyNativeDraft(),subject:'Browser subject',body:'<img src="https://untrusted.test">'},localRevision:1,baseServerRevision:2,dirty:true,sendOutcome:'none',updatedAt:1}};
const render=(state=value,live=editor,locked=false)=>renderToStaticMarkup(createElement(NativeEmailDraftRecovery,{value:state,editor:live,locked,onRestore:()=>{},onCopy:()=>{},onKeep:()=>{}}));
test('recovery preview is escaped text and only exact untouched server version offers Restore',()=>{
 const html=render();assert.match(html,/Restore browser draft/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);assert.match(html,/Attachment bytes are not stored/);
 assert.match(render(value,{...editor,revision:3}),/Open as new draft/);assert.doesNotMatch(render(value,{...editor,revision:3}),/Restore browser draft/);
 assert.match(render(value,{...editor,dirty:true}),/disabled=""/);assert.equal(render(value,editor,true),'');
});
test('unknown sending copy offers no Restore or new-copy action',()=>{
 const html=render({...value,candidate:{...value.candidate!,sendOutcome:'unknown'}});assert.match(html,/sending outcome needs checking/);assert.doesNotMatch(html,/Restore browser draft|Open as new draft/);
});
test('actual composer Restore handler edits the live writer only after coordinator returns a permitted copy',()=>{
 const source=readFileSync(new URL('./native-email-composer.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('composer.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let node:ts.Expression|undefined;
 const visit=(n:ts.Node)=>{if(ts.isVariableDeclaration(n)&&n.name.getText(tree)==='restoreBrowser')node=n.initializer;ts.forEachChild(n,visit);};visit(tree);assert.ok(node);
 let changed='',eligible=true,locked=false,allowed=true;
 const context={writer:{current:{snapshot:()=>editor,edit:(content:{body:string})=>{changed=content.body;}}},sendLatest:{current:{get locked(){return locked;}}},recovery:{current:{restore:()=>allowed?{...emptyNativeDraft(),body:'recovered'}:null}},initialSignatureEligible:{get current(){return eligible;},set current(v:boolean){eligible=v;}}};
 const actual=runInNewContext(ts.transpileModule('('+node.getText(tree)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);
 actual();assert.equal(changed,'recovered');assert.equal(eligible,false);changed='';allowed=false;actual();assert.equal(changed,'');allowed=true;locked=true;actual();assert.equal(changed,'');
});
test('actual composer renews on online, focus and bounded interval; offline skips polling and cleanup removes all handlers',()=>{
 const source=readFileSync(new URL('./native-email-composer.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('composer.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let node:ts.Expression|undefined;
 const visit=(n:ts.Node)=>{if(ts.isCallExpression(n)&&n.expression.getText(tree)==='useEffect'&&n.arguments[0]?.getText(tree).includes('setInterval(renew'))node=n.arguments[0];ts.forEachChild(n,visit);};visit(tree);assert.ok(node);
 const handlers=new Map<string,()=>void>(),calls:(boolean|undefined)[]=[];let tick=()=>{},delay=0,cleared=false;const navigator={onLine:true};
 const context={navigator,writer:{current:{snapshot:()=>editor}},recovery:{current:{revalidate:async(force?:boolean,server?:NativeDraftSaveState)=>{calls.push(force);assert.equal(server,editor);}}},window:{addEventListener:(name:string,callback:()=>void)=>handlers.set(name,callback),removeEventListener:(name:string)=>handlers.delete(name)},setInterval:(callback:()=>void,ms:number)=>{tick=callback;delay=ms;return 1;},clearInterval:()=>{cleared=true;}};
 const cleanup=runInNewContext(ts.transpileModule('('+node.getText(tree)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context)();assert.equal(delay,240000);
 tick();handlers.get('focus')!();handlers.get('online')!();assert.deepEqual(calls,[false,false,true]);navigator.onLine=false;tick();assert.equal(calls.length,3);cleanup();assert.equal(cleared,true);assert.equal(handlers.size,0);
});
test('actual recovery pause never blocks authoritative Send status navigation',()=>{
 const source=readFileSync(new URL('./native-email-composer.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('composer.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let node:ts.Expression|undefined;
 const visit=(n:ts.Node)=>{if(ts.isVariableDeclaration(n)&&n.name.getText(tree)==='recoveryPaused')node=n.initializer;ts.forEachChild(n,visit);};visit(tree);assert.ok(node);
 const expression=ts.transpileModule(node.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 assert.equal(runInNewContext(expression,{sendState:{locked:false},recoveryState:value}),true);assert.equal(runInNewContext(expression,{sendState:{locked:true},recoveryState:value}),false);
});
test('actual manual Save preserves the browser candidate while saving current dirty edits; close still requires a choice',async()=>{
 const source=readFileSync(new URL('./native-email-composer.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('composer.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let node:ts.Expression|undefined;
 const visit=(n:ts.Node)=>{if(ts.isVariableDeclaration(n)&&n.name.getText(tree)==='save')node=n.initializer;ts.forEachChild(n,visit);};visit(tree);assert.ok(node);
 let writes=0,saved=0,closed=0;const recovery=createNativeDraftRecovery({scope:{orgId:'org',userId:'user',accountId:'account',draftId:'draft'},current:()=>true,prove:async()=>{},open:async()=>({read:async()=>value.candidate!,put:async()=>{writes++;return value.candidate!;}}),change:()=>{}});await recovery.start(editor);
 const row:NativeDraft={draft_id:'draft',revision:2,status:'draft',content:emptyNativeDraft(),origin:{kind:'human',created_by_user_id:'user',originating_run_id:null},last_edited_by_user_id:'user',created_at:'2026-10-04T00:00:00Z',updated_at:'2026-10-04T00:00:00Z'};
 const writer=createNativeDraftWriter({accountId:'account',draftId:'draft',initial:row,current:()=>true,api:{read:async()=>row,save:async(_account,_draft,revision,content)=>({...row,revision:revision+1,content})},change:next=>recovery.record(next)});writer.edit({...emptyNativeDraft(),body:'Current typed text'});
 const context={intakeOwner:{current:null},recoveryPaused:true,recoveryState:recovery.snapshot(),sendLatest:{current:{locked:false,busy:false}},writer:{current:writer},latest:{current:writer.snapshot()},onSaved:()=>{saved++;},onClose:()=>{closed++;}};
 const actual=runInNewContext(ts.transpileModule('('+node.getText(tree)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);
 await actual();assert.equal(saved,1);assert.equal(writer.snapshot().revision,3);assert.equal(writer.snapshot().dirty,false);assert.equal(recovery.snapshot().candidate?.content.subject,'Browser subject');assert.equal(writes,0);
 await actual(true);assert.equal(closed,0);context.recoveryState={...recovery.snapshot(),checking:true};writer.edit({...writer.snapshot().content,body:'More typing'});await actual();assert.equal(saved,1);recovery.dispose();writer.dispose();
});

test('actual composer save-and-close exits a blank new compose without creating an empty server draft',async()=>{
 const source=readFileSync(new URL('./native-email-composer.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('composer.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let node:ts.Expression|undefined;
 const visit=(n:ts.Node)=>{if(ts.isVariableDeclaration(n)&&n.name.getText(tree)==='save')node=n.initializer;ts.forEachChild(n,visit);};visit(tree);assert.ok(node);
 let writes=0,closed=0;
 const writer=createNativeDraftWriter({accountId:'account',draftId:'draft',current:()=>true,api:{read:async()=>{throw Error('unexpected read');},save:async()=>{writes++;throw Error('empty request');}},change:()=>{}});
 const context={intakeOwner:{current:null},recoveryPaused:false,recoveryState:null,sendLatest:{current:{locked:false,busy:false}},writer:{current:writer},latest:{current:writer.snapshot()},onSaved:()=>{},onClose:()=>{closed++;}};
 const actual=runInNewContext(ts.transpileModule('('+node.getText(tree)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);
 await actual(true);assert.equal(closed,1);assert.equal(writes,0);assert.equal(writer.snapshot().revision,0);writer.dispose();
});

test('actual composer new-copy handlers preserve agent provenance by keeping the live text instead of creating a human UUID',()=>{
 const source=readFileSync(new URL('./native-email-composer.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('composer.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 for(const name of ['copy','copyBrowser']){let node:ts.Expression|undefined;const visit=(n:ts.Node)=>{if(ts.isVariableDeclaration(n)&&n.name.getText(tree)===name)node=n.initializer;ts.forEachChild(n,visit);};visit(tree);assert.ok(node);let notice='';const context={origin:'agent',sendLatest:{current:{locked:false}},setLeaveNotice:(value:string)=>{notice=value;}};const actual=runInNewContext(ts.transpileModule('('+node.getText(tree)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);actual();assert.match(notice,/agent draft|Agent draft/);}
 const html=renderToStaticMarkup(createElement(NativeEmailDraftRecovery,{value,editor:{...editor,revision:3},locked:false,copyAllowed:false,onRestore:()=>{},onCopy:()=>{},onKeep:()=>{}}));assert.match(html,/agent draft/);assert.doesNotMatch(html,/Open as new draft/);
});
