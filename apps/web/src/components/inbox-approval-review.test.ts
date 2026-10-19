import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {stripHtml} from '../lib/strip-html';
const cardText=readFileSync(new URL('./agent-action-card.tsx',import.meta.url),'utf8');
const card=ts.createSourceFile('card.tsx',cardText,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const functions=['getStringParam','getSubtaskDraftText','getDraftDetailText'].map(name=>card.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name)!.getText(card)).join('\n');
const details=vm.runInNewContext(ts.transpileModule(functions+';getDraftDetailText',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{getTaskReviewAssignment:()=>[],stripHtml});
test('canonical task_update nested comment is visible with exact target and literal text',()=>{
 const comment='Approved handoff <script>alert(1)</script> & follow-up';
 const actual=details('task_update',{task_id:'2830d2be-e981-4b79-8241-42d5f07a3fb9',patch:{comment},summary:'Separate rationale'});
 assert.match(actual,/Task: 2830d2be-e981-4b79-8241-42d5f07a3fb9/);assert.ok(actual.includes(comment));
});
test('Inbox projection carries canonical proposer and source to shared card',()=>{
 const source=readFileSync(new URL('../app/(app)/inbox/page.tsx',import.meta.url),'utf8');
 const tree=ts.createSourceFile('inbox.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let expression:ts.Expression|undefined;
 function visit(node:ts.Node){if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='action'&&node.type?.getText(tree)==='AgentAction')expression=node.initializer;ts.forEachChild(node,visit);}visit(tree);assert.ok(expression);
 const item={created_at:'now',approval:{id:'a',action:'task_update',params:{},proposer:'employee',source:'mcp',has_receipt:true,employee_name:'Hermes'}};
 const result=vm.runInNewContext('('+expression!.getText(tree)+')',{item});assert.equal(result.proposer,'employee');assert.equal(result.source,'mcp');assert.equal(result.has_receipt,true);
});
test('attention API selects canonical action attribution',()=>{
 const source=readFileSync(new URL('../../../api/src/routes/attention.ts',import.meta.url),'utf8');assert.match(source,/proposer:attentionActionProposer\(action\)/);assert.match(source,/source:\s*agentActions\.source/);assert.match(source,/has_receipt: sql<boolean>`EXISTS \(SELECT 1 FROM action_receipts/);
 const tree=ts.createSourceFile('attention.ts',source,ts.ScriptTarget.Latest,true),fn=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='attentionActionProposer')!;
 const js=ts.transpileModule(fn.getText(tree).replace('export ',''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const proposer=vm.runInNewContext(js+';attentionActionProposer',{hasHumanMcpBulkProvenance:(row:any)=>row.human===true});
 assert.equal(proposer({source:'mcp',agent_employee_id:'hermes'}),'employee');assert.equal(proposer({source:'mcp',agent_employee_id:null,human:true}),'user');assert.equal(proposer({source:'defty_capture',agent_employee_id:null}),'defty');
});

test('pending module record update exposes exact proposed fields without orchestration secrets',()=>{
 const patch={role:'Reviewed <lead> & operator'};
 const actual=details('module_record_update',{record_id:'record-1',expected_revision:4,patch,relations:{owner:['member-2']},unset_fields:['old_note'],idempotency_key:'hidden-idempotency',expected_manifest_digest:'hidden-manifest'});
 for(const text of ['Record: record-1','Expected revision: 4','role','Reviewed <lead> & operator','owner','member-2','old_note'])assert.ok(actual.includes(text));
 assert.ok(!actual.includes('hidden-idempotency'));assert.ok(!actual.includes('hidden-manifest'));
});

test('native wiki_update displays the full nested body, target and honest version availability',()=>{
 const content='Original <literal> body.\n\n'+'A'.repeat(6000)+'\nTAIL REVIEW SENTENCE';
 const actual=details('wiki_update',{page_id:'page-1',patch:{content},summary:'A short rationale'});
 assert.ok(actual.includes(content));assert.match(actual,/TAIL REVIEW SENTENCE$/);assert.match(actual,/Page: page-1/);assert.match(actual,/Expected version: not included in proposal/);
 assert.match(details('wiki_update',{page_id:'page-1',patch:{content},expected_version:2}),/Expected version: 2/);
});

test('receipt CTA requires actual canonical receipt even for completed or rejected actions',()=>{
 let expression:ts.Expression|undefined;function visit(node:ts.Node){if(ts.isVariableDeclaration(node)&&node.name.getText(card)==='hasReceipt')expression=node.initializer;ts.forEachChild(node,visit);}visit(card);assert.ok(expression);
 for(const resolvedStatus of ['approved','rejected'])for(const has_receipt of [false,undefined,true])assert.equal(vm.runInNewContext(expression!.getText(card),{action:{has_receipt},resolvedStatus}),has_receipt===true);
});
