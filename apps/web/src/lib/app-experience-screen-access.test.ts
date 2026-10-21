import test from 'node:test';
import assert from 'node:assert/strict';
import {experienceScreenStoreKeys} from './app-experience-screen-access';
import type {ExperienceNode} from './app-experience-bridge';

test('resource_list and reader screens never demand unrelated private record stores',()=>{
 const screen={kind:'stack',id:'screen',children:[{kind:'button',id:'compose',label:'Compose'},{kind:'record_document',id:'reader',store_key:'drafts'}]} as unknown as ExperienceNode;
 assert.deepEqual(experienceScreenStoreKeys(screen),[]);
});
test('current forms and local controls demand only their own record stores',()=>{
 const screen={kind:'stack',id:'screen',children:[{kind:'record_form',id:'edit',store_key:'drafts'},{kind:'record_form',id:'other',store_key:'drafts'},{kind:'stack',id:'nested',children:[{kind:'record_mirror_control',id:'mirror',store_key:'templates'}]}]} as unknown as ExperienceNode;
 assert.deepEqual(experienceScreenStoreKeys(screen),['drafts','templates']);
 assert.deepEqual(experienceScreenStoreKeys({kind:'text',id:'empty',text:'No operation'}),[]);
});

test('a local job list demands access for its current status and cancellation controls',()=>{
 assert.deepEqual(experienceScreenStoreKeys({kind:'local_job_list',id:'jobs',store_key:'drafts'} as unknown as ExperienceNode),['drafts']);
});
