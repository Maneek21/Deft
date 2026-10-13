import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NativeEmailRules} from './native-email-rules';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

test('rules panel is account-scoped and clearly requires explicit reviewed runs',()=>{
 const markup=renderToStaticMarkup(createElement(NativeEmailRules,{accountId:'private-account',sessionScope:'owner:org:sid'}));
 assert.match(markup,/Local email rules/);assert.match(markup,/automatic processing is not active/);assert.match(markup,/New rule/);
 assert.doesNotMatch(markup,/private-account|owner:org:sid|Run reviewed actions|provider locator|Enable automatic/);
});

test('actual editor save preserves unchecked enable choice in one create call',async()=>{
 const source=ts.createSourceFile('rules.tsx',readFileSync(new URL('./native-email-rules.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let save:ts.Expression|undefined;const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='save')save=node.initializer;ts.forEachChild(node,visit);};visit(source);assert.ok(save);
 const js=ts.transpileModule('('+save.getText(source)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const calls:unknown[][]=[];const published:unknown[]=[];
 const run=runInNewContext(js,{client:{current:{create:async(...args:unknown[])=>{calls.push(args);return{state:args[3]};}}},current:()=>true,editing:{id:'synthetic-rule',revision:null,state:'paused'},content:{name:'Synthetic'},accountId:'account',busy:false,lock:{current:false},setBusy:()=>{},setNotice:()=>{},publish:(row:unknown)=>published.push(row)}) as ()=>Promise<void>;
 await run();assert.equal(calls.length,1);assert.equal(calls[0]?.[3],'paused');assert.deepEqual(published,[{state:'paused'}]);
});
