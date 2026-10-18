import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const ts=createRequire(import.meta.url)('typescript');
const source=ts.createSourceFile('review.tsx',readFileSync(new URL('./reviewed-destination.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const fn=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='ReviewedDestination');
const code=ts.transpileModule('('+fn.getText(source).replace(/^export /u,'')+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
function fixture(replies,{journal={read:()=>undefined,save:()=>assert.fail('No commit before explicit Create'),clear(){}},uuid=()=>assert.fail('No mutation on retry')}={}){
 const state=[],refs=[],requests=[];let cursor=0,refCursor=0,previous,cleanup,alive=true;
 const input={destination:{kind:'task',project_id:'project'},title:'Received handoff',mode:'source_link',task_details:{description:'Preserved details',due_date:'2026-10-21'}};
 const props={input,current:()=>alive,journal,onClose(){}};
 const Component=runInNewContext(code,{React:{createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})},useState:initial=>{const i=cursor++;if(!(i in state))state[i]=initial;return [state[i],next=>{state[i]=typeof next==='function'?next(state[i]):next;}];},useRef:initial=>{const i=refCursor++;if(!(i in refs))refs[i]={current:initial};return refs[i];},useEffect:(effect,deps)=>{if(!previous||deps.some((v,i)=>v!==previous[i])){cleanup?.();previous=deps;cleanup=effect();}},AbortController,Date,crypto:{randomUUID:uuid},AppIntegrationDestinationReviewInputSchema:{parse:v=>v},boundedConfirmationJson:async r=>{if(!r.ok)throw Error('denied');return r.value;},boundedConfirmationErrorCode:async r=>r.value.code,api:{fetch:async(path,options)=>{requests.push({path,options});const reply=replies[requests.length-1];return typeof reply==='function'?reply(path,options):reply;}}});
 return {input,requests,revoke:()=>{alive=false;},render(){cursor=0;refCursor=0;const all=[],visit=n=>{if(!n||typeof n!=='object')return;all.push(n);n.props.children.forEach(visit);};visit(Component(props));return all;}};
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

for(const [name,failure]of [['publication pending',{ok:false,status:409,value:{code:'APP_INTEGRATION_SOURCE_PENDING'}}],['revoked or expired source',{ok:false,status:403,value:{code:'APP_INTEGRATION_DESTINATION_CHANGED_OR_DENIED'}}],['unavailable source',{ok:false,status:503,value:{code:'SERVICE_UNAVAILABLE'}}]])test('lost commit response can recover its original request after remount with '+name,async()=>{
 let saved,cleared=0,writes=0;const requestId='00000000-0000-4000-8000-000000000099',journal={read:()=>saved,save:id=>{assert.equal(saved,undefined);saved=id;},clear:()=>{cleared++;saved=undefined;}};
 const first=fixture([ready,()=>{writes++;throw Error('Synthetic response loss after one successful task commit');}],{journal,uuid:()=>requestId});
 first.render();await new Promise(setImmediate);first.render().find(n=>n.type==='button'&&n.props.children.join('')==='Create task').props.onClick();await new Promise(setImmediate);
 assert.equal(writes,1);assert.equal(saved,requestId);assert.equal(first.requests.filter(r=>r.path.endsWith('/commit')).length,1);
 const recovered={ok:true,status:200,value:{destination_url:'/tasks?task=created-once',destination_id:'created-once',replayed:true}};
 const remounted=fixture([failure,failure,recovered],{journal});remounted.render();await new Promise(setImmediate);let nodes=remounted.render();
 let check=nodes.find(n=>n.type==='button'&&n.props.children.join('')==='Check original request');assert.ok(check);assert.equal(check.props.disabled,false,'original status lookup does not require a fresh source review');
 check.props.onClick();await new Promise(setImmediate);nodes=remounted.render();assert.equal(nodes.some(n=>n.type==='a'),false,'status denial must not disclose a result');assert.equal(saved,requestId);assert.equal(cleared,0);
 check=nodes.find(n=>n.type==='button'&&n.props.children.join('')==='Check original request');assert.equal(check.props.disabled,false);check.props.onClick();await new Promise(setImmediate);nodes=remounted.render();
 assert.ok(nodes.some(n=>n.type==='a'&&n.props.href==='/tasks?task=created-once'));assert.equal(saved,requestId);assert.equal(cleared,0);assert.equal(writes,1);
 assert.deepEqual(remounted.requests.map(r=>r.path),['/api/app-integrations/destinations/review','/api/app-integrations/destinations/status/'+requestId,'/api/app-integrations/destinations/status/'+requestId]);
 assert.ok(remounted.requests.slice(1).every(r=>r.options===undefined),'recovery uses only the authorized status GET');
});
