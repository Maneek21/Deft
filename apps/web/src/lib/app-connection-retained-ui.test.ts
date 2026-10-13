import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transpileModule,ScriptTarget} from 'typescript';
import {adoptNativeEmailAccount} from './email-native-enrollment';

const source=readFileSync(new URL('../components/apps/experience-connection-settings.tsx',import.meta.url),'utf8').replaceAll('\r\n','\n');
const act=source.match(/async function act\(operation: 'begin' \| 'disconnect'\) \{([\s\S]*?)\n  \}\n  const healthLabel/)![1];
const code=transpileModule(`(async(operation:'begin'|'disconnect')=>{${act}})`,{compilerOptions:{target:ScriptTarget.ES2022}}).outputText;
test('Account settings retries native adoption without OAuth or Experience field escalation',async()=>{
 const body=source.match(/async function enableCachedMailbox\(\) \{([\s\S]*?)\n  \}\n  async function act/)![1];
 const run=transpileModule(`(async()=>{${body}})`,{compilerOptions:{target:ScriptTarget.ES2022}}).outputText;
 const native={account_id:'stable',resource_binding_id:'11111111-1111-4111-8111-111111111111',state:'available'},status={state:'connected',native};
 const paths:string[]=[],notices:string[]=[];let saved:unknown=status;
 const handler=vm.runInNewContext(run,{working:false,disabled:false,document:{hidden:false},mounted:{current:true},status,
  api:{getAccessToken:()=> 'same-session',fetch:async(path:string)=>{paths.push(path);return Response.json({account_id:'stable',state:'active',provider:'gmail',authority_revision:2});}},
  isSameWebSession:(a:string,b:string)=>a===b,adoptNativeEmailAccount,setWorking:()=>{},onBusy:()=>{},
  setNotice:(v:string)=>notices.push(v),setStatus:(fn:(v:unknown)=>unknown)=>{saved=fn(saved);},Error});
 await handler();assert.deepEqual(paths,['/api/email/accounts/stable/adopt']);assert.equal((saved as typeof status).native.state,'active');assert.match(notices.at(-1)!,/first sync/);
});
test('Disconnect uses exact retained owner target without requesting expired Experience authority; Connect stays gated',async()=>{
 for(const operation of ['disconnect','begin'] as const){
  const calls:string[]=[],notices:string[]=[];let authorityChecks=0;
  const handler=vm.runInNewContext(code,{working:false,disabled:false,document:{hidden:false},mounted:{current:true},
   sessionId:'expired-session',installationId:'app',experienceKey:'main',base:'/api/app-experiences/sessions/expired-session/connections',
   management:'/api/app-owner-connections/app/connections/personal/manage',
   api:{getAccessToken:()=> 'same-web-session',fetch:async(path:string,options:{body:string})=>{calls.push(path);assert.equal(options.body,'{"operation":"disconnect"}');return{ok:true,json:async()=>({state:'revoked'})};}},
   ensureAuthority:async()=>{authorityChecks++;return false;},isSameWebSession:(a:string,b:string)=>a===b,
   setWorking:()=>{},onBusy:()=>{},setNotice:(v:string)=>notices.push(v),setStatus:()=>{},statusView:(v:unknown)=>v,Error,JSON,
  });
  await handler(operation);
  assert.deepEqual(calls,operation==='disconnect'?['/api/app-owner-connections/app/connections/personal/manage']:[]);
  assert.equal(authorityChecks,operation==='disconnect'?0:1);
  assert.equal(notices.at(-1),operation==='disconnect'?'Account disconnected.':'Account setup access ended.');
 }
});
test('Disconnect cannot publish a held result after the web session changes',async()=>{
 let token='original',statuses=0;const notices:string[]=[];
 const handler=vm.runInNewContext(code,{working:false,disabled:false,document:{hidden:false},mounted:{current:true},
  management:'/retained/personal/manage',api:{getAccessToken:()=>token,fetch:async()=>{token='replacement';return{ok:true,json:async()=>({state:'revoked'})};}},
  ensureAuthority:async()=>{throw Error('Cleanup must not request read authority');},isSameWebSession:(a:string,b:string)=>a===b,
  setWorking:()=>{},onBusy:()=>{},setNotice:(v:string)=>notices.push(v),setStatus:()=>{statuses++;},statusView:(v:unknown)=>v,Error,JSON,
 });
 await handler('disconnect');assert.equal(statuses,0);assert.equal(notices.at(-1),'Account setup access ended.');
});
