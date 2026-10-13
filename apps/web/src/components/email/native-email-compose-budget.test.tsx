import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {createNativeDraftWriter,emptyNativeDraft} from '@/lib/email-native-drafts';
import {createNativeOutboxSend} from '@/lib/email-native-outbox';
import {parseNativeSafeComposeHtml} from '../../../../../packages/app-kit/src/safe-compose-html';

const source=ts.createSourceFile('composer.tsx',readFileSync(new URL('./native-email-composer.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function actual(predicate:(node:ts.Node)=>boolean,context:Record<string,unknown>){let found:ts.Node|undefined;const visit=(node:ts.Node)=>{if(predicate(node))found=node;ts.forEachChild(node,visit);};visit(source);assert.ok(found);return runInNewContext(ts.transpileModule('('+found.getText(source)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);}

test('bounded rich pair above whole JSON budget stays dirty; actual Save/close/Send/Schedule make zero requests',async()=>{
 let calls=0,closed=0,saved=0,current=true;const body='😀'.repeat(100000),body_html='<p>'+body+'</p>',content={...emptyNativeDraft(),to:'person@example.test',body,body_html};
 assert.equal(parseNativeSafeComposeHtml(body_html).plainText,body);
 const writer=createNativeDraftWriter({accountId:'account',draftId:'00000000-0000-4000-8000-000000000001',current:()=>current,api:{read:async()=>{throw Error('unexpected read');},save:async()=>{calls++;throw Error('unexpected save');}},change:()=>{}});writer.edit(content);
 const latest={current:writer.snapshot()},save=actual(node=>ts.isArrowFunction(node)&&ts.isVariableDeclaration(node.parent)&&node.parent.name.getText(source)==='save',{intakeOwner:{current:null},recoveryState:null,recoveryPaused:false,sendLatest:{current:{locked:false,busy:false}},writer:{current:writer},latest,onSaved:()=>{saved++;},onClose:()=>{closed++;}});
 await save(true);assert.equal(calls,0);assert.equal(closed,0);assert.equal(saved,0);assert.equal(writer.snapshot().dirty,true);assert.equal(writer.snapshot().state,'error');assert.equal(writer.snapshot().content.body,body);assert.equal(writer.snapshot().content.body_html,body_html);
 const sender=createNativeOutboxSend({accountId:'account',draftId:'00000000-0000-4000-8000-000000000001',current:()=>current,writer:()=>writer,fetch:async()=>{calls++;throw Error('unexpected enqueue');},change:()=>{},rowChanged:()=>{},denied:()=>{},queued:()=>{},accepted:()=>{},cancelled:()=>{},legacyInspect:async()=>{throw Error('unexpected legacy status');}});
 await sender.send();await sender.send({wall_time:'2030-01-01T12:00',zone:'UTC',ambiguity:'reject',missed_policy:'pause_if_late'});assert.equal(calls,0);assert.equal(sender.snapshot().locked,false);assert.equal(writer.snapshot().dirty,true);
 latest.current=writer.snapshot();let prevented=false,stopped=false,notice='';const handlers=new Map<string,(event:unknown)=>void>();class Anchor{closest(){return this;}getAttribute(key:string){return key==='href'?'/tasks':null;}hasAttribute(){return false;}}
 const cleanup=actual(node=>ts.isArrowFunction(node)&&ts.isCallExpression(node.parent)&&node.getText(source).includes("document.addEventListener('click',guard,true)"),{latest,Element:Anchor,URL,location:{href:'https://demo.test/email',origin:'https://demo.test'},setLeaveNotice:(value:string)=>{notice=value;},document:{addEventListener:(name:string,fn:(event:unknown)=>void)=>handlers.set(name,fn),removeEventListener:(name:string)=>handlers.delete(name)}})();
 handlers.get('click')!({target:new Anchor(),button:0,defaultPrevented:false,preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});assert.equal(prevented,true);assert.equal(stopped,true);assert.match(notice,/edits are still here/);cleanup();assert.equal(handlers.size,0);
 let switched=false;const changeAccount=actual(node=>ts.isArrowFunction(node)&&ts.isVariableDeclaration(node.parent)&&node.parent.name.getText(source)==='changeAccount',{fixed:true,sendLatest:{current:{locked:false}},preparing:false,intakeOwner:{current:null},setAccountId:()=>{switched=true;}});changeAccount('other');assert.equal(switched,false);assert.equal(writer.snapshot().content.body,body);
 // An explicit copy preserves the complete bounded pair; expired owners may
 // neither save it nor publish a result. No oversized browser journal is added.
 const copy=writer.snapshot().content;current=false;assert.equal(await writer.save(),false);assert.equal(calls,0);sender.dispose();writer.dispose();
 const restored=createNativeDraftWriter({accountId:'account',draftId:'00000000-0000-4000-8000-000000000002',initialContent:copy,current:()=>true,api:{read:async()=>{throw Error('unexpected read');},save:async()=>{calls++;throw Error('unexpected save');}},change:()=>{}});assert.equal(restored.snapshot().content.body_html,body_html);assert.equal(await restored.save(),false);assert.equal(restored.snapshot().dirty,true);assert.equal(calls,0);restored.dispose();
});
