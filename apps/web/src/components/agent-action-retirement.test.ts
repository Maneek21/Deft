import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=ts.createSourceFile('card.tsx',readFileSync(new URL('./agent-action-card.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='AgentActionCard') as ts.FunctionDeclaration;
const statements=component.body!.statements;
const classification=statements.find(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>declaration.name.getText(source)==='retiredEmailAction'))!;
const approve=statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='handleApprove')!;
const code=ts.transpileModule(`(async()=>{${classification.getText(source)};${approve.getText(source)};await handleApprove();})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
test('actual approval handler denies retired native/sandbox Email but retains current generic runtime review gate',async()=>{
 for(const [action,reviewed,expected] of [
  [{action:'email_send',params:{}},true,0],
  [{action:'app_run_invoke',params:{capability_label:'send_email',safe_preview:{fields:{provider_kind:'sandbox'}}}},true,0],
  [{action:'app_run_invoke',params:{capability_label:'send_email',safe_preview:{fields:{}}}},true,0],
  [{action:'app_run_invoke',params:{capability_label:'send_email',safe_preview:{fields:{provider_kind:'app_runtime'}}}},false,0],
  [{action:'app_run_invoke',params:{capability_label:'send_email',safe_preview:{fields:{provider_kind:'app_runtime'}}}},true,1],
  [{action:'app_run_invoke',params:{capability_label:'deliver_record',safe_preview:{fields:{provider_kind:'app_runtime'}}}},true,1],
 ] as const){let calls=0;await vm.runInNewContext(code,{action,isBusy:false,needsTaskLinkReview:false,needsRuntimeReview:true,runtimeReviewReady:reviewed,needsNativeReview:false,onApprove:async()=>{calls++;return{status:'approved'};},setLocalStatus(){},setLocalError(){},setLocalResult(){},normalizeReturnedStatus:(_:unknown,status:string)=>status,Date,Error})();assert.equal(calls,expected);}
});
