import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createEmailSearchDiagnostics,emailSearchDiagnosticAccounts,profileEmailSearchPhase,noteEmailSearchResult} from '../src/lib/email-search-diagnostics.js';

test('actual routes fresh-process default/explicit-off and operator allowlist cap preserve body/status/no request activation',()=>{
 const cli=fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs',import.meta.url)),fixture=fileURLToPath(new URL('./email-search-diagnostics-route-fixture.mts',import.meta.url)),config=fileURLToPath(new URL('../../../tsconfig.email-stage34.json',import.meta.url));
 for(const mode of ['off','on','off']){const env={...process.env};if(mode==='on')env.DEFT_EMAIL_SEARCH_DIAGNOSTICS='{"account_ids":["fixture-a","fixture-b"]}';else delete env.DEFT_EMAIL_SEARCH_DIAGNOSTICS;
  const run=spawnSync(process.execPath,[cli,'--tsconfig',config,fixture,mode],{env,encoding:'utf8',timeout:20000});assert.equal(run.status,0,run.stderr||run.stdout);assert.deepEqual(JSON.parse(run.stdout),{mode,records:mode==='on'?4:0,calls:6,unauthorized:401,malformed:400,denied:403});
 }
});

test('operator flag requires exactly two scoped accounts and never accepts a request switch',()=>{
 for(const raw of [undefined,'1','{}','null','[]',JSON.stringify({account_ids:['a']}),JSON.stringify({account_ids:['a','a']}),JSON.stringify({account_ids:['a','b'],enabled:true}),JSON.stringify({account_ids:['a',' b']}),'x'.repeat(1025)])assert.equal(emailSearchDiagnosticAccounts(raw).size,0);
 assert.deepEqual([...emailSearchDiagnosticAccounts(JSON.stringify({account_ids:['controlled-a','controlled-b']}))],['controlled-a','controlled-b']);
});
test('disabled/unlisted/expired/cap paths return original promises; four selected requests total',async()=>{
 let wall=100,enabled=true;const reports:any[]=[];const accounts=emailSearchDiagnosticAccounts('{"account_ids":["a","b"]}');
 const collector=createEmailSearchDiagnostics({enabled:account=>enabled&&accounts.has(account),wall:()=>wall,emit:r=>reports.push(r)}),promise=Promise.resolve('exact');
 assert.equal(collector.run('foreign',()=>promise),promise);enabled=false;assert.equal(collector.run('a',()=>promise),promise);enabled=true;
 for(let i=0;i<4;i++)assert.equal(await collector.run(i%2?'b':'a',()=>promise),'exact');
 assert.equal(collector.run('a',()=>promise),promise);assert.equal(reports.length,4);
 const fresh=createEmailSearchDiagnostics({enabled:()=>true,wall:()=>wall,emit:r=>reports.push(r)});wall+=600000;assert.equal(fresh.run('a',()=>promise),promise);wall-=600000;assert.equal(fresh.run('a',()=>promise),promise);assert.equal(reports.length,4);
 assert.equal(profileEmailSearchPhase('provider',()=>promise),promise);
});
test('clock/enabler/sink failures preserve fulfillment, exact denial and cancellation objects',async()=>{
 const secret=Error('private-token-query');
 for(const options of [{enabled:()=>{throw secret;}},{enabled:()=>true,wall:()=>{throw secret;}},{enabled:()=>true,clock:()=>{throw secret;}},{enabled:()=>true,emit:()=>{throw secret;}}]){
  const c=createEmailSearchDiagnostics({emit:()=>{},...options});assert.equal(await c.run('a',async()=>42),42);
  await assert.rejects(c.run('a',()=>profileEmailSearchPhase('provider',async()=>{throw secret;})),e=>e===secret);
 }
 let clocks=0;const c=createEmailSearchDiagnostics({enabled:()=>true,clock:()=>++clocks===1?0:(()=>{throw secret;})(),emit:()=>{throw secret;}});
 assert.equal(await c.run('a',()=>profileEmailSearchPhase('provider',async()=>43)),43);
 const aborted=new DOMException('private aborted input','AbortError');await assert.rejects(c.run('a',async()=>{throw aborted;}),e=>e===aborted);
});
test('overlapping request-owned interval trees retain held nested work without logging values',async()=>{
 const reports:any[]=[];const c=createEmailSearchDiagnostics({enabled:()=>true,emit:r=>reports.push(r)});
 let release!:()=>void;const held=new Promise<void>(r=>release=r);
 const one=c.run('private-account',()=>profileEmailSearchPhase('search',async()=>{
  await profileEmailSearchPhase('provider',async()=>{await held;await profileEmailSearchPhase('authority_connected',async()=>profileEmailSearchPhase('authority_sql_pass',async()=>{}));});
  await profileEmailSearchPhase('persist',async()=>{});noteEmailSearchResult({items:21,failures:2,partial:true});return 'private-query';
 }));
 const two=c.run('other-private-account',()=>profileEmailSearchPhase('provider',async()=>{noteEmailSearchResult({items:0,failures:0,partial:false});return 9;}));
 assert.equal(await two,9);release();assert.equal(await one,'private-query');assert.equal(reports.length,2);
 const first=reports.find(r=>r.items===21);assert.deepEqual(first.intervals.map((r:any)=>[r.phase,r.parent]),[['search',null],['provider',0],['authority_connected',1],['authority_sql_pass',2],['persist',0]]);
 for(const report of reports){assert.match(report.sample_id,/^[a-f0-9-]{36}$/);assert.equal(report.outcome,'success');assert.ok(report.intervals.every((r:any)=>r.end_ms>=r.start_ms));}
 const json=JSON.stringify(reports);for(const privateValue of ['private-account','other-private-account','private-query','token','query','cursor','provider_url'])assert.equal(json.includes(privateValue),false);
});
test('bounded intervals/depth and settled context prevent late work extending a report',async()=>{
 const reports:any[]=[];let late!:()=>Promise<void>;const c=createEmailSearchDiagnostics({enabled:()=>true,emit:r=>reports.push(r)});
 await c.run('a',async()=>{let resolve!:()=>void;const held=new Promise<void>(r=>resolve=r);late=async()=>{resolve();};void held.then(()=>profileEmailSearchPhase('provider',async()=>{}));for(let i=0;i<600;i++)await profileEmailSearchPhase('provider',async()=>{});});
 assert.equal(reports[0].overflow,true);assert.equal(reports[0].intervals.length,512);await late();await Promise.resolve();assert.equal(reports[0].intervals.length,512);
 const recurse=(n:number):Promise<void>=>profileEmailSearchPhase('search',async()=>{if(n)await recurse(n-1);});await c.run('a',()=>recurse(30));assert.equal(reports[1].intervals.length,16);assert.equal(reports[1].overflow,true);
});
