import assert from 'node:assert/strict';import test from 'node:test';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';import ts from 'typescript';import * as React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
function render(omitted:number){const source=readFileSync(process.env.LEGACY_SOURCE_FILES_SOURCE??new URL('./experience-source-files.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('source.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),component=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='ExperienceSourceFiles')!;let index=0;
 const values=[[],false,'',null,omitted];const fn=runInNewContext(ts.transpileModule('('+component.getText(tree).replace(/^export /u,'')+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None,jsx:ts.JsxEmit.React}}).outputText,{React,useState:()=>[values[index++],()=>{}],useRef:(initial:unknown)=>({current:initial}),useEffect:()=>{}});
 return renderToStaticMarkup(fn({sessionId:'session',resourceKey:'inbox',recordId:'record',exposure:{exposure_id:'scope',exposure_epoch:2},ensureAuthority:async()=>true}));}
test('actual legacy attachment panel discloses omitted files and original-source action without claiming no attachments',()=>{
 const html=render(3);assert.match(html,/3 additional files are not listed/);assert.match(html,/>Download original<\/button>/);assert.doesNotMatch(html,/No attachments are present/);
 assert.match(render(0),/No attachments are present/);
});
