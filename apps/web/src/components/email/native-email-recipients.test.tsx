import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NativeEmailRecipientControl,NativeEmailRecipientSuggestions} from './native-email-recipients';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import * as ts from 'typescript';
import * as React from 'react';
import {parseNativeMailboxList,formatNativeMailboxList} from '../../../../../packages/app-kit/src/mailbox-list';
import {nativeRecipientKey,selectNativeRecipient,nativeRecipientAssistanceStatus} from '@/lib/email-native-recipients';
test('native recipient pills keep visible labels and accessible keyboard suggestion input',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailRecipientControl,{label:'To',value:'"Ada" <Ada@example.test>',accountId:'account',sessionScope:'sid',onChange:()=>{}}));assert.match(html,/role="combobox"/);assert.match(html,/aria-autocomplete="list"/);assert.match(html,/aria-expanded="false"/);assert.match(html,/Remove Ada@example.test from To/);assert.match(html,/arrow keys and Enter/);assert.doesNotMatch(html,/private|provider locator|CRM record/);
});
test('actual native33/200 chips preserve full names and201 stays visible as invalid text',()=>{
 const recipients=(count:number)=>Array.from({length:count},(_,i)=>`Person ${i} <r${i}@example.test>`).join(', ');
 const render=(value:string)=>renderToStaticMarkup(createElement(NativeEmailRecipientControl,{label:'Cc',value,accountId:'account',sessionScope:'sid',onChange:()=>{}}));
 for(const count of [33,200]){const html=render(recipients(count));assert.equal((html.match(/aria-label="Remove /g)??[]).length,count);assert.match(html,new RegExp(`Remove r${count-1}@example.test from Cc`));assert.doesNotMatch(html,/aria-invalid="true"/);}
 const input=recipients(201),html=render(input);assert.match(html,/aria-invalid="true"/);assert.match(html,/r200@example.test/);assert.match(html,/value="Person 0/);assert.doesNotMatch(html,/aria-label="Remove /);
});
test('actual33-chip remove handler edits exactly one recipient with order and names retained',()=>{
 const value=Array.from({length:33},(_,i)=>`Person ${i} <r${i}@example.test>`).join(', '),f=keyboardMount(value),element=f.render();
 f.chip(element,'r16@example.test').props.onClick();assert.equal(f.writes.length,1);assert.deepEqual(parseNativeMailboxList(f.value).map(row=>({address:row.address,name:row.displayName})),Array.from({length:33},(_,i)=>({address:`r${i}@example.test`,name:`Person ${i}`})).filter((_,index)=>index!==16));f.dispose();
});

test('incomplete pasted recipients stay visible for correction',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailRecipientControl,{label:'Bcc',value:'unfinished@',accountId:'account',sessionScope:'sid',onChange:()=>{}}));assert.match(html,/value="unfinished@"/);assert.match(html,/aria-invalid="true"/);
});
test('actual suggestion list shows every contributed source and disambiguates identical names by exact addresses',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailRecipientSuggestions,{id:'to',label:'To',selected:1,onChoose:()=>{},items:[{address:'Ada@example.test',name:'Ada',provenance:['contacts','recent']},{address:'other@example.test',name:'Ada',provenance:['recent']}]}));
 assert.match(html,/aria-label="To recipient suggestions for the sending account"/);assert.match(html,/aria-label="Ada, Ada@example.test · Contact · Recent"/);assert.match(html,/aria-label="Ada, other@example.test · Recent"/);assert.match(html,/id="to-option-1"[^>]*aria-selected="true"/);assert.match(html,/>Ada@example.test<\/span>/);assert.doesNotMatch(html,/account_id|CRM|provider locator|border-b/);
});

/** Real native component hooks/callbacks with ref-backed focus targets. This is
 * local focus ownership evidence, not a browser/assistive-technology claim. */
function keyboardMount(initial='First <first@example.test>, Second <second@example.test>'){
 const file=process.env.NATIVE_RECIPIENT_SOURCE||new URL('./native-email-recipients.tsx',import.meta.url),text=readFileSync(file,'utf8'),tree=ts.createSourceFile('recipient.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const component=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='NativeEmailRecipientControl')!;
 const parser=tree.statements.flatMap(n=>ts.isVariableStatement(n)?[...n.declarationList.declarations]:[]).find(n=>n.name.getText(tree)==='parse')!;
 const compile=(value:string,context:Record<string,unknown>)=>runInNewContext(ts.transpileModule('('+value+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,context);
 const parse=compile(parser.initializer!.getText(tree),{parseNativeMailboxList}),slots:any[]=[],effects:Array<()=>void>=[],focus:string[]=[],writes:string[]=[];let index=0,value=initial,disabled=false,disposed=false,sessionScope='sid',currentSession='sid';
 const slot=(initial:any)=>{const n=index++;return slots[n]??(slots[n]={value:typeof initial==='function'?initial():initial});};
 const useState=(initial:any)=>{const s=slot(initial);return [s.value,(next:any)=>{assert.equal(disposed,false);s.value=typeof next==='function'?next(s.value):next;}];};
 const useRef=(initial:any)=>slot({current:initial}).value,useEffect=(fn:()=>void|(()=>void),deps?:readonly unknown[])=>{const s=slot(null);if(!s.deps||!deps||deps.some((v,i)=>!Object.is(v,s.deps[i]))){s.deps=deps;effects.push(()=>{s.cleanup?.();s.cleanup=fn();});}};
 const fn=compile(component.getText(tree).replace(/^export\s+/u,''),{React,X:()=>null,NativeEmailRecipientSuggestions:()=>null,parse,parseNativeMailboxList,formatNativeMailboxList,nativeRecipientKey,selectNativeRecipient,nativeRecipientAssistanceStatus,useId:()=> 'keyboard',useState,useRef,useEffect,api:{getAccessToken:()=> 'token',fetch:()=>{throw Error('unexpected fetch');}},isSameWebSession:()=>true,getActiveSessionCacheScope:()=>currentSession,createNativeRecipientQuery:()=>({dispose(){},clear(){},query:async()=>{}}),setTimeout:()=>1,clearTimeout:()=>{}});
 const find=(node:any,predicate:(node:any)=>boolean):any=>{if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const got=find(child,predicate);if(got)return got;}return null;};
 const render=()=>{index=0;const out=fn({label:'To',value,accountId:'a',sessionScope,disabled,onChange:(next:string)=>{value=next;writes.push(next);}});const assign=(node:any)=>{if(!node||typeof node!=='object')return;const ref=node.props?.ref;if(ref){const target={focus:()=>focus.push(node.type==='input'?'input':node.props['aria-label'])};if(typeof ref==='function')ref(target);else ref.current=target;}for(const child of React.Children.toArray(node.props?.children))assign(child);};assign(out);while(effects.length)effects.shift()!();return out;};
 const input=(out:any)=>find(out,n=>n.type==='input'),chip=(out:any,address:string)=>find(out,n=>n.props?.['aria-label']===`Remove ${address} from To`);
 const key=(node:any,name:string,extra:Record<string,unknown>={})=>{let prevented=0;node.props.onKeyDown?.({key:name,nativeEvent:{isComposing:false},preventDefault:()=>{prevented++;},...extra});return prevented;};
 return {render,input,chip,key,focus,writes,get value(){return value;},disable:()=>{disabled=true;},replaceScope:()=>{sessionScope='sid2';currentSession='sid2';},dispose:()=>{for(const s of slots)s.cleanup?.();disposed=true;},suggestions:()=>{slots[2].value={account_id:'a',query:'',items:[{address:'suggest@example.test',name:'Suggestion',provenance:['contacts']}],has_more:false,sources:{contacts:'available',recent:'available'}};slots[3].value=true;}};
}

test('actual recipient keyboard focuses existing chips before any edit and navigates back to input',()=>{
 for(const entry of ['Backspace','ArrowLeft']){const f=keyboardMount();let out=f.render();assert.equal(f.key(f.input(out),entry),1);assert.deepEqual(f.focus,['Remove second@example.test from To']);assert.equal(f.writes.length,0);
 assert.equal(f.key(f.chip(out,'second@example.test'),'ArrowLeft'),1);assert.equal(f.focus.at(-1),'Remove first@example.test from To');assert.equal(f.key(f.chip(out,'first@example.test'),'ArrowRight'),1);assert.equal(f.focus.at(-1),'Remove second@example.test from To');assert.equal(f.key(f.chip(out,'second@example.test'),'ArrowRight'),1);assert.equal(f.focus.at(-1),'input');assert.equal(f.key(f.chip(out,'first@example.test'),'Escape'),1);assert.equal(f.focus.at(-1),'input');assert.equal(f.writes.length,0);f.dispose();}
});
test('actual chip Backspace/Delete removes exactly one recipient and moves focus to nearest retained chip or input',()=>{
 for(const name of ['Backspace','Delete']){const f=keyboardMount();let out=f.render();f.key(f.input(out),'Backspace');assert.equal(f.key(f.chip(out,'second@example.test'),name),1);out=f.render();assert.deepEqual(parseNativeMailboxList(f.value),[{address:'first@example.test',displayName:'First'}]);assert.equal(f.focus.at(-1),'Remove first@example.test from To');assert.equal(f.writes.length,1);f.key(f.chip(out,'first@example.test'),name);out=f.render();assert.equal(f.value,'');assert.equal(f.focus.at(-1),'input');assert.equal(f.writes.length,2);f.dispose();}
});
test('native keyboard chip entry leaves text/caret, modifiers, IME, suggestions and disabled state untouched',()=>{
 for(const value of ['unfinished@',' ',''])for(const extra of [{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true},{nativeEvent:{isComposing:true}}]){const f=keyboardMount(value||undefined);const out=f.render();assert.equal(f.key(f.input(out),'Backspace',extra),0);assert.equal(f.focus.length,0);assert.equal(f.writes.length,0);f.dispose();}
 for(const value of ['unfinished@',' ']){const f=keyboardMount(value),out=f.render();assert.equal(f.key(f.input(out),'ArrowLeft'),0);assert.equal(f.value,value);assert.equal(f.focus.length,0);f.dispose();}
 const disabled=keyboardMount();disabled.disable();let out=disabled.render();assert.equal(disabled.input(out).props.disabled,true);assert.equal(disabled.key(disabled.input(out),'Backspace'),0);assert.equal(disabled.key(disabled.chip(out,'second@example.test'),'Delete'),0);assert.equal(disabled.writes.length,0);disabled.dispose();
 const suggest=keyboardMount();out=suggest.render();suggest.suggestions();out=suggest.render();assert.equal(suggest.key(suggest.input(out),'ArrowDown'),1);assert.equal(suggest.focus.length,0);assert.equal(suggest.key(suggest.input(out),'Enter'),1);assert.match(suggest.value,/suggest@example.test/);suggest.dispose();
});
test('held native keyboard and Remove handlers cannot edit or focus after session replacement or disposal',()=>{
 for(const action of ['replace','dispose']){const f=keyboardMount(),out=f.render(),input=f.input(out),last=f.chip(out,'second@example.test');if(action==='replace'){f.replaceScope();f.render();}else f.dispose();assert.equal(f.key(input,'Backspace'),0);assert.equal(f.key(last,'Delete'),0);last.props.onClick();assert.equal(f.writes.length,0);assert.equal(f.focus.length,0);if(action==='replace')f.dispose();}
});
test('named Remove preserves pending text and keyboard chip controls do not intercept activation or modifier keys',()=>{
 const f=keyboardMount();let out=f.render(),last=f.chip(out,'second@example.test');for(const name of ['Enter',' '])assert.equal(f.key(last,name),0);for(const extra of [{ctrlKey:true},{altKey:true},{metaKey:true},{shiftKey:true},{nativeEvent:{isComposing:true}}])assert.equal(f.key(last,'Delete',extra),0);assert.equal(f.writes.length,0);assert.match(renderToStaticMarkup(out),/Backspace or Delete removes a focused recipient/);f.input(out).props.onChange({target:{value:'unfinished@'}});out=f.render();last=f.chip(out,'second@example.test');last.props.onClick();out=f.render();assert.equal(f.value,'First <first@example.test>, unfinished@');assert.equal(f.input(out).props.value,'unfinished@');assert.equal(f.focus.at(-1),'Remove first@example.test from To');f.dispose();
});
test('empty-input chip entry works with visible suggestions while held controls obey the latest disabled gate',()=>{
 const f=keyboardMount();let out=f.render(),oldInput=f.input(out),oldChip=f.chip(out,'second@example.test');f.suggestions();out=f.render();assert.equal(f.key(f.input(out),'ArrowLeft'),1);assert.equal(f.focus.at(-1),'Remove second@example.test from To');assert.equal(f.writes.length,0);f.focus.length=0;f.disable();f.render();assert.equal(f.key(oldInput,'Backspace'),0);assert.equal(f.key(oldChip,'Delete'),0);oldChip.props.onClick();assert.equal(f.writes.length,0);assert.equal(f.focus.length,0);f.dispose();
});
test('keyboard removes the exact last of200 recipients while over-limit201 remains untouched correction text',()=>{
 const rows=(count:number)=>Array.from({length:count},(_,i)=>`Person ${i} <r${i}@example.test>`).join(', '),f=keyboardMount(rows(200));let out=f.render();f.key(f.input(out),'Backspace');assert.equal(f.focus.at(-1),'Remove r199@example.test from To');f.key(f.chip(out,'r199@example.test'),'Delete');out=f.render();assert.equal(parseNativeMailboxList(f.value).length,199);assert.equal(f.focus.at(-1),'Remove r198@example.test from To');assert.equal(f.writes.length,1);f.dispose();const invalid=keyboardMount(rows(201)),correction=invalid.render();assert.equal(invalid.key(invalid.input(correction),'Backspace'),0);assert.equal(invalid.input(correction).props.value,rows(201));assert.equal(invalid.writes.length,0);invalid.dispose();
});
