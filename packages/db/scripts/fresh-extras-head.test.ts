import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {resolve} from 'node:path';import ts from 'typescript';import {upgradeManifest} from '../upgrades/manifest';
test('actual fresh extras executes current head after its preceding released helper migration',async()=>{const path=new URL('./apply-extras.ts',import.meta.url),source=ts.createSourceFile('extras.ts',readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);let loop:ts.ForOfStatement|undefined;
 const visit=(node:ts.Node)=>{if(ts.isForOfStatement(node)&&node.initializer.getText(source)==='const platformFile')loop=node;ts.forEachChild(node,visit);};visit(source);assert.ok(loop);
 const code=ts.transpileModule(loop.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,files:string[]=[];
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;await new AsyncFunction('client','readFileSync','resolve','upgradesDir','console',code)({query:async()=>({rows:[]})},(path:string)=>{files.push(path);return '';},resolve,'/upgrades',{log:()=>{}});
 const names=files.map(path=>path.split(/[\\/]/u).at(-1)!);assert.ok(names.includes(upgradeManifest.migrations.at(-1)!.file),'current schema head must be applied before fresh catalog stamping');
 const required=upgradeManifest.migrations.slice(-2).map(row=>row.file);assert.deepEqual(names.slice(-2),required,'current head must execute after the preceding released helper');assert.equal(names.filter(name=>name===required[1]).length,1);
});
