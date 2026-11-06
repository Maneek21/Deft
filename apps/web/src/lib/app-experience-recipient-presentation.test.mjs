import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {recordFormFields,recordFormIdentity,recordFormLabels} from './app-experience-record-form.js';
import {parseAddressList} from '../../../../packages/app-kit/src/structured-address';
const require=createRequire(import.meta.url),ts=process.env.DEFT_UI_TEST_TYPESCRIPT?require(process.env.DEFT_UI_TEST_TYPESCRIPT):require('typescript');
const source=ts.createSourceFile('form.tsx',readFileSync(new URL('../components/apps/experience-record-form.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
assert.equal(source.parseDiagnostics.length,0);
const declaration=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='ExperienceRecordForm');
const body=ts.transpileModule('('+declaration.getText(source).replace(/^export /u,'')+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
function fixture(prefilled=false,notice='',recovery=null){
 const value={to:'recipient@example.test',cc:prefilled?'copy@example.test':'',bcc:'',subject:'Kept subject',body:'Kept body',body_html:'',attachments:[]};
 const row={revision:2,status:'draft',summary:{},value},state={row,value,dirty:false,state:'saved'},changes=[];
 const states=[recovery,state,[],0,false,{address:'sender@example.test'},notice,{},false,false,false,false,false,false,false,0];let cursor;
 const marker=name=>Object.assign(()=>null,{displayName:name});
 const env={React:{createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})},useRef:current=>({current}),useState:initial=>{const index=cursor++;if(!(index in states))states[index]=initial;return [states[index],next=>{states[index]=typeof next==='function'?next(states[index]):next;}];},useMemo:factory=>factory(),useEffect:()=>{},createNativeInlinePreviews:()=>({}),RecordSurface:marker('RecordSurface'),RecordBody:marker('RecordBody'),ExperienceComposeMailboxControl:marker('Mailbox'),ExperienceRecordFiles:marker('Files'),ChevronDown:marker('Chevron'),ImagePlus:marker('Image'),pill:'pill',recordFormFiles:()=>[],recordFormString:(value,field)=>typeof value[field]==='string'?value[field]:'',parseMailboxList:text=>text?[{address:text}]:[],clearTimeout,AbortController};
  env.createInlinePreviews=()=>({acquire:()=>({ready:Promise.resolve(null),release(){},current:()=>false}),dispose(){}});
  env.recordFormFields=recordFormFields;env.recordFormLabels=recordFormLabels;env.recordFormIdentity=recordFormIdentity;
  env.parseAddressList=parseAddressList;
 const Form=runInNewContext(body,env),profile={addresses:[{field:'to',label:'To'},{field:'cc',label:'Cc',optional:true},{field:'bcc',label:'Bcc',optional:true}],identity:{field:'from_identity',address_field:'address',label:'From'},subject:{field:'subject',label:'Subject'},richtext:{html_field:'body_html',plain_field:'body'},files:{max_files:0}};
 const render=()=>{cursor=0;return Form({node:{id:'draft_form',record_id:'one',profile},ports:{},context:{current:()=>true,signal:new AbortController().signal},emit:event=>changes.push(event)});};
 const flatten=tree=>{const result=[];const visit=node=>{if(!node||typeof node!=='object')return;result.push(node);node.props?.children?.forEach(visit);};visit(tree);return result;};
 const controls=()=>flatten(render()),toggle=label=>controls().find(node=>node.type==='button'&&node.props.children[0]===label),fields=()=>controls().filter(node=>node.type.displayName==='Mailbox').map(node=>node.props.label);
 return {value,changes,controls,toggle,fields};
}
test('optional recipient toggles are independent and keep the draft and writer untouched',()=>{
 const ui=fixture(),before=JSON.stringify(ui.value);assert.deepEqual(ui.fields(),['To']);
 ui.toggle('Cc').props.onClick();assert.equal(ui.toggle('Cc').props['aria-expanded'],true);assert.equal(ui.toggle('Bcc').props['aria-expanded'],false);assert.deepEqual(ui.fields(),['To','Cc']);
 ui.toggle('Bcc').props.onClick();assert.deepEqual(ui.fields(),['To','Cc','Bcc']);ui.toggle('Cc').props.onClick();assert.deepEqual(ui.fields(),['To','Bcc']);
 assert.equal(JSON.stringify(ui.value),before);assert.deepEqual(ui.changes,[]);
});
test('populated optional recipients are visible initially and remain saved when collapsed',()=>{
 const ui=fixture(true);assert.deepEqual(ui.fields(),['To','Cc']);assert.equal(ui.toggle('Cc').props['aria-expanded'],true);assert.equal(ui.toggle('Cc').props.children[1],' (1)');
 ui.toggle('Cc').props.onClick();assert.deepEqual(ui.fields(),['To']);assert.equal(ui.value.cc,'copy@example.test');assert.equal(ui.toggle('Cc').props.children[1],' (1)');assert.deepEqual(ui.changes,[]);
});
test('an unavailable default warning stays truthful on a successfully saved draft',()=>{
 const labels=ts.createSourceFile('form.ts',readFileSync(new URL('./app-experience-record-form.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);let notice;
 const visit=node=>{if(ts.isPropertyAssignment(node)&&ts.isIdentifier(node.name)&&node.name.text==='initial_change_unavailable'&&ts.isStringLiteral(node.initializer))notice=node.initializer.text;ts.forEachChild(node,visit);};visit(labels);assert.ok(notice);
 const ui=fixture(false,notice),status=ui.controls().filter(node=>node.type==='p'&&node.props.role==='status').map(node=>node.props.children.join('')).join(' ');
 assert.ok(status.includes(notice),'status must carry the actual unavailable-default notice');assert.doesNotMatch(status,/unsaved|not saved/);assert.equal(ui.value.body,'Kept body');assert.deepEqual(ui.changes,[]);
});
test('quiet recovery checks never flash a banner while unconfirmed candidates and submissions still surface',()=>{
 const banner=ui=>ui.controls().find(node=>node.type==='section'&&node.props['aria-label']==='Browser draft recovery');
 const button=(ui,label)=>ui.controls().some(node=>node.type==='button'&&(node.props.children===label||node.props.children?.[0]===label));
 const inFlight=fixture(false,'',{candidate:null,notice:'Checking browser recovery…',ready:false,submission:null});
 assert.equal(banner(inFlight),undefined,'an in-flight recovery check must not render a banner');
 const candidate=fixture(false,'',{candidate:{baseRevision:1,value:{content:{body:'Browser draft'},baseDigest:'sha256:'+'a'.repeat(64)}},notice:'A browser draft is available. Your saved message is kept.',ready:true,submission:null});
 assert.ok(banner(candidate),'an unconfirmed recovery candidate must surface');
 assert.ok(button(candidate,'Restore browser draft'));assert.ok(button(candidate,'Keep current draft'));
 const failed=fixture(false,'',{candidate:null,notice:'Browser recovery is unavailable or full. Your current text and older recovery copies are kept.',ready:false,submission:null});
 assert.ok(banner(failed),'a failed recovery check must surface');
 assert.ok(button(failed,'Check browser recovery access'));
 const submission=fixture(false,'',{candidate:null,notice:'Browser recovery ready',ready:true,submission:{key:'11111111-1111-4111-8111-111111111111',purpose:'send',state:'pending',submissionId:'22222222-2222-4222-8222-222222222222',sessionId:'11111111-1111-4111-8111-111111111111',actionKey:'send_message',revision:1,digest:'sha256:'+'a'.repeat(64)}});
 assert.ok(banner(submission),'an unconfirmed submission must surface');
 assert.ok(submission.controls().some(node=>node.props['aria-label']==='Submission reference'));
});
