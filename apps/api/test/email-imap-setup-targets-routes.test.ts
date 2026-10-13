import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmailImapSetupTargetRoutes} from '../src/routes/email-imap-setup-targets.js';
test('IMAP targets are verified owner scoped metadata, reject browser nominations and private output',async()=>{
 let calls=0,leak=false;const route=createEmailImapSetupTargetRoutes({now:()=>1000,verify:async()=>({id:'owner',org_id:'org',sid:'sid',exp:10}),list:async(actor,org)=>{calls++;assert.equal(actor.user_id,'owner');assert.equal(actor.web_session_id,'sid');assert.equal(org,'org');return {...{items:[],has_more:false},...(leak?{password:'private'}:{})};}});
 assert.equal((await route.request('/imap-setup-targets')).status,401);assert.equal((await route.request('/imap-setup-targets?owner=other',{headers:{authorization:'Bearer token'}})).status,400);assert.equal(calls,0);
 const response=await route.request('/imap-setup-targets',{headers:{authorization:'Bearer token'}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{items:[],has_more:false});
 leak=true;const blocked=await route.request('/imap-setup-targets',{headers:{authorization:'Bearer token'}});assert.equal(blocked.status,503);assert.doesNotMatch(await blocked.text(),/private/);
});
