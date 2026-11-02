import test from 'node:test';import assert from 'node:assert/strict';import {renderToStaticMarkup} from 'react-dom/server';
import {verifiedExperienceAccountLabels,experienceSettingsAccounts,observationIntervalChoices,observationIntervalLabel} from './app-experience-settings-display';
import {ExperienceRefreshInterval} from '../components/apps/experience-background-refresh';import {ExperienceBackgroundRefreshReview} from '../components/apps/experience-background-refresh-review';import {ExperienceSettings} from '../components/apps/experience-settings';
import {ExperienceAgentPolicy,agentActionLabel,saveAgentPolicy} from '../components/apps/experience-agent-policy';import {recordAccessSummary} from '../components/apps/experience-data-consent';
import {readFileSync} from 'node:fs';

test('fresh verified labels decorate only the existing authorized catalog and never nominate or add a target',()=>{
 const context={targets:[{target_key:'sender',session:{state:'connected',account:{account_ref:'owned',label:'sender@example.test'}}},{target_key:'recipient',session:{state:'indeterminate',account:{account_ref:'other-owned',label:'recipient@example.test'}}},{target_key:'setup',session:{state:'not_connected',account:null}}]} as any;
 const labels=verifiedExperienceAccountLabels(context);assert.deepEqual(experienceSettingsAccounts([{key:'sender',label:'internal sender'},{key:'setup',label:'Setup'}],[...labels,{key:'foreign',label:'Foreign'}]),[{key:'sender',label:'sender@example.test'},{key:'setup',label:'Setup'}]);
 const html=renderToStaticMarkup(<ExperienceSettings experienceLabel="Email" onBack={()=>{}} accounts={experienceSettingsAccounts([{key:'sender',label:'internal sender'},{key:'recipient',label:'internal recipient'}],labels)} selectedAccountKey="sender" onSelectAccount={()=>{}} access={{state:'active'}}/>);
 assert.match(html,/Use account recipient@example.test/);assert.doesNotMatch(html,/internal sender|internal recipient|Use account Foreign/);assert.equal(labels.length,2);
});

test('human interval presets retain exact seconds, the reviewed minimum and existing custom policy values',()=>{
 assert.deepEqual(observationIntervalChoices(60,900).map(value=>value.value),[300,900,1800,3600]);assert.deepEqual(observationIntervalChoices(300,900).map(value=>value.value),[300,900,1800,3600]);assert.deepEqual(observationIntervalChoices(1200,1200).map(value=>value.value),[1200,1800,3600]);assert.deepEqual(observationIntervalChoices(86400,86400).map(value=>value.value),[86400]);assert.equal(observationIntervalLabel(900),'15 minutes');assert.equal(observationIntervalLabel(91),'91 seconds');assert.deepEqual(observationIntervalChoices(86401,900),[]);
 let selected=0;const control=ExperienceRefreshInterval({min:1200,value:1200,disabled:false,onChange:value=>selected=value}) as any,select=control.props.children[1];select.props.onChange({target:{value:'300'}});assert.equal(selected,0);select.props.onChange({target:{value:'1800'}});assert.equal(selected,1800);
 const html=renderToStaticMarkup(control);assert.match(html,/>20 minutes</);assert.doesNotMatch(html,/>5 minutes<|type="number"|interval \(seconds\)/);
});

test('the immutable background review uses readable units while retaining expiry and no-file/no-Send disclosure',()=>{
 const review={account:{label:'Owned'},interval_seconds:900,expires_at:'2030-01-01T00:00:00.000Z'} as any;
 const html=renderToStaticMarkup(<ExperienceBackgroundRefreshReview review={review} now={0} busy={false} onAllow={()=>{}} onCheck={()=>{}} onClose={()=>{}}/>);assert.match(html,/every 15 minutes/);assert.match(html,/does not permit draft changes, sending/);assert.match(html,/not downloaded/);assert.match(html,/Allow background refresh/);
});

test('required private review stays inside the unified account card and remains reachable from the normal app',()=>{
 const html=renderToStaticMarkup(<ExperienceSettings experienceLabel="Email" onBack={()=>{}} accounts={[]} selectedAccountKey="sender" access={{state:'review_required'}} accessReview={<section aria-label="Experience private access"><button>Review private access</button></section>}/>);
 const section=html.indexOf('aria-label="Experience private access"');assert.ok(section>=0);assert.match(html.slice(0,section),/Private access/);assert.doesNotMatch(html.slice(0,section),/<section hidden=""/);
 const source=readFileSync(new URL('../components/apps/installed-app-experience.tsx',import.meta.url),'utf8');assert.match(source,/\{!settingsOpen&&privateAccessReview\}/);assert.match(source,/accessReview=\{<div[^>]*>\s*\{privateAccessReview\}/);assert.match(source,/accountLabels\?\.scope===accountLabelScope/);
});

test('agent requests render every declared action as an inline list with immediate-save options',()=>{
 const html=renderToStaticMarkup(<ExperienceAgentPolicy sessionId="session/one" actions={['read_messages','mirror_drafts','organize_messages','send_message']} ensureAuthority={async()=>true}/>);
 for(const label of ['Read messages','Mirror drafts','Organize messages','Send message'])assert.match(html,new RegExp(label));
 for(const label of ['Read messages','Mirror drafts','Organize messages','Send message'])assert.match(html,new RegExp(`aria-label="${label} permission"`));
 assert.match(html,/Do not allow/);assert.match(html,/Require my approval/);
 assert.doesNotMatch(html,/Save agent permission|Action<|>Permission</);
 assert.equal(agentActionLabel('organize_messages'),'Organize messages');
});

test('an agent permission change saves immediately with the loaded revision without an explicit save button',async()=>{
 const calls:{path:string;body:unknown}[]=[];
 const saved=await saveAgentPolicy({sessionId:'session/one',action:'send_message',mode:'require_approval',revision:4,
  ensureAuthority:async()=>true,request:async(path,init)=>{calls.push({path,body:JSON.parse(String(init?.body))});return Response.json({mode:'require_approval',revision:5});}});
 assert.deepEqual(saved,{mode:'require_approval',revision:5});
 assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/app-experiences/sessions/session%2Fone/agent-policies/send_message');
 assert.deepEqual(calls[0].body,{mode:'require_approval',expected_revision:4});
 await assert.rejects(saveAgentPolicy({sessionId:'session/one',action:'send_message',mode:'deny',revision:5,
  ensureAuthority:async()=>false,request:async()=>{throw Error('must not dispatch');}}));
});

test('record store consent summary states progress without claiming every store is active',()=>{
 assert.equal(recordAccessSummary([{active:true},{active:true}]),'All private record stores active');
 assert.equal(recordAccessSummary([{active:true},{active:false},{active:false}]),'1 of 3 record stores active');
 assert.equal(recordAccessSummary([{active:false}]),'0 of 1 record stores active');
});
