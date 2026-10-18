import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const ts=createRequire(import.meta.url)('typescript');
const source=ts.createSourceFile('apply-extras.ts',readFileSync(new URL('./apply-extras.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
let block;
function visit(node){if(ts.isIfStatement(node)&&node.thenStatement.getText(source).includes('nativeMentionsFile'))block=node;ts.forEachChild(node,visit);}
visit(source);assert.ok(block);
const script=ts.transpileModule('(async function(client,ledgerExists){'+block.getText(source)+'})',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(present=false,{fresh=true}={}){
 const calls=[];
 const bootstrap=runInNewContext(script,{process:{argv:fresh?['--fresh-init']:[]},readFileSync:(path)=>{assert.equal(path,'upgrades/0.3.0-preview.61-native-mentions.sql');return 'original reviewed SQL';},resolve:(...parts)=>parts.join('/'),upgradesDir:'upgrades',console:{log:()=>{}}});
 return {bootstrap,calls,client:{query:async sql=>{calls.push(sql);return {rows:[{present}]};}}};
}
test('fresh native bootstrap cannot rewrite a retained ledgered database',async()=>{
 const f=fixture();await f.bootstrap(f.client,true);assert.equal(f.calls.length,0);
});
test('standalone apply-extras cannot enter the fresh initializer bootstrap',async()=>{
 const f=fixture(false,{fresh:false});await f.bootstrap(f.client,false);assert.equal(f.calls.length,0);
});
test('fresh bootstrap rejects populated or unavailable native tables before SQL',async()=>{
 for(const present of [true,null]){const f=fixture(present);await assert.rejects(f.bootstrap(f.client,false),/E5_FRESH_NATIVE_TABLE_NOT_EMPTY/);assert.equal(f.calls.length,1);}
});
test('only empty fresh tables receive the original native contract SQL',async()=>{
 const f=fixture();await f.bootstrap(f.client,false);assert.equal(f.calls.length,2);assert.match(f.calls[0],/EXISTS.*native_reference_states/s);assert.match(f.calls[0],/EXISTS.*native_mention_deliveries/s);assert.equal(f.calls[1],'original reviewed SQL');
});
