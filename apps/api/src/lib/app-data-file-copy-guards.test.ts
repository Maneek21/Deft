import test from 'node:test';import assert from 'node:assert/strict';import {appDataSourceWithinStore,appDataRecordSourcesWithinStore} from './app-data-file-copy-guards.js';
const store={resource_content:{max_source_bytes:36700160}} as any,source={resource_key:'inbox',record_id:'own',content_digest:'digest'};
test('actual host nested source guards reject another resource and declarations without source access',()=>{const copy={operation:'file_copy',input:{source}} as any;assert.equal(appDataSourceWithinStore(copy,'inbox',store),true);assert.equal(appDataSourceWithinStore(copy,'foreign',store),false);assert.equal(appDataSourceWithinStore(copy,'inbox',{} as any),false);assert.equal(appDataSourceWithinStore({operation:'record_create',input:{source_refs:[source]}} as any,'foreign',store),false);});
test('runtime-returned authoritative source metadata is withheld outside exact reviewed resource',()=>{assert.equal(appDataRecordSourcesWithinStore({source_refs:[source]} as any,'inbox',store),true);assert.equal(appDataRecordSourcesWithinStore({source_refs:[source]} as any,'foreign',store),false);assert.equal(appDataRecordSourcesWithinStore({source_refs:[source]} as any,'inbox',{} as any),false);assert.equal(appDataRecordSourcesWithinStore({},'inbox',{} as any),true);});


test('file_copy shares real owner file-transfer admission and retains its slots until work unwinds',async()=>{
 const {withAppDataBinaryIo}=await import('./app-data-io-limits.js');const owner={org_id:'org',user_id:'owner'};const releases:Array<()=>void>=[];
 const hold=()=>withAppDataBinaryIo(owner,'file_copy',async()=>new Promise<void>(resolve=>releases.push(resolve)));
 const a=hold(),b=hold();await assert.rejects(withAppDataBinaryIo(owner,'file_upload',async()=>{}),/busy/);
 await withAppDataBinaryIo({org_id:'org',user_id:'other'},'file_copy',async()=>{});releases.forEach(release=>release());await Promise.all([a,b]);await withAppDataBinaryIo(owner,'file_copy',async()=>{});
});
