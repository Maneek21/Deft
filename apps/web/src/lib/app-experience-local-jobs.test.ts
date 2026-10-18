import assert from 'node:assert/strict';
import test from 'node:test';
import {canonicalAppDataJson} from '../../../../packages/app-kit/src/app-data-json';
import {createExperienceLocalJobHost} from './app-experience-local-jobs';
import type {ExperienceNode} from './app-experience-bridge';

// Native details owns visibility; this seam checks retained DOM and mutation delivery.
class Element {
 children:Element[]=[];attributes=new Map<string,string>();listeners=new Map<string,(()=>void)[]>();
 textContent='';className='';value='';type='';disabled=false;open=false;maxLength=0;step='';
 constructor(readonly tag:string){}
 append(...children:Element[]){this.children.push(...children);}
 replaceChildren(...children:Element[]){this.children=children;}
 setAttribute(key:string,value:string){this.attributes.set(key,value);}
 addEventListener(key:string,callback:()=>void){this.listeners.set(key,[...this.listeners.get(key)??[],callback]);}
 fire(key:string){if(key==='click'&&this.disabled)return;this.listeners.get(key)?.forEach(callback=>callback());}
 all():Element[]{return this.children.flatMap(child=>[child,...child.all()]);}
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const id='11111111-1111-4111-8111-111111111111',hash='sha256:'+'a'.repeat(64);
type Options=Parameters<typeof createExperienceLocalJobHost>[0];
const node:Extract<ExperienceNode,{kind:'local_job_schedule'}>={kind:'local_job_schedule',id:'reminder',label:'Follow up',
 store_key:'timers',operation_key:'remind',resource:{resource_key:'messages',record_id:id,content_digest:hash},
 profile:{schema_version:'deft.local_job_form.v1',note_field:'note',note_label:'Optional note',max_note_characters:2048}};

test('local job disclosure retains reviewed input and recovers the original request across close/reopen',async(t)=>{
 const saved=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.assign(globalThis,{document:{createElement:(tag:string)=>new Element(tag)}});
 // Hold the actual digest to prove scheduling is asynchronous, rather than
 // assuming crypto.subtle finishes within a single timer tick on every runner.
 const nativeDigest=crypto.subtle.digest.bind(crypto.subtle);
 let releaseDigest!:()=>void;const digestGate=new Promise<void>(resolve=>{releaseDigest=resolve;});
 t.mock.method(crypto.subtle,'digest',async(...args:Parameters<SubtleCrypto['digest']>)=>{await digestGate;return nativeDigest(...args);});
 const expires=new Date(Date.now()+86400000).toISOString();
 const target={session_id:id,target_key:'work',resource_key:'messages',account:{account_ref:id,label:'Work'},
  stores:[{declaration:{key:'timers',local_job_operations:[{key:'remind',local_only:true}]},consent:{expires_at:expires}}]} as unknown as Awaited<ReturnType<Options['select']>>;
 const requests:Array<{operation:string;input:Record<string,any>}>=[],events:unknown[]=[];
 const host=createExperienceLocalJobHost({select:async()=>target,current:()=>true,fetch:async(path,options)=>{
  const operation=path.split('/').at(-1)!,input=JSON.parse(String(options.body));requests.push({operation,input});
  if(operation==='schedule')throw Error('Lost response');
  assert.equal(operation,'status');const original=requests[0].input;
  assert.equal(input.job_id,original.job_id);assert.equal(input.request_id,original.request_id);
  const digest='sha256:'+Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalAppDataJson({operation,input})))).toString('hex');
  return Response.json({schema_version:'deft.app_local_job_interactive_result.v1',request_id:input.request_id,operation,input_digest:digest,
   state:'completed',job_state:'scheduled',job:{job_id:original.job_id,revision:1,job_digest:hash,account_ref:id,custody_generation:1,
    due_at:original.due_at,expires_at:original.expires_at}});
 }});
 const wrapper=new Element('section');let dispose:(()=>void)|undefined;
 try{
  dispose=host.mountLocalJobControl(node,wrapper as unknown as HTMLElement,event=>events.push(event),{signal:new AbortController().signal,current:()=>true});
  await tick();const panel=wrapper.children[0],summary=panel.children[0];
  assert.equal(panel.tag,'details');assert.equal(panel.open,false);assert.equal(summary.tag,'summary');assert.equal(summary.textContent,node.label);
  const fields=panel.all().filter(element=>['input','textarea','select'].includes(element.tag)),[date,zone,ambiguity,note]=fields;
  panel.open=true;date.value=new Date(Date.now()+3600000).toISOString().slice(0,16);zone.value='UTC';ambiguity.value='reject';note.value='Keep this reviewed note';
  panel.open=false;panel.fire('toggle');panel.open=true;panel.fire('toggle');
  assert.deepEqual(panel.all().filter(element=>['input','textarea','select'].includes(element.tag)),fields);
  assert.equal(note.value,'Keep this reviewed note');assert.equal(requests.length,0);assert.equal(events.length,0);
  const schedule=panel.all().find(element=>element.textContent==='Schedule')!,recover=panel.all().find(element=>element.textContent==='Check original request status')!;
  schedule.fire('click');await tick();assert.equal(schedule.disabled,true);assert.equal(requests.length,0,'No dispatch before its input digest is ready');
  releaseDigest();for(let tries=0;schedule.disabled&&tries<100;tries++)await tick();
  assert.equal(schedule.disabled,false);assert.equal(requests.length,1);assert.equal(requests[0].input.value.note,note.value);
  assert.equal(summary.textContent,'Follow up · Check status');
  const notice=panel.all().find(element=>element.attributes.get('role')==='status')!;
  assert.match(notice.textContent,/Not confirmed/);
  panel.open=false;panel.fire('toggle');panel.open=true;panel.fire('toggle');
  assert.equal(note.value,'Keep this reviewed note');assert.match(notice.textContent,/Not confirmed/);assert.equal(requests.length,1);
  schedule.fire('click');await tick();assert.equal(requests.length,1,'An unconfirmed request cannot be replaced');
  recover.fire('click');for(let tries=0;recover.disabled&&tries<100;tries++)await tick();assert.equal(recover.disabled,false);
  assert.deepEqual(requests.map(request=>request.operation),['schedule','status']);assert.equal(summary.textContent,node.label);
  assert.match(notice.textContent,/Original request confirmed: scheduled/);assert.deepEqual(events,[{kind:'click',node_id:node.id,value:'recovered'}]);
  assert.equal(note.value,'Keep this reviewed note');
 }finally{releaseDigest();dispose?.();if(saved)Object.defineProperty(globalThis,'document',saved);else Reflect.deleteProperty(globalThis,'document');}
});
