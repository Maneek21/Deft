import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { EXPERIENCE_BOOTSTRAP_SCRIPT } from './app-experience-bootstrap-script.ts';

const require=createRequire(import.meta.url),{chromium}=require('playwright'),{build}=require('esbuild');
const fixture=new URL('../../../../scripts/gate-g/experiences/',import.meta.url);

// Separate explicit CI entry: requires the locked Chromium install, never skips.
test('actual srcdoc and HTTP control retain opaque Worker isolation under the real global parent policy', {timeout:60000},async()=>{
 const observations={worker_hits:[],parent_controls:[]};let bundle='',parentPolicy='';
 const headersSource=readFileSync(new URL('../../next.config.ts',import.meta.url),'utf8');
 const ast=ts.createSourceFile('next.config.ts',headersSource,ts.ScriptTarget.Latest,true);let method;
 const visit=node=>{if(ts.isMethodDeclaration(node)&&node.name.getText(ast)==='headers')method=node.getText(ast);ts.forEachChild(node,visit);};visit(ast);
 assert.ok(method);
 let childPolicy='';
 const servers=[];
 const handler=(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');let body,type='application/javascript',policy=parentPolicy;
  if(url.pathname==='/sink'){
   observations[url.searchParams.get('control')==='parent'?'parent_controls':'worker_hits'].push({port:req.socket.localPort,run:url.searchParams.get('run')});
   res.setHeader('Access-Control-Allow-Origin','*');body='/* synthetic sink */';
  }else if(url.pathname==='/observations'){type='application/json';body=JSON.stringify(observations);}
  else if(url.pathname==='/'){type='text/html';body='<!doctype html><meta charset="utf-8"><button>Start</button><pre></pre><script src="/bundle.js" defer></script>';}
  else if(url.pathname==='/bundle.js')body=bundle;
  else if(url.pathname==='/author-worker.js')body=readFileSync(new URL('srcdoc-author-worker.js',fixture));
  else if(url.pathname==='/app-experience-bootstrap.js')body=EXPERIENCE_BOOTSTRAP_SCRIPT;
  else if(url.pathname==='/app-experience-bootstrap'){type='text/html';policy=childPolicy;body='<!doctype html><meta charset="utf-8"><script src="/app-experience-bootstrap.js" defer></script>';}
  else{res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':policy,'X-Frame-Options':url.pathname==='/app-experience-bootstrap'?'SAMEORIGIN':'DENY','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(body);
 };
 const listen=async()=>{const server=createServer(handler);servers.push(server);server.on('upgrade',(req,socket)=>{observations.worker_hits.push({port:req.socket.localPort,upgrade:true});socket.destroy();});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return'http://127.0.0.1:'+server.address().port;};
 let browser;
 try{
  const host=await listen(),foreign=await listen();
  const rows=await vm.runInNewContext('('+method.replace('async headers()','async function()')+')()',{apiOrigin:foreign});
  parentPolicy=rows.find(row=>row.source==='/(.*)').headers.find(row=>row.key==='Content-Security-Policy').value;
  childPolicy=rows.find(row=>row.source==='/app-experience-bootstrap').headers.find(row=>row.key==='Content-Security-Policy').value;
  assert.ok(parentPolicy.includes("worker-src 'self' blob:"));
  const compiled=await build({entryPoints:[fileURLToPath(new URL('srcdoc-host.ts',fixture))],bundle:true,write:false,platform:'browser',format:'iife',define:{__HARNESS_API_ORIGIN__:JSON.stringify(foreign)}});bundle=compiled.outputFiles[0].text;
  browser=await chromium.launch({headless:true,...(process.env.DEFT_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.DEFT_TEST_BROWSER_EXECUTABLE}:{})});
  for(const mode of ['http','srcdoc']){
   const context=await browser.newContext(),page=await context.newPage();
   try{
    await page.goto(host+'/?mode='+mode);await page.getByRole('button',{name:'Start',exact:true}).click();
    await page.waitForFunction(()=>{try{return['PASS','FAIL'].includes(JSON.parse(document.querySelector('pre').textContent).state);}catch{return false;}},{},{timeout:20000});
    const report=JSON.parse(await page.locator('pre').textContent());
    assert.equal(report.pass,true,JSON.stringify({mode,report}));assert.equal(report.frames_removed,true);
    assert.equal(report.sink_hits.length,0);assert.equal(report.parent_controls_reached.length,2);
   }finally{await context.close();}
  }
 }finally{
  await browser?.close();
  await Promise.all(servers.map(server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})));
 }
});
