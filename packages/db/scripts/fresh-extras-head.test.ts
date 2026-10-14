import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {resolve} from 'node:path';import ts from 'typescript';import {upgradeManifest} from '../upgrades/manifest';
test('fresh extras preserves the reviewed117 bootstrap before normal forward convergence',async()=>{const path=new URL('./apply-extras.ts',import.meta.url),source=ts.createSourceFile('extras.ts',readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);let loop:ts.ForOfStatement|undefined;
 const visit=(node:ts.Node)=>{if(ts.isForOfStatement(node)&&node.initializer.getText(source)==='const platformFile')loop=node;ts.forEachChild(node,visit);};visit(source);assert.ok(loop);
 const code=ts.transpileModule(loop.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,files:string[]=[];
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;await new AsyncFunction('client','readFileSync','resolve','upgradesDir','console',code)({query:async()=>({rows:[]})},(path:string)=>{files.push(path);return '';},resolve,'/upgrades',{log:()=>{}});
 const names=files.map(path=>path.split(/[\\/]/u).at(-1)!);
 const end=upgradeManifest.migrations.findIndex(row=>row.version==='0.3.0-preview.117');
 const required=upgradeManifest.migrations.slice(end-1,end+1).map(row=>row.file);assert.deepEqual(names.slice(-2),required);assert.equal(names.filter(name=>name===required[1]).length,1);
 assert.ok(!names.includes(upgradeManifest.migrations.at(-1)!.file),'forward118 must not change the immutable fresh117 catalog before it is attested');
});

test('extras restores118 only for an existing ledger that records it',async()=>{
 const source=ts.createSourceFile('extras.ts',readFileSync(new URL('./apply-extras.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
 const statements=source.statements.flatMap(function walk(node:ts.Node):ts.Node[]{
  if(ts.isVariableStatement(node)&&node.getText(source).includes('const supplementalEffectsRecorded'))return[node];
  if(ts.isIfStatement(node)&&node.expression.getText(source)==='supplementalEffectsRecorded')return[node];
  return node.getChildren(source).flatMap(walk);
 });assert.equal(statements.length,2);
 const code=ts.transpileModule(statements.map(node=>node.getText(source)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 for(const [ledgerExists,recorded,expected]of [[false,false,0],[true,false,0],[true,true,1]] as const){
  const files:string[]=[],queries:string[]=[];
  await new AsyncFunction('client','readFileSync','resolve','upgradesDir','console','ledgerExists',code)({query:async(sql:string)=>{queries.push(sql);return{rows:[{installed:recorded}]};}},(path:string)=>{files.push(path);return'forward guard SQL';},resolve,'/upgrades',{log:()=>{}},ledgerExists);
  assert.equal(files.length,expected);assert.equal(queries.length,(ledgerExists?1:0)+expected);
  if(expected)assert.ok(files[0]!.endsWith('0.3.0-preview.118-app-supplemental-effects.sql'));
 }
});
