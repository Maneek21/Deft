import assert from 'node:assert/strict';
import test from 'node:test';
import { emailReadingPreferenceRequest } from './email-reading-preferences';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';

test('Reading settings applies saved choice only after successful explicit Save; unmounted held save cannot remount images',async()=>{
  const source=readFileSync(new URL('../components/apps/email-reading-settings.tsx',import.meta.url),'utf8').replaceAll('\r\n','\n');
  const body=source.match(/async function save\(\) \{([\s\S]*?)\n  \}\n  return/)![1];
  const code=transpileModule(`(async()=>{${body}})`,{compilerOptions:{target:ScriptTarget.ES2022}}).outputText;
  for(const outcome of ['saved','conflict','unmounted']){
    const pending:{current:AbortController|null}={current:null};let remounts=0;const writes:unknown[]=[],notices:string[]=[];
    const run=vm.runInNewContext(code,{disabled:false,working:false,pending,saved:{account_id:'account',external_images:'ask',revision:1},choice:'always',accountId:'account',
      document:{hidden:false},AbortController,Error,isSameWebSession:(a:string,b:string)=>a===b,emailReadingPreferenceRequest,
      api:{getAccessToken:()=> 'exact-session',fetch:async(_path:string,init:RequestInit)=>{
        assert.equal(init.body,'{"external_images":"always","expected_revision":1}');
        if(outcome==='unmounted')pending.current?.abort();
        return outcome==='conflict'?Response.json({},{status:409}):Response.json({account_id:'account',external_images:'always',revision:2});}},
      setWorking:()=>{},onBusy:()=>{},setNotice:(v:string)=>notices.push(v),setSaved:(v:unknown)=>writes.push(v),setChoice:()=>{},onSaved:()=>{remounts++;},
    });
    await run();assert.equal(remounts,outcome==='saved'?1:0);assert.equal(writes.length,outcome==='saved'?1:0);
    if(outcome==='conflict')assert.match(notices.at(-1)!,/Reload the saved choice/);
  }
});

test('saving an image choice clears retained host presentation and cancels its old image controller before rereading same message',()=>{
  const source=readFileSync(new URL('../components/apps/installed-app-experience.tsx',import.meta.url),'utf8').replaceAll('\r\n','\n');
  const body=source.match(/readingPreferencesChanged.current=\(\)=>\{([\s\S]*?)\n    \};/)![1];
  const events:string[]=[];const view={message:'same'};
  vm.runInNewContext(`(()=>{${body}})()`,{locallyCurrent:()=>true,sourcePresentations:{clear:()=>events.push('clear-source')},
    presentationDisposals:{values:()=>[{mount:()=>events.push('cancel-old-images')}],clear:()=>events.push('clear-controller')},latestView:view,
    renderHostView:(actual:unknown)=>{assert.equal(actual,view);events.push('reread-current-message');}});
  assert.deepEqual(events,['clear-source','cancel-old-images','clear-controller','reread-current-message']);
});
test('saved choice uses exact scoped route and CAS, accepts only closed matching account output', async () => {
  const output = await emailReadingPreferenceRequest('account/a', { current: () => true, fetch: async (path, init) => {
    assert.equal(path, '/api/email/accounts/account%2Fa/reading-preferences'); assert.equal(init.method, 'PATCH');
    assert.equal(init.body, '{"external_images":"always","expected_revision":1}'); assert.equal(init.cache, 'no-store');
    return Response.json({ account_id: 'account/a', external_images: 'always', revision: 2 }); } }, { external_images: 'always', expected_revision: 1 });
  assert.equal(output.external_images, 'always');
  for(const value of [{account_id:'foreign',external_images:'always',revision:2},{account_id:'account/a',external_images:'always',revision:2,credential:'secret'},
    {account_id:'account/a',external_images:'allow_all',revision:2}])await assert.rejects(emailReadingPreferenceRequest('account/a',{current:()=>true,fetch:async()=>Response.json(value)}));
});
test('held preference responses and errors cannot cross current host scope; stale edits require reload', async () => {
  let current = true;
  await assert.rejects(emailReadingPreferenceRequest('account', { current: () => current, fetch: async () => { current = false;
    return Response.json({ account_id: 'account', external_images: 'always', revision: 2 }); } }), /access ended/);
  await assert.rejects(emailReadingPreferenceRequest('account', { current: () => true, fetch: async () => Response.json({}, { status: 409 }) },
    { external_images: 'always', expected_revision: 1 }), /Reload the saved choice/);
});
