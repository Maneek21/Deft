import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeEmailAppNavigation,showNativeEmailNavigation,parseNativeEmailAvailability,readNativeEmailAvailability,unavailableNativeEmail} from './email-native-navigation';
import {isPrimaryNavigationItemActive} from './module-navigation';
import type {AppNavigationItem} from './app-navigation';
const legacy:AppNavigationItem={kind:'app',name:'Email',href:'/apps/real-installation/main',icon:null,installationId:'real-installation',links:[]};
const unrelated:AppNavigationItem={...legacy,installationId:'other-installation',href:'/apps/other-installation/main'};
const available={available:true,legacy_installation_ids:['real-installation']};

test('one primary Email entry follows the exact admitted replacement, with a native fallback',()=>{
 const experience={kind:'experience' as const,app_installation_id:legacy.installationId,app_id:'io.deft.email',app_name:'Email',label:'Email',experience_key:'main',key:'experience:email:main',href:legacy.href};
 assert.equal(showNativeEmailNavigation([{...legacy,links:[experience]}],available),false);
 assert.equal(showNativeEmailNavigation([{...unrelated,links:[{...experience,app_installation_id:unrelated.installationId}]}],available),true);
 assert.equal(showNativeEmailNavigation([legacy],available),true);
 assert.equal(showNativeEmailNavigation([],available),true);
 assert.equal(showNativeEmailNavigation([legacy],unavailableNativeEmail),false);
});
test('native mapping suppresses legacy modules but retains the upgraded same-installation Experience navigation',()=>{
 const experience={kind:'experience' as const,app_installation_id:legacy.installationId,app_id:'io.deft.email',app_name:'Email',label:'Email',experience_key:'main',key:'experience:email:main',href:legacy.href};
 const module={kind:'module' as const,app_installation_id:legacy.installationId,app_id:'io.deft.email',app_name:'Email',label:'Legacy inbox',module_slug:'email',collection_key:'inbox',href:'/modules/email/inbox'};
 const upgraded={...legacy,href:module.href,links:[module,experience]};
 const groups=nativeEmailAppNavigation([upgraded,unrelated],available);
 assert.deepEqual(groups,[{...upgraded,href:experience.href,links:[experience]},unrelated]);
 assert.deepEqual(upgraded.links,[module,experience]);
 assert.deepEqual(nativeEmailAppNavigation([upgraded],unavailableNativeEmail),[upgraded]);
});
test('host mapping replaces only its exact legacy installation, preserving other similarly named apps',()=>{
 assert.deepEqual(nativeEmailAppNavigation([legacy,unrelated],available),[unrelated]);assert.deepEqual(nativeEmailAppNavigation([legacy,unrelated],unavailableNativeEmail),[legacy,unrelated]);assert.equal(isPrimaryNavigationItemActive('/email','/email'),true);assert.equal(isPrimaryNavigationItemActive('/email-other','/email'),false);
});
test('missing, disabled, malformed or overbroad host flags never remove the legacy navigation',()=>{
 for(const value of [null,{available:true},{...available,private_account_id:'hidden'},{available:true,legacy_installation_ids:['real-installation','real-installation']},{available:true,legacy_installation_ids:Array(51).fill('x')},{available:true,legacy_installation_ids:['bad\nvalue']}])assert.deepEqual(parseNativeEmailAvailability(value),unavailableNativeEmail);
 const disabled=parseNativeEmailAvailability({...available,available:false});assert.deepEqual(nativeEmailAppNavigation([legacy],disabled),[legacy]);
});
test('explicit availability route is no-store and works independently of enrolled account count',async()=>{
 let path='',init:RequestInit={};const flag=await readNativeEmailAvailability({current:()=>true,fetch:async(url,options)=>{path=url;init=options;return new Response(JSON.stringify(available));}});assert.deepEqual(flag,available);assert.equal(path,'/api/email/availability');assert.equal(init.method,'GET');assert.equal(init.cache,'no-store');
});
test('404, authorization loss, malformed/oversized responses, abort and held session change all preserve legacy routing',async()=>{
 for(const result of [new Response('{}',{status:404}),new Response('{}',{status:403}),new Response('invalid'),new Response('x'.repeat(16385))])assert.deepEqual(await readNativeEmailAvailability({current:()=>true,fetch:async()=>result}),unavailableNativeEmail);
 let current=true,resolve!:(response:Response)=>void;const held=readNativeEmailAvailability({current:()=>current,fetch:()=>new Promise(done=>{resolve=done;})});current=false;resolve(new Response(JSON.stringify(available)));assert.deepEqual(await held,unavailableNativeEmail);
 const controller=new AbortController();controller.abort();let reads=0;assert.deepEqual(await readNativeEmailAvailability({current:()=>true,fetch:async()=>{reads++;return new Response(JSON.stringify(available));}},controller.signal),unavailableNativeEmail);assert.equal(reads,0);
});
