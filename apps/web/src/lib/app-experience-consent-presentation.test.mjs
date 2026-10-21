import {AppDataContextSchema,AppDataConsentSnapshotSchema,AppDataConsentReferenceSchema,appConsentDeadline} from '../../../../packages/app-kit/dist/core.js';
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
function render({showEnabled=false,onOpenSettings,notice='',storeKeys=stores.map(store=>store.declaration.key)}={}){
 let cursor=0;const states=[[{target_key:'primary',session_id:'one',account:{label:'Personal'},stores}],null,false,notice,false];
 const Component=compile(find(consent,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='ExperienceDataConsent'),{React,appConsentDeadline,useState:()=>[states[cursor++],()=>{}],useRef:current=>({current}),useEffect:()=>{},RecordAccessStatusRow:marker('RecordAccessStatusRow'),AppDialog:marker('AppDialog'),AbortController,Date});
 return Component({installationId:'app',targetKey:'primary',storeKeys,scopeKey:'one',showEnabled,onOpenSettings});
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
 assert.equal(tree.filter(node=>node.type==='button').length,1);assert.equal(tree.filter(node=>node.type.displayName==='RecordAccessStatusRow').length,0);assert.equal(button.props.children[0],'Review record access');
 button.props.onClick();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(host.calls.slice(0,2),[['section','access'],['open',true]]);
 const blocked=opener({canFlush:false});blocked.callback();await new Promise(resolve=>setImmediate(resolve));assert.equal(blocked.calls.some(call=>call[0]==='open'),false);assert.match(blocked.calls[0][1],/Save the draft/);
});
test('full settings retains every reviewed store row and an unavailable notice stays visible outside',()=>{
 const full=flatten(render({showEnabled:true,onOpenSettings:()=>{}})).filter(node=>node.type.displayName==='RecordAccessStatusRow');assert.equal(full.length,11);assert.equal(full[0].props.active,true);assert.equal(full[1].props.active,false);assert.equal(typeof full[1].props.onReview,'function');
 const compact=flatten(render({onOpenSettings:()=>{},notice:'Access status is unavailable.'}));assert.ok(compact.find(node=>node.type==='p').props.children.includes('Access status is unavailable.'));
});
test('partial record access does not claim all saves require permission',()=>{
 const compact=flatten(render({onOpenSettings:()=>{}}));
 assert.equal(compact.find(node=>node.type==='p').props.children[0],'Saving store 1, store 2, store 3, store 4, store 5, store 6, store 7, store 8, store 9, store 10 needs access.');
 assert.equal(compact.find(node=>node.type==='button').props.children[0],'Review record access');
});
test('changing account scope clears an old notice and pending review state',()=>{
 let cursor=0,effect;const updates=[],states=[[],null,true,'Old account denial',true];
 const Component=compile(find(consent,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='ExperienceDataConsent'),{React,appConsentDeadline,useState:()=>{const index=cursor++;return [states[index],value=>updates.push([index,value])];},useRef:current=>({current}),useEffect:callback=>{effect??=callback;},RecordAccessStatusRow:marker('RecordAccessStatusRow'),AppDialog:marker('AppDialog'),AbortController,Date,api:{fetch:()=>new Promise(()=>{})}});
 Component({installationId:'app',targetKey:'recipient',storeKeys:['drafts'],scopeKey:'new-session',onOpenSettings:()=>{}});
 const cleanup=effect();
 assert.ok(updates.some(([index,value])=>index===2&&value===false),'new scope must not inherit an old pending review');
 assert.ok(updates.some(([index,value])=>index===3&&value===''),'new scope must not inherit an old account denial');
 cleanup();
});


function permissionFixture({allow=true,mode='until_revoked',active=false}={}){
 const id='11111111-1111-4111-8111-111111111111',hash='sha256:'+'a'.repeat(64),now=Date.now();let clock=now,cursor=0;const calls=[];
 const declaration={schema_version:'deft.app_record_store.v1',key:'drafts',resource_key:'inbox',runtime_requirement_key:'sync_provider',max_record_bytes:16384,max_files:1,max_file_bytes:2048,max_total_file_bytes:2048},target={target_key:'primary',session_id:id,account:{account_ref:'owned',label:'Synthetic'},resource_key:'inbox',identities:[],stores:[{declaration,consent:null}],...(allow?{allow_until_revoked:true}:{})};
 if(active)target.stores[0].consent={consent_id:id,consent_digest:hash,expires_at:null,consent_lifetime:'until_revoked'};let serverTarget=structuredClone(target);
 const states=[[target],null,false,'',false,mode,'2030-01-01T12:00',now],scope={org_id:id,owner_user_id:id,installation_id:id,app_version_id:id,grant_snapshot_id:id,package_digest:hash,grant_snapshot_digest:hash,lifecycle_epoch:1,grant_epoch:1,target_key:'primary',resource_key:'inbox',resource_binding_id:id,runtime_registration_id:id,operator_user_id:id,runtime_epoch:1,profile_digest:hash,consent_expires_at:null,consent_lifetime:'until_revoked'};
 const fetch=async(path,init)=>{const body=init?.body?JSON.parse(init.body):null;calls.push({path,body});if(path.endsWith('/review'))return Response.json({review_digest:hash,snapshot:{schema_version:'deft.app_data_consent.v1',consent_id:id,scope,connection:{session_id:id,session_revision:1,runtime_session_ref:'opaque',account_ref:'owned'},store:declaration,data_policy_digest:hash,purpose:'human_record_write',...body,store_key:undefined,review_expires_at:body.consent_lifetime?new Date(now+300000).toISOString():undefined}});if(path.endsWith('/revoke')){serverTarget.stores[0].consent=null;return Response.json({revoked:true});}if(path.endsWith('/activate'))return Response.json({consent_id:id,consent_digest:hash,expires_at:body.expires_at,...(body.consent_lifetime?{consent_lifetime:body.consent_lifetime}:{})});return Response.json({schema_version:'deft.app_data_context.v1',installation_id:id,targets:[serverTarget]});};
 const env={React,appConsentDeadline,AppDataContextSchema,AppDataConsentSnapshotSchema,AppDataConsentReferenceSchema,api:{fetch},useState:initial=>{const index=cursor++;if(states[index]===undefined)states[index]=typeof initial==='function'?initial():initial;return [states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value;}];},useRef:current=>({current}),useEffect:()=>{},RecordAccessStatusRow:marker('RecordAccessStatusRow'),AppDialog:marker('AppDialog'),AbortController,Date:class extends Date{static now(){return clock;}}};
 const Component=compile(find(consent,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='ExperienceDataConsent'),env),render=()=>{cursor=0;return flatten(Component({installationId:id,targetKey:'primary',storeKeys:['drafts'],scopeKey:'current',showEnabled:true}));};
 return {calls,render,states,replaceServerConsent:()=>{serverTarget.stores[0].consent={...serverTarget.stores[0].consent,consent_id:'22222222-2222-4222-8222-222222222222'};},tick:()=>new Promise(resolve=>setImmediate(resolve)),expire:()=>{clock=now+300001;states[7]=clock;}};
}
test('actual draft review callback sends explicit durable choice and expired Allow never dispatches',async()=>{const f=permissionFixture();let nodes=f.render();assert.ok(nodes.some(n=>n.type==='option'&&n.props.children.includes('Until revoked')));nodes.find(n=>n.type.displayName==='RecordAccessStatusRow').props.onReview();await f.tick();assert.deepEqual(f.calls[0].body,{store_key:'drafts',expires_at:null,consent_lifetime:'until_revoked'});assert.ok(f.states[1],'actual packed schema accepted exact review');assert.equal(f.calls.some(c=>c.path.endsWith('/activate')),false);f.expire();nodes=f.render();const button=nodes.find(n=>n.type==='button'&&n.props.children.includes('Allow private records'));assert.equal(button.props.disabled,true);button.props.onClick();await f.tick();assert.equal(f.calls.some(c=>c.path.endsWith('/activate')),false);});
test('draft choice cannot manufacture persistent authority when current target lacks opt-in',async()=>{const f=permissionFixture({allow:false});const nodes=f.render();assert.equal(nodes.some(n=>n.type==='option'&&n.props.children.includes('Until revoked')),false);nodes.find(n=>n.type.displayName==='RecordAccessStatusRow').props.onReview();await f.tick();assert.equal(f.calls.length,0);assert.equal(f.states[1],null);});

test('settings revoke is explicit, matches current consent and refreshes to disabled without deleting records',async()=>{const f=permissionFixture({active:true}),rows=f.render().filter(n=>n.type.displayName==='RecordAccessStatusRow');assert.equal(rows[0].props.active,true);assert.equal(f.calls.length,0);rows[0].props.onRevoke();await f.tick();assert.equal(f.calls.filter(c=>c.path.endsWith('/revoke')).length,1);assert.deepEqual(f.calls.find(c=>c.path.endsWith('/revoke')).body,{consent_id:'11111111-1111-4111-8111-111111111111'});assert.equal(f.calls.filter(c=>c.path.includes('/context?')).length,2);assert.equal(f.render().find(n=>n.type.displayName==='RecordAccessStatusRow').props.active,false);assert.match(f.states[3],/Saved records were not deleted/);});
test('revoke refuses a replaced current consent before dispatch',async()=>{const f=permissionFixture({active:true}),row=f.render().find(n=>n.type.displayName==='RecordAccessStatusRow');f.replaceServerConsent();row.props.onRevoke();await f.tick();assert.equal(f.calls.some(c=>c.path.endsWith('/revoke')),false);assert.match(f.states[3],/not confirmed/);});

test('no current write feature means no access banner, even with unrelated missing grants',()=>{
 assert.equal(render({onOpenSettings:()=>{},storeKeys:[]}),null);
 assert.equal(render({onOpenSettings:()=>{},storeKeys:['store_0']}),null);
 const needed=flatten(render({onOpenSettings:()=>{},storeKeys:['store_1']}));assert.equal(needed.find(node=>node.type==='p').props.children[0],'Saving store 1 needs access.');
});
