import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
const ring=(id:string)=>({current:id,keys:{[id]:createHash('sha256').update('synthetic-data-contract-'+id).digest('base64')}});
process.env.DEFT_APP_RUN_KEYRINGS=JSON.stringify({schema_version:'deft.app_run_keyring.v1',run_encryption:ring('enc'),receipt_signing:ring('sign'),fingerprint:ring('fingerprint')});

test('valid native-size record requests reach current authority; malformed operation input cannot',async()=>{
 const {AppDataService}=await import('../src/lib/app-data-service.js'),{AppError}=await import('../src/lib/app-errors.js');
 let checks=0;
 class DeniedService extends AppDataService{override async current():ReturnType<AppDataService['current']>{checks++;throw new AppError('Synthetic consent absent','APP_ACCESS_DENIED',403);}}
 const service=new DeniedService({org_id:randomUUID(),user_id:randomUUID(),sid:randomUUID(),access_expires_at:Date.now()+60000},async()=>{});
 const body='x'.repeat(240000),value={mode:'compose',to:'recipient@example.test',cc:'',bcc:'',subject:'Synthetic draft',body,body_html:'<p>'+body+'</p>',reply_record_id:'',attachments:[]};
 const request={schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation:'record_create',input:{store_key:'drafts',record_id:randomUUID(),value}};
 assert.ok(Buffer.byteLength(JSON.stringify(value))>470000&&Buffer.byteLength(JSON.stringify(value))<=491520);
 await assert.rejects(service.invoke(randomUUID(),request),error=>error instanceof AppError&&error.code==='APP_ACCESS_DENIED'&&error.status===403);
 assert.equal(checks,1,'strict operation schema sees its two-field input, not the outer request envelope');
 await assert.rejects(service.invoke(randomUUID(),{...request,input:{...request.input,unknown:true}}));
 assert.equal(checks,1,'unknown operation fields reject before authority/storage/IO');
});
