import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
const text=readFileSync(new URL('./runtime-app-setup.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('setup.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const targetWorkspace=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='TargetWorkspace');
const code=ts.transpileModule(targetWorkspace.getText(tree)+';globalThis.render=TargetWorkspace;',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
test('normal owner target selection remounts review workspace and sequences catalog before context',()=>{
 const one={resource_binding_id:'one',target_key:'first',resource_key:'inbox'},two={resource_binding_id:'two',target_key:'fresh_mailbox',resource_key:'inbox'};
 const values=[[one,two],one,false,null,0];let index=0;const Workspace=()=>null;
 const ctx={globalThis:{},Workspace,useState:initial=>{const i=index++;return [values[i]??initial,value=>{values[i]=typeof value==='function'?value(values[i]):value;}];},useEffect:()=>{},React:{Fragment:'fragment',createElement:(type,props,...children)=>({type,props:{...props,children}})}};vm.runInNewContext(code,ctx);
 const flatten=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children??[]).flat(Infinity).flatMap(flatten)];
 const render=()=>{index=0;return flatten(ctx.globalThis.render({app:{id:'app',version_id:'version'},operatorId:'owner'}));};
 let nodes=render();assert.equal(nodes.find(n=>n.type===Workspace).props.key,'one');
 nodes.find(n=>n.type==='select').props.onChange({target:{value:'two'}});nodes=render();const selected=nodes.find(n=>n.type===Workspace);assert.equal(selected.props.key,'two');assert.equal(selected.props.target.target_key,'fresh_mailbox');
 values[2]=true;nodes=render();assert.equal(nodes.some(n=>n.type===Workspace),false);
 values[2]=false;values[3]='Account targets unavailable';nodes=render();assert.equal(nodes.some(n=>n.type===Workspace),false);assert.ok(nodes.some(n=>n.props?.role==='alert'));
});
