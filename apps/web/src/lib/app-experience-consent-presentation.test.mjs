import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const ts=createRequire(import.meta.url)('typescript');
const source=name=>ts.createSourceFile(name,readFileSync(new URL('../components/apps/'+name,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const consent=source('experience-data-consent.tsx'),installed=source('installed-app-experience.tsx');
const compile=(node,env)=>runInNewContext(ts.transpileModule('('+node.getText().replace(/^export /u,'')+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,env);
function find(tree,predicate){let found;const walk=node=>{if(!found&&predicate(node))found=node;ts.forEachChild(node,walk);};walk(tree);assert.ok(found);return found;}
const marker=name=>Object.assign(()=>null,{displayName:name});
const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})};
function flatten(tree){const result=[];const visit=node=>{if(!node||typeof node!=='object')return;result.push(node);node.props?.children?.forEach(visit);};visit(tree);return result;}
const stores=Array.from({length:11},(_,index)=>({declaration:{key:'store_'+index},consent:index===0?{expires_at:'2099-01-01T00:00:00Z'}:null}));
function render({showEnabled=false,onOpenSettings,notice=''}={}){
 let cursor=0;const states=[[{target_key:'primary',session_id:'one',account:{label:'Personal'},stores}],null,false,notice,false];
 const Component=compile(find(consent,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='ExperienceDataConsent'),{React,useState:()=>[states[cursor++],()=>{}],useRef:current=>({current}),useEffect:()=>{},RecordAccessStatusRow:marker('RecordAccessStatusRow'),AppDialog:marker('AppDialog'),AbortController,Date});
 return Component({installationId:'app',targetKey:'primary',storeKeys:stores.map(store=>store.declaration.key),scopeKey:'one',showEnabled,onOpenSettings});
}
function opener({canFlush=true}={}){
 const calls=[],ref=current=>({current});
 const env={document:{hidden:false},navigationBusy:ref(false),composerOpen:ref(false),connectionBusyRef:ref(false),settingsOpenRef:ref(false),viewHost:ref(null),reviewGeneration:ref(1),flushRecordWrites:ref(async()=>canFlush),dispatchedWrites:ref(new Set()),sourceReturn:ref(null),refreshNavigation:ref(()=>calls.push(['navigation'])),api:{getAccessToken:()=>'signed-in'},settleDispatchedExperienceWrites:async()=>true,isSameWebSession:(one,two)=>one===two,setSettingsSection:section=>calls.push(['section',section]),setSettingsOpen:open=>calls.push(['open',open]),setSource:value=>calls.push(['source',value]),setRenewalNotice:value=>calls.push(['notice',value])};
 const showSettings=compile(find(installed,node=>ts.isVariableDeclaration(node)&&node.name.getText()==='showSettings').initializer.arguments[0],env);
 const dataNode=find(installed,node=>ts.isJsxSelfClosingElement(node)&&node.tagName.getText()==='ExperienceDataConsent'&&node.attributes.properties.some(prop=>prop.name?.getText()==='onOpenSettings'));
 const callback=compile(dataNode.attributes.properties.find(prop=>prop.name?.getText()==='onOpenSettings').initializer.expression,{showSettings});
 return {calls,showSettings,callback};
}
test('outside access summary is one action that opens Access settings through the existing save fences',async()=>{
 const host=opener(),tree=flatten(render({onOpenSettings:host.callback})),button=tree.find(node=>node.type==='button');
 assert.equal(tree.filter(node=>node.type==='button').length,1);assert.equal(tree.filter(node=>node.type.displayName==='RecordAccessStatusRow').length,0);assert.equal(button.props.children[0],'Review access');
 button.props.onClick();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(host.calls.slice(0,2),[['section','access'],['open',true]]);
 const blocked=opener({canFlush:false});blocked.callback();await new Promise(resolve=>setImmediate(resolve));assert.equal(blocked.calls.some(call=>call[0]==='open'),false);assert.match(blocked.calls[0][1],/Save the draft/);
});
test('full settings retains every reviewed store row and an unavailable notice stays visible outside',()=>{
 const full=flatten(render({showEnabled:true,onOpenSettings:()=>{}})).filter(node=>node.type.displayName==='RecordAccessStatusRow');assert.equal(full.length,11);assert.equal(full[0].props.active,true);assert.equal(full[1].props.active,false);assert.equal(typeof full[1].props.onReview,'function');
 const compact=flatten(render({onOpenSettings:()=>{},notice:'Access status is unavailable.'}));assert.ok(compact.find(node=>node.type==='p').props.children.includes('Access status is unavailable.'));
});
test('partial record access does not claim all saves require permission',()=>{
 const compact=flatten(render({onOpenSettings:()=>{}}));
 assert.equal(compact.find(node=>node.type==='p').props.children[0],'Some features need access.');
 assert.equal(compact.find(node=>node.type==='button').props.children[0],'Review access');
});
test('changing account scope clears an old notice and pending review state',()=>{
 let cursor=0,effect;const updates=[],states=[[],null,true,'Old account denial',true];
 const Component=compile(find(consent,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='ExperienceDataConsent'),{React,useState:()=>{const index=cursor++;return [states[index],value=>updates.push([index,value])];},useRef:current=>({current}),useEffect:callback=>{effect=callback;},RecordAccessStatusRow:marker('RecordAccessStatusRow'),AppDialog:marker('AppDialog'),AbortController,Date,api:{fetch:()=>new Promise(()=>{})}});
 Component({installationId:'app',targetKey:'recipient',storeKeys:['drafts'],scopeKey:'new-session',onOpenSettings:()=>{}});
 const cleanup=effect();
 assert.ok(updates.some(([index,value])=>index===2&&value===false),'new scope must not inherit an old pending review');
 assert.ok(updates.some(([index,value])=>index===3&&value===''),'new scope must not inherit an old account denial');
 cleanup();
});
