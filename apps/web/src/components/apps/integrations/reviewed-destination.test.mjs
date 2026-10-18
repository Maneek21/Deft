import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const ts=createRequire(import.meta.url)('typescript');
const source=ts.createSourceFile('review.tsx',readFileSync(new URL('./reviewed-destination.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const fn=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='ReviewedDestination');
const code=ts.transpileModule('('+fn.getText(source).replace(/^export /u,'')+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
function fixture(replies){
 const state=[],requests=[];let cursor=0,previous,cleanup,alive=true;
 const input={destination:{kind:'task',project_id:'project'},title:'Received handoff',mode:'source_link',task_details:{description:'Preserved details',due_date:'2026-10-21'}};
 const props={input,current:()=>alive,journal:{read:()=>undefined,save:()=>assert.fail('No commit before explicit Create'),clear(){}},onClose(){}};
 const Component=runInNewContext(code,{React:{createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})},useState:initial=>{const i=cursor++;if(!(i in state))state[i]=initial;return [state[i],next=>{state[i]=typeof next==='function'?next(state[i]):next;}];},useRef:initial=>({current:initial}),useEffect:(effect,deps)=>{if(!previous||deps.some((v,i)=>v!==previous[i])){cleanup?.();previous=deps;cleanup=effect();}},AbortController,Date,crypto:{randomUUID:()=>assert.fail('No mutation on retry')},AppIntegrationDestinationReviewInputSchema:{parse:v=>v},boundedConfirmationJson:async r=>{if(!r.ok)throw Error('denied');return r.value;},boundedConfirmationErrorCode:async r=>r.value.code,api:{fetch:async(path,options)=>{requests.push({path,options});return replies[requests.length-1];}}});
 return {input,requests,revoke:()=>{alive=false;},render(){cursor=0;const all=[],visit=n=>{if(!n||typeof n!=='object')return;all.push(n);n.props.children.forEach(visit);};visit(Component(props));return all;}};
}
const ready={ok:true,status:200,value:{schema_version:'deft.app_integration_destination_review.v1',review_digest:'sha256:'+'a'.repeat(64),audience:{label:'Project members',member_count:5},observed_at:'2026-10-18T12:27:00Z',partial:true,expires_at:'2099-10-18T12:28:00Z'}};
test('publication lag can retry only audience review while keeping exact task details and due date',async()=>{
 const f=fixture([{ok:false,status:409,value:{code:'APP_INTEGRATION_SOURCE_PENDING'}},ready]);f.render();await new Promise(setImmediate);let nodes=f.render();
 assert.ok(nodes.some(n=>n.props.role==='status'&&n.props.children.join('').includes('still syncing')));assert.equal(nodes.find(n=>n.type==='button'&&n.props.children.join('')==='Create task').props.disabled,true);
 nodes.find(n=>n.type==='button'&&n.props.children.join('')==='Check source availability').props.onClick();f.render();await new Promise(setImmediate);nodes=f.render();
 assert.equal(f.requests.length,2);assert.deepEqual(f.requests.map(r=>r.path),['/api/app-integrations/destinations/review','/api/app-integrations/destinations/review']);
 assert.equal(f.requests[0].options.body,f.requests[1].options.body);assert.equal(JSON.parse(f.requests[1].options.body).task_details.due_date,'2026-10-21');assert.equal(f.input.task_details.description,'Preserved details');
 assert.equal(nodes.find(n=>n.type==='button'&&n.props.children.join('')==='Create task').props.disabled,false);
});
test('a real access denial never exposes pending retry or enables task creation',async()=>{
 const f=fixture([{ok:false,status:403,value:{code:'APP_INTEGRATION_DESTINATION_CHANGED_OR_DENIED'}}]);f.render();await new Promise(setImmediate);const nodes=f.render();
 assert.ok(!nodes.some(n=>n.type==='button'&&n.props.children.join('')==='Check source availability'));assert.equal(nodes.find(n=>n.type==='button'&&n.props.children.join('')==='Create task').props.disabled,true);
});
