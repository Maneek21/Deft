import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('generic connection contracts cold-load while every native mailbox module is forbidden',()=>{
 const target=new URL('../src/lib/app-connection-contract.ts',import.meta.url).href;
 const connectionService=new URL('../src/lib/app-connection-service.ts',import.meta.url).href;
 const loader=`export async function resolve(s,c,next){if(/(?:^|\\/)email-[^/]+\\.(?:js|ts)$/.test(s))throw Error('NATIVE_MAILBOX_IMPORT_FORBIDDEN');return next(s,c);}`;
 const source=`import {register} from 'node:module';register('data:text/javascript,'+encodeURIComponent(${JSON.stringify(loader)}));const c=await import(${JSON.stringify(target)});await import(${JSON.stringify(connectionService)});if(Object.keys(c).some(k=>k.startsWith('NativeEmail')))throw Error('NATIVE_SURFACE_LEAK');const pins={org_id:'00000000-0000-4000-8000-000000000001',owner_user_id:'00000000-0000-4000-8000-000000000002',installation_id:'00000000-0000-4000-8000-000000000003',app_version_id:'00000000-0000-4000-8000-000000000004',grant_snapshot_id:'00000000-0000-4000-8000-000000000005',target_key:'records',resource_key:'documents',resource_binding_id:'00000000-0000-4000-8000-000000000006',action_key:null,action_binding_id:null};c.AppConnectionPinsSchema.parse(pins);if(c.AppConnectionPinsSchema.safeParse({...pins,action_key:'publish'}).success)throw Error('ACTION_PAIR_FENCE_LOST');console.log('GENERIC_CONNECTION_OK');`;
 const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',source],{encoding:'utf8',timeout:20000});
 assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/GENERIC_CONNECTION_OK/);
});


test('API route inventory contains historical adoption reads but no native mailbox product mount',async()=>{
 const [{readFile},ts]=await Promise.all([import('node:fs/promises'),import('typescript')]);
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8');
 const ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
 const mounts:string[]=[],imports:string[]=[];
 function visit(node:import('typescript').Node){
  if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier))imports.push(node.moduleSpecifier.text);
  if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&['route','get','post','put','patch','delete','all'].includes(node.expression.name.text)&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0]))mounts.push(node.arguments[0].text);
  ts.forEachChild(node,visit);
 }
 visit(ast);
 assert.ok(mounts.includes('/api/email-adoption'),'retained owner-only adoption reader must survive retirement');
 assert.equal(mounts.some(path=>path==='/api/email'||path.startsWith('/api/email/')),false);
 assert.deepEqual(imports.filter(path=>/(?:routes|lib)\/email-/.test(path)),['./routes/email-native-adoption-source.js']);
 assert.equal(source.includes('DEFT_NATIVE_EMAIL_ENABLED'),false,'former flag cannot remount a retired execution route');
});
