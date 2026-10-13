import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperienceDataClient,appDataInputDigest} from './app-experience-data-client';
import {frameAppData,APP_DATA_FRAME_MEDIA_TYPE} from '../../../../packages/app-kit/src/app-data';
import {mountExperienceDataSourceFiles} from './app-experience-data-source-files';

class Element {
  children:Element[]=[];attrs=new Map<string,string>();parent:Element|null=null;
  textContent='';className='';type='';title='';src='';href='';download='';target='';rel='';alt='';disabled=false;
  onclick:((event:{preventDefault:()=>void})=>unknown)|null=null;
  constructor(readonly tag:string){}
  append(...children:Element[]){for(const child of children){child.parent=this;this.children.push(child);}}
  setAttribute(name:string,value:string){this.attrs.set(name,value);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;}
  click(){void this.onclick?.({preventDefault(){}});}
  find(predicate:(value:Element)=>boolean):Element|undefined{return predicate(this)?this:this.children.map(child=>child.find(predicate)).find(Boolean);}
}

async function fixture(current=()=>true){
  const documentBefore=globalThis.document,createBefore=URL.createObjectURL,revokeBefore=URL.revokeObjectURL;
  const created:Blob[]=[],revoked:string[]=[];const wrapper=new Element('div');
  globalThis.document={createElement:(tag:string)=>new Element(tag)} as unknown as Document;
  URL.createObjectURL=blob=>{assert.ok(blob instanceof Blob);created.push(blob);return `blob:https://deft.test/${created.length}`;};URL.revokeObjectURL=url=>{revoked.push(url);};
  const file={file_ref:'sha256:'+'1'.repeat(64),filename:'synthetic-brief.pdf',media_type:'application/pdf',size_bytes:8,disposition:'attachment' as const,preview:'pdf' as const};
  const bytes=new TextEncoder().encode('%PDF-1.7');let reads=0;
  const dispose=mountExperienceDataSourceFiles({wrapper:wrapper as unknown as HTMLElement,signal:new AbortController().signal,current,
    list:async()=>[file],read:async()=>{reads++;return{bytes:new Uint8Array(bytes),media_type:file.media_type,filename:file.filename};},source:async()=>({bytes:new Uint8Array(),media_type:'message/rfc822',filename:'message.eml'})});
  await Promise.resolve();
  return {wrapper,created,revoked,reads:()=>reads,dispose,restore:()=>{dispose();globalThis.document=documentBefore;URL.createObjectURL=createBefore;URL.revokeObjectURL=revokeBefore;}};
}

test('trusted PDF Preview uses a scoped user-activated browser viewer link rather than the blocked sandbox plugin iframe',async()=>{
  const f=await fixture();try{
    const preview=f.wrapper.find(value=>value.attrs.get('aria-label')==='Preview synthetic-brief.pdf');assert.ok(preview);await preview.onclick!({preventDefault(){}});
    assert.equal(f.reads(),1);assert.equal(f.created.length,1);assert.equal(f.created[0]!.type,'application/pdf');assert.equal(await f.created[0]!.text(),'%PDF-1.7');
    assert.equal(f.wrapper.find(value=>value.tag==='iframe'),undefined,'Chrome blocks its PDF plugin in the empty-sandbox frame');
    const link=f.wrapper.find(value=>value.tag==='a'&&value.textContent==='Open PDF preview');assert.ok(link);assert.equal(link.href,'blob:https://deft.test/1');assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');
    assert.ok(f.wrapper.find(value=>value.textContent.includes('Download')));f.dispose();assert.deepEqual(f.revoked,['blob:https://deft.test/1']);
  }finally{f.restore();}
});

test('expired or disposed source scope cannot open a previously created PDF viewer URL',async()=>{
  let current=true;const f=await fixture(()=>current);try{
    await f.wrapper.find(value=>value.attrs.get('aria-label')==='Preview synthetic-brief.pdf')!.onclick!({preventDefault(){}});
    const link=f.wrapper.find(value=>value.tag==='a'&&value.textContent==='Open PDF preview');assert.ok(link);
    let prevented=false;current=false;link.onclick!({preventDefault(){prevented=true;}});assert.equal(prevented,true);
    f.dispose();assert.deepEqual(f.revoked,['blob:https://deft.test/1']);
  }finally{f.restore();}
});
test('actual scoped public source and attachment ports download original/ZIP and exclude inline parts from received archive',async()=>{
 const before=globalThis.document,create=URL.createObjectURL,revoke=URL.revokeObjectURL,wrapper=new Element('div'),blobs:Blob[]=[],revoked:string[]=[],operations:string[]=[];
 globalThis.document={createElement:(tag:string)=>new Element(tag)} as unknown as Document;URL.createObjectURL=blob=>{blobs.push(blob as Blob);return `blob:${blobs.length}`;};URL.revokeObjectURL=url=>revoked.push(url);
 const id='11111111-1111-4111-8111-111111111111',connection='22222222-2222-4222-8222-222222222222',installation='33333333-3333-4333-8333-333333333333',digest='sha256:'+'a'.repeat(64),input={store_key:'drafts',resource_key:'inbox',record_id:id,content_digest:digest};
 const attachment={file_ref:'sha256:'+'b'.repeat(64),filename:'synthetic.txt',media_type:'text/plain',size_bytes:5,disposition:'attachment' as const,preview:'text' as const},inline={...attachment,file_ref:'sha256:'+'c'.repeat(64),filename:'inline.png',media_type:'image/png',disposition:'inline' as const,preview:'image' as const};let live=true;
 const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',current:()=>live,fetch:async(path,options)=>{
  if((path.endsWith('/context')||path.endsWith('/resolve')))return new Response(JSON.stringify({schema_version:'deft.app_data_context.v1',installation_id:installation,targets:[{session_id:connection,target_key:'mailbox',account:{account_ref:id,label:'Synthetic'},resource_key:'inbox',identities:[],stores:[{declaration:{schema_version:'deft.app_record_store.v1',key:'drafts',resource_key:'inbox',runtime_requirement_key:'sync_provider',max_record_bytes:491520,max_files:32,max_file_bytes:26214400,max_total_file_bytes:26214400},consent:{consent_id:id,consent_digest:digest,expires_at:new Date(Date.now()+60000).toISOString()}}]}]}),{headers:{'content-type':'application/json'}});
  assert.equal(path,`/api/app-data/connections/${connection}/requests`);const request=JSON.parse(String(options.body));operations.push(request.operation);assert.equal(request.input.record_id,id);assert.equal(request.input.content_digest,digest);
  if(request.operation==='resource_list_files')return new Response(JSON.stringify({schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed',files:[attachment,inline]}),{headers:{'content-type':'application/json'}});
  const source=request.operation==='resource_read_source',bytes=new TextEncoder().encode(source?'Subject: Synthetic\r\n\r\nExact source\r\n':'hello');if(!source)assert.equal(request.input.file_ref,attachment.file_ref);
  const sha='sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');return new Response(new Uint8Array(frameAppData({schema_version:'deft.app_data_binary.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),record_id:id,sha256:sha,size_bytes:bytes.length,media_type:source?'message/rfc822':attachment.media_type,filename:source?'message.eml':attachment.filename},bytes)).buffer,{headers:{'content-type':APP_DATA_FRAME_MEDIA_TYPE}});
 }});
 const dispose=mountExperienceDataSourceFiles({wrapper:wrapper as unknown as HTMLElement,signal:new AbortController().signal,current:()=>live,list:async signal=>(await client.request('drafts','resource_list_files',input,signal)).files??[],read:(file,signal)=>client.binary('drafts','resource_read_file',{...input,file_ref:file.file_ref},signal),source:signal=>client.binary('drafts','resource_read_source',input,signal)});
 try{for(let i=0;i<8&&!wrapper.find(n=>n.textContent==='Download listed attachments (.zip)');i++)await new Promise(resolve=>setImmediate(resolve));
  await wrapper.find(n=>n.textContent==='Download original')!.onclick!({preventDefault(){}});assert.equal(await blobs[0].text(),'Subject: Synthetic\r\n\r\nExact source\r\n');assert.equal(blobs[0].type,'message/rfc822');
  await wrapper.find(n=>n.textContent==='Download listed attachments (.zip)')!.onclick!({preventDefault(){}});assert.equal(blobs[1].type,'application/zip');assert.deepEqual(operations,['resource_list_files','resource_read_source','resource_read_file']);assert.equal(revoked.length,2);
  live=false;await wrapper.find(n=>n.textContent==='Download original')!.onclick!({preventDefault(){}});assert.equal(operations.length,3);
 }finally{dispose();globalThis.document=before;URL.createObjectURL=create;URL.revokeObjectURL=revoke;}
});
