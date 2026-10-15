import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { buildExperienceBootstrapSrcdoc } from './app-experience-bootstrap-srcdoc';
import { EXPERIENCE_BOOTSTRAP_SCRIPT } from './app-experience-bootstrap-script';
import nextConfig from '../../next.config';

test('srcdoc embeds canonical script with exact hash, restrictive policy and trusted origin',async()=>{
 const html=await buildExperienceBootstrapSrcdoc('https://deft.test');
 const hash=createHash('sha256').update(EXPERIENCE_BOOTSTRAP_SCRIPT).digest('base64');
 assert.ok(html.includes(`<script>${EXPERIENCE_BOOTSTRAP_SCRIPT}</script>`));
 assert.ok(html.includes(`script-src 'sha256-${hash}'`));
 assert.ok(html.indexOf('http-equiv="Content-Security-Policy"')<html.indexOf('<script>'));
 assert.ok(html.includes('name="deft-experience-parent-origin" content="https://deft.test"'));
 assert.match(html,/connect-src 'none'/);assert.match(html,/worker-src blob:/);
 assert.doesNotMatch(html,/unsafe-inline|<script src=|allow-same-origin|frame-ancestors/);
 assert.doesNotMatch(EXPERIENCE_BOOTSTRAP_SCRIPT,/<\/script/i);
 for(const origin of ['null','data:text/html,x','https://deft.test/path','https://deft.test/','https://deft.test"<script>'])await assert.rejects(buildExperienceBootstrapSrcdoc(origin));
});

test('global parent policy permits Blob Workers across SPA entry while retaining other directives',async()=>{
 const headers=await nextConfig.headers!();
 const policy=(path:string)=>headers.find(row=>row.source===path)!.headers.find(row=>row.key==='Content-Security-Policy')!.value;
 const parent=policy('/(.*)');
 assert.match(parent,/worker-src 'self' blob:/);assert.match(parent,/frame-ancestors 'none'/);
 assert.equal(parent.replace("worker-src 'self' blob:; ",''),[
  "default-src 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com", `connect-src 'self' ws: wss: ${process.env.NEXT_PUBLIC_API_URL||'http://localhost:3001'} https:`,
  "media-src 'self' blob:", "frame-ancestors 'none'",
 ].join('; '));
 assert.match(policy('/app-experience-bootstrap'),/script-src 'self'/);assert.match(policy('/app-experience-bootstrap'),/connect-src 'none'/);
});

test('srcdoc trusted bootstrap pins parent origin, exact envelope and one port before one Worker',()=>{
 let handler:(event:unknown)=>void=()=>{},workers=0,terminated=0,closed=0;
 const messages:{data:Record<string,unknown>;origin:string}[]=[],parent={postMessage(data:Record<string,unknown>,origin:string){messages.push({data,origin});}};
 const context=vm.createContext({parent,document:{querySelector(){return{content:'https://deft.test'};}},location:{href:'about:srcdoc'},addEventListener(_kind:string,cb:typeof handler){handler=cb;},
  URL:class extends URL{static createObjectURL(){return'blob:synthetic';}static revokeObjectURL(){}},Blob:class{},Worker:class{constructor(){workers++;}postMessage(){}terminate(){terminated++;}}});
 vm.runInContext(EXPERIENCE_BOOTSTRAP_SCRIPT,context);assert.deepEqual(messages.map(row=>row.origin),['https://deft.test']);
 const session_id='11111111-1111-4111-8111-111111111111',port={close(){closed++;}};
 const valid={source:parent,origin:'https://deft.test',data:{kind:'start',session_id,worker_source:'synthetic'},ports:[port]};
 for(const patch of [{source:{}},{origin:'https://foreign.test'},{ports:[]},{ports:[port,port]},{data:{...valid.data,extra:true}}])handler({...valid,...patch});
 assert.equal(workers,0);handler(valid);handler(valid);assert.equal(workers,1);
 handler({source:parent,origin:'https://foreign.test',data:{kind:'stop',session_id},ports:[]});assert.equal(terminated,0);
 handler({source:parent,origin:'https://deft.test',data:{kind:'stop',session_id},ports:[]});assert.equal(terminated,1);assert.equal(closed,1);
});
