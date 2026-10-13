import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {NativeDraftSummary} from '../../lib/email-native-draft-summaries';

const sourcePath=new URL('./native-email-drafts.tsx',import.meta.url),require=createRequire(sourcePath);
const source=readFileSync(process.env.EMAIL_DRAFT_LIST_BASELINE??sourcePath,'utf8');
const summary=(id:string,status:'draft'|'submitted',account='first'):NativeDraftSummary=>({draft_id:id,account_id:account,revision:status==='draft'?1:2,content_revision:1,status,subject:id,updated_at:'2026-10-08T00:00:00.000Z'});
const editable=summary('11111111-1111-4111-8111-111111111111','draft'),submitted=summary('22222222-2222-4222-8222-222222222222','submitted','second');
type Node=React.ReactElement<Record<string,any>>;
/** Execute the actual host function with a loaded snapshot. Effects/clients are
 * held; only hooks are injected, not a copy of the rendering implementation. */
function host(items:NativeDraftSummary[],options:{loading?:boolean;notice?:string;pages?:Record<string,unknown>}={}){
 let hook=0;const values=[items.map(draft=>({accountId:draft.account_id,draft})),options.pages??{},options.loading??false,options.notice??'',0,''];
 const opened:unknown[]=[],module={exports:{} as Record<string,any>};
 const react={...React,useState:(initial:unknown)=>[hook<values.length?values[hook++]:initial,()=>{}],useRef:(value:unknown)=>({current:value}),useEffect:()=>{}};
 const load=(id:string)=>id==='react'?react:id==='lucide-react'?Object.fromEntries(['Archive','ChevronDown','RefreshCw'].map(name=>[name,()=>React.createElement('svg')])):id==='@/lib/api'?{}:id==='@/lib/email-native-drafts'?{}:id==='@/lib/email-native-draft-summaries'?{}:id==='./native-email-browser-drafts'?{NativeEmailBrowserDrafts:()=>null}:require(id);
 runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:load,Map,Set,JSON});
 const tree=module.exports.NativeEmailDrafts({accounts:[{account_id:'first',primary_address:'first@example.test'},{account_id:'second',primary_address:'second@example.test'}],sessionScope:'sid',revision:1,onOpen:(selection:unknown)=>opened.push(selection)});
 const nodes:Node[]=[];const walk=(value:any)=>{if(Array.isArray(value)){value.forEach(walk);return;}if(React.isValidElement(value)){const node=value as Node;nodes.push(node);walk(node.props.children);}};walk(tree);
 return {tree,nodes,opened,html:renderToStaticMarkup(tree),text:(node:Node)=>renderToStaticMarkup(node)};
}

test('actual Drafts host keeps unsent rows primary and submitted records in a collapsed keyboard disclosure',()=>{
 const rendered=host([submitted,editable]);const details=rendered.nodes.find(node=>node.type==='details');assert.ok(details,'submitted records need a distinct disclosure');assert.ok(!details.props.open,'history starts collapsed');
 const title=rendered.nodes.find(node=>node.type==='summary');assert.ok(title);assert.match(rendered.text(title),/Submitted messages \(1 loaded\)/);assert.equal(title.props.tabIndex,undefined,'native summary retains keyboard semantics');
 assert.ok(rendered.html.indexOf(editable.subject)<rendered.html.indexOf('Submitted messages'),'editable drafts precede submitted history');
 assert.match(rendered.text(details),new RegExp(submitted.subject));assert.doesNotMatch(rendered.text(details),new RegExp(editable.subject));
 const buttons=rendered.nodes.filter(node=>node.type==='button');for(const row of [editable,submitted]){const button=buttons.find(node=>rendered.text(node).includes(row.subject)&&!node.props['aria-label']);assert.ok(button);button.props.onClick();}
 assert.deepEqual(JSON.parse(JSON.stringify(rendered.opened)),[{accountId:'first',draftId:editable.draft_id},{accountId:'second',draftId:submitted.draft_id}]);
 assert.equal(buttons.filter(node=>String(node.props['aria-label']).startsWith('Archive draft')).length,1,'submitted rows cannot be archived here');
});

test('submitted-only loaded page remains reachable without claiming there are no recoverable drafts',()=>{
 const rendered=host([submitted],{pages:{second:{cursor:'sealed-next',hasMore:true,loading:false}}});assert.match(rendered.html,/No unsent drafts loaded in this view/);assert.doesNotMatch(rendered.html,/No drafts saved/);
 assert.match(rendered.html,/Submitted messages \(1 loaded\)/);assert.match(rendered.html,/Load more/);assert.match(rendered.html,/second@example.test/);
 const browser=rendered.nodes.find(node=>typeof node.type==='function'&&node.props.refreshKey!==undefined);assert.ok(browser);assert.equal(browser.props.refreshKey,'1/0','browser recovery stays mounted under existing refresh ownership');
});

test('loaded counts, empty, loading, partial failure and cross-account cursors retain their honest boundaries',()=>{
 const extra=summary('33333333-3333-4333-8333-333333333333','submitted');const rendered=host([submitted,extra,editable],{notice:'Some drafts could not be loaded.',pages:{first:{cursor:'one',hasMore:true,loading:false},second:{cursor:'two',hasMore:true,loading:true}}});
 assert.match(rendered.html,/Submitted messages \(2 loaded\)/);assert.match(rendered.html,/Some drafts could not be loaded/);assert.match(rendered.html,/Loading…/);assert.match(rendered.html,/Load more/);
 const empty=host([]);assert.match(empty.html,/No unsent drafts loaded/);assert.equal(empty.nodes.some(node=>node.type==='details'),false);
 const loading=host([submitted],{loading:true});assert.match(loading.html,/Loading drafts/);assert.equal(loading.nodes.some(node=>node.type==='details'),false);
 const drafts=host([editable]);assert.equal(drafts.nodes.some(node=>node.type==='details'),false);assert.match(drafts.html,new RegExp(editable.subject));
});
