import test from 'node:test';
import assert from 'node:assert/strict';
import {mountExperienceSourcePresentation} from './app-experience-source-presentation';
import {api} from './api';
import {createExperiencePresentationElement,type ExperiencePresentationImageState} from './app-experience-safe-document';
import type {SourcePresentation} from './app-experience-source-view';
import {parseSourceView} from './app-experience-source-view';
class E{children:E[]=[];parent:E|null=null;style:Record<string,string>={};attributes:Record<string,string>={};className='';textContent='';isConnected=true;type='';disabled=false;onclick:(()=>Promise<void>)|null=null;append(...nodes:E[]){for(const n of nodes){n.remove();n.parent=this;this.children.push(n);}}prepend(...nodes:E[]){for(const n of [...nodes].reverse()){n.remove();n.parent=this;this.children.unshift(n);}}remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=null;}replaceWith(n:E){const p=this.parent;if(p){const i=p.children.indexOf(this);p.children[i]=n;n.parent=p;this.parent=null;}}querySelector(query:string):E|null{return this.children.find(n=>query==='.ex-safe-document'&&n.className==='ex-safe-document')??null;}querySelectorAll(){return [];}setAttribute(key:string,value:string){this.attributes[key]=value;}removeAttribute(key:string){delete this.attributes[key];}}
const descendants=(element:E):E[]=>element.children.flatMap(child=>[child,...descendants(child)]);
const doc={hidden:false,documentElement:new E(),createElement:()=>new E(),addEventListener(){},removeEventListener(){},createTextNode:(value:string)=>Object.assign(new E(),{textContent:value})};
const originalDocument=globalThis.document,originalObserver=globalThis.MutationObserver;
const scope={exposure_id:'fixture-exposure',exposure_epoch:1};
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
function fixture(presentation:SourcePresentation,load?:Parameters<typeof mountExperienceSourcePresentation>[0]['load'],current=()=>true,extra:Partial<Parameters<typeof mountExperienceSourcePresentation>[0]>={}){
 Object.assign(globalThis,{document:doc,MutationObserver:class{observe(){}disconnect(){}}});const wrap=new E();wrap.append(Object.assign(new E(),{className:'ex-safe-document',textContent:'Loaded text'}));
 const mount=mountExperienceSourcePresentation({wrap:wrap as unknown as HTMLElement,node:{kind:'document',id:'message',format:'plain',content:'Loaded text'},scope,sessionId:'session',resourceKey:'inbox',recordId:'record',current,load:load??(async()=>({presentation,expires_at:new Date(Date.now()+60000).toISOString()})),...extra});return{wrap,mount};
}
const p=(images:SourcePresentation['images']=[]):SourcePresentation=>({format:'plain',content:'Source text',plain_text:'Source text',truncated:true,images,headers:[]});

test('record presentation uses only renewed matching authority and the earlier session deadline',async()=>{
 const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;const revoked:string[]=[];URL.createObjectURL=()=> 'blob:renewed';URL.revokeObjectURL=value=>{revoked.push(value);};
 const pinned={...scope,review_digest:'review-a'};let lease={exposure:{...pinned,expires_at:new Date(Date.now()+35).toISOString()},session_expires_at:new Date(Date.now()+35).toISOString()};
 let release!:(value:{bytes:Uint8Array;media_type:string})=>void;
 const f=fixture(p([{image_ref:'a'.repeat(64),kind:'cid',index:0,alt:''}]),async()=>({presentation:p([{image_ref:'a'.repeat(64),kind:'cid',index:0,alt:''}]),expires_at:lease.exposure.expires_at}),()=>true,{scope:pinned,authorizedLifetime:()=>lease,readBinary:async()=>new Promise(resolve=>{release=resolve;})});
 try{await flush();lease={exposure:{...pinned,expires_at:new Date(Date.now()+1000).toISOString()},session_expires_at:new Date(Date.now()+160).toISOString()};await new Promise(resolve=>setTimeout(resolve,55));assert.ok(!descendants(f.wrap).some(n=>n.textContent.includes('access expired')),'fresh same-scope lease must survive original expiry');release({bytes:new Uint8Array([1]),media_type:'image/png'});await flush();assert.equal(revoked.length,0);await new Promise(resolve=>setTimeout(resolve,170));assert.ok(descendants(f.wrap).some(n=>n.textContent.includes('access expired')));assert.deepEqual(revoked,['blob:renewed']);}finally{f.mount();URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;}
});
test('unrenewed, revoked or changed authority cannot extend source presentation',async()=>{
 for(const change of ['none','identity','digest','epoch','current','expired'] as const){
  const pinned={...scope,review_digest:'review-a'};let allowed=true;let lease={exposure:{...pinned,expires_at:new Date(Date.now()+25).toISOString()},session_expires_at:new Date(Date.now()+25).toISOString()};
  const f=fixture(p(),async()=>({presentation:p(),expires_at:lease.exposure.expires_at}),()=>allowed,{scope:pinned,authorizedLifetime:()=>lease});
  try{await flush();if(change!=='none')lease={exposure:{...pinned,exposure_id:change==='identity'?'foreign':pinned.exposure_id,review_digest:change==='digest'?'review-b':'review-a',exposure_epoch:change==='epoch'?2:1,expires_at:new Date(Date.now()+1000).toISOString()},session_expires_at:new Date(Date.now()+(change==='expired'?-1:1000)).toISOString()};if(change==='current')allowed=false;await new Promise(resolve=>setTimeout(resolve,45));assert.ok(descendants(f.wrap).some(n=>n.textContent.includes('access expired')),change);}finally{f.mount();}
 }
 const f=fixture(p(),async()=>({presentation:p(),expires_at:new Date(Date.now()+20).toISOString()}));try{await flush();await new Promise(resolve=>setTimeout(resolve,35));assert.ok(descendants(f.wrap).some(n=>n.textContent.includes('access expired')));}finally{f.mount();}
});

test('saved always choice automatically uses guarded image request; ask remains explicit and revoked late presentation cannot fetch',async()=>{
 const originalFetch=api.fetch;let calls=0;api.fetch=async()=>{calls++;throw Error('Unavailable');};
 const presentation={...p([{image_ref:'a'.repeat(64),kind:'remote',index:0,alt:''}]),external_images:'always' as const};
 const f=fixture(presentation);try{await flush();assert.equal(calls,1);assert.ok(descendants(f.wrap).some(n=>n.textContent==='Retry external images'));}finally{f.mount();}
 const g=fixture({...presentation,external_images:'ask'});try{await flush();assert.equal(calls,1);assert.ok(descendants(g.wrap).some(n=>n.textContent==='Load external images'));}finally{g.mount();}
 let allowed=true,done!:(value:{presentation:SourcePresentation;expires_at:string})=>void;
 const held=fixture(presentation,async()=>new Promise(resolve=>{done=resolve;}),()=>allowed);try{allowed=false;done({presentation,expires_at:new Date(Date.now()+60000).toISOString()});await flush();assert.equal(calls,1);}finally{held.mount();api.fetch=originalFetch;}
 const raw={...scope,expires_at:new Date(Date.now()+60000).toISOString(),presentation};assert.equal(parseSourceView(raw,scope).presentation?.external_images,'always');
 assert.throws(()=>parseSourceView({...raw,presentation:{...presentation,external_images:'unreviewed'}},scope));
});
test('image placeholders distinguish the loading choice, fetch failure, unsupported format and limit',()=>{
 Object.assign(globalThis,{document:doc});const originalCreate=doc.createElement;const ref='a'.repeat(64);
 try{for(const [state,text] of [[undefined,'blocked until'],['loading','Image loading'],['unavailable','could not be loaded'],['unsupported','format is unsupported'],['limit','limit reached']] as const){
  const slot=Object.assign(new E(),{textContent:'Photo',getAttribute:()=>ref});const wrapper=Object.assign(new E(),{querySelectorAll:(query:string)=>query==='[data-deft-image]'?[slot]:[]});doc.createElement=()=>wrapper;
  createExperiencePresentationElement(p(),[{image_ref:ref,kind:'remote',alt:''}],new Map(),new Map<string,ExperiencePresentationImageState>(state?[[ref,state]]:[]));assert.ok((slot.attributes['aria-label']??'').includes(text),slot.attributes['aria-label']);assert.ok(slot.textContent.length<70);assert.equal(slot.attributes.role,'img');
 }}finally{doc.createElement=originalCreate;}
});
test('empty CID queue preserves truncation and explicit remote-images-blocked notices',async()=>{
 const f=fixture(p([{image_ref:'a'.repeat(64),kind:'remote',index:0,alt:''}]));try{await flush();assert.ok(descendants(f.wrap).some(n=>n.textContent.includes('Only part')));assert.ok(descendants(f.wrap).some(n=>n.textContent.includes('blocked until')));}finally{f.mount();}
});
test('image controls precede the body and distinguish a failed fetch from the loading choice',async()=>{
 const originalFetch=api.fetch;let calls=0;api.fetch=async()=>{calls++;throw Error('unavailable');};
 const f=fixture(p([{image_ref:'a'.repeat(64),kind:'remote',index:0,alt:''}]));try{await flush();assert.equal(calls,0);const nodes=descendants(f.wrap);const button=nodes.find(n=>n.textContent==='Load external images')!;const body=f.wrap.querySelector('.ex-safe-document')!;assert.equal(f.wrap.children[0].className,'ex-message-notices');assert.ok(descendants(f.wrap.children[0]).includes(button));assert.ok(f.wrap.children.indexOf(body)>0);await button.onclick!();assert.equal(calls,1);assert.ok(descendants(f.wrap).some(n=>n.textContent.includes('could not be loaded')));assert.equal(button.textContent,'Retry external images');assert.equal(button.disabled,false);assert.equal(button.attributes['aria-busy'],undefined);assert.equal(button.attributes['aria-label'],'Retry external images for this message');assert.ok(nodes.some(n=>n.attributes.role==='status'&&n.attributes['aria-live']==='polite'));}finally{f.mount();api.fetch=originalFetch;}
});
test('embedded failure preserves the external loading choice and reports unsupported formats separately',async()=>{
 const originalFetch=api.fetch;let calls=0;api.fetch=async()=>{calls++;return new Response('<svg/>',{headers:{'content-type':'image/svg+xml','x-deft-exposure-id':scope.exposure_id,'x-deft-exposure-epoch':'1'}});};
 const f=fixture(p([{image_ref:'a'.repeat(64),kind:'remote',index:0,alt:''},{image_ref:'b'.repeat(64),kind:'cid',index:1,alt:''}]));try{await flush();assert.equal(calls,1);assert.ok(descendants(f.wrap).some(n=>n.textContent.includes('blocked until')));assert.ok(descendants(f.wrap).some(n=>n.textContent.includes('formats are unsupported')));const button=descendants(f.wrap).find(n=>n.textContent==='Load external images')!;await button.onclick!();assert.equal(calls,2);assert.ok(descendants(f.wrap).some(n=>n.textContent.includes('formats are unsupported')));assert.ok(!descendants(f.wrap).some(n=>n.textContent.includes('blocked until')));}finally{f.mount();api.fetch=originalFetch;}
});
test('a view rerender reattaches the same pending source read without aborting it',async()=>{
 let done!:(value:{presentation:SourcePresentation;expires_at:string})=>void;let signal:AbortSignal|undefined;const f=fixture(p(),async s=>{signal=s;return new Promise(resolve=>{done=resolve;});});try{const next=new E();next.append(Object.assign(new E(),{className:'ex-safe-document',textContent:'Loaded text'}));f.mount.attach(next as unknown as HTMLElement);assert.equal(signal?.aborted,false);done({presentation:p(),expires_at:new Date(Date.now()+60000).toISOString()});await flush();assert.ok(descendants(next).some(n=>n.textContent.includes('Only part')));assert.equal(next.children[0].className,'ex-message-notices');assert.equal(signal?.aborted,false);const third=new E();third.append(Object.assign(new E(),{className:'ex-safe-document',textContent:'Loaded text'}));f.mount.attach(third as unknown as HTMLElement);assert.equal(third.children[0].className,'ex-message-notices');assert.equal(third.children[1].textContent,'Source text');}finally{f.mount();}
});

test('a changed document or revoked scope cannot reattach an earlier source presentation',async()=>{
 let allowed=true;const f=fixture(p(),undefined,()=>allowed);try{await flush();assert.equal(f.wrap.querySelector('.ex-safe-document')?.textContent,'Source text');allowed=false;const next=new E();next.append(Object.assign(new E(),{className:'ex-safe-document',textContent:'New validated text'}));f.mount.attach(next as unknown as HTMLElement);assert.equal(next.querySelector('.ex-safe-document')?.textContent,'New validated text');assert.equal(next.children.length,1);}finally{f.mount();}
});

test('a source read held across scope revocation is discarded',async()=>{
 let allowed=true,done!:(value:{presentation:SourcePresentation;expires_at:string})=>void;const f=fixture(p(),async()=>new Promise(resolve=>{done=resolve;}),()=>allowed);try{allowed=false;done({presentation:p(),expires_at:new Date(Date.now()+60000).toISOString()});await flush();assert.equal(f.wrap.querySelector('.ex-safe-document')?.textContent,'Loaded text');assert.equal(descendants(f.wrap).some(n=>n.textContent==='Source text'),false);}finally{f.mount();}
});
test('actual image controller caps cumulative bytes and revokes all owned URLs on disposal',async()=>{
 const originalFetch=api.fetch,originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;let created=0,revoked=0,calls=0;
 api.fetch=async()=>{calls++;const bytes=new Uint8Array(2097152);return new Response(bytes,{headers:{'content-type':'image/png','content-length':String(bytes.length),'content-disposition':'attachment;','x-content-type-options':'nosniff','x-deft-exposure-id':scope.exposure_id,'x-deft-exposure-epoch':'1'}});};
 URL.createObjectURL=()=>`blob:fixture/${++created}`;URL.revokeObjectURL=()=>{revoked++;};
 const f=fixture(p(Array.from({length:8},(_,i)=>({image_ref:String(i).repeat(64),kind:'remote' as const,index:i,alt:''}))));try{await flush();const button=descendants(f.wrap).find(n=>n.textContent==='Load external images')!;await button.onclick!();assert.equal(created,4);assert.ok(calls<=6);assert.ok(descendants(f.wrap).some(n=>n.textContent.includes('8 MiB image limit')));assert.ok(descendants(f.wrap).some(n=>n.textContent.includes('Only part')));f.mount();assert.equal(revoked,created);}finally{f.mount();api.fetch=originalFetch;URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;}
});
test('legacy formatting and omitted-file notices preserve body and offer guarded original-source download',async()=>{
 const originalFetch=api.fetch,originalCreate=doc.createElement,originalRevoke=URL.revokeObjectURL;let downloads=0,revoked=0;URL.revokeObjectURL=()=>{revoked++;};
 doc.createElement=()=>Object.assign(new E(),{click:()=>{downloads++;}});
 api.fetch=async(_path,init)=>{assert.deepEqual(JSON.parse(init!.body as string),{operation:'read_source',record_id:'record'});return new Response(new Uint8Array(12),{headers:{'content-type':'message/rfc822','content-length':'12','content-disposition':'attachment; filename="message.eml"','x-content-type-options':'nosniff','x-deft-exposure-id':scope.exposure_id,'x-deft-exposure-epoch':'1'}});};
 const f=fixture({...p(),truncated:false,rendering_fallback:'plain_text',omitted_file_count:3});
 try{await flush();const nodes=descendants(f.wrap);assert.ok(nodes.some(n=>n.textContent.includes('Shown as plain text. Download the original for full formatting.')));assert.ok(nodes.some(n=>n.textContent.includes('3 additional files are not listed')));assert.equal(f.wrap.querySelector('.ex-safe-document')!.textContent,'Source text');
   await nodes.find(n=>n.textContent==='Download original')!.onclick!();assert.equal(downloads,1);assert.equal(revoked,1);
 }finally{f.mount();api.fetch=originalFetch;doc.createElement=originalCreate;URL.revokeObjectURL=originalRevoke;}
});
test('trusted Details renders full native recipient metadata from the single authorized presentation and clears on revocation',async()=>{
 const recipients=Array.from({length:33},(_,i)=>`Person ${i} <person${i}@example.test>`).join(', ');
 let live=true,reads=0;const presentation={...p(),headers:[{label:'To',value:'compact recipient header'},{label:'Date',value:'Fri, 9 Oct 2026 20:00:00 +0000'}],metadata:{reply_to_list:recipients}};
 const f=fixture(presentation,async()=>{reads++;return {presentation,expires_at:new Date(Date.now()+60000).toISOString()};},()=>live);
 try{await flush();assert.equal(reads,1);assert.ok(descendants(f.wrap).some(n=>n.textContent==='Message details'));assert.ok(descendants(f.wrap).some(n=>n.textContent===recipients));
  const next=new E();f.mount.attach(next as unknown as HTMLElement);assert.equal(reads,1);assert.ok(descendants(next).some(n=>n.textContent===recipients));
  live=false;f.mount.attach(new E() as unknown as HTMLElement);assert.equal(descendants(next).some(n=>n.textContent===recipients),false);
 }finally{f.mount();}
});
test('expired or late revoked presentation cannot leave full recipient Details behind',async()=>{
 const presentation={...p(),headers:[{label:'To',value:'compact'}],metadata:{reply_to_list:'Synthetic <synthetic@example.test>'}};
 const f=fixture(presentation,async()=>({presentation,expires_at:new Date(Date.now()+20).toISOString()}));
 try{await flush();assert.ok(descendants(f.wrap).some(n=>n.textContent==='Synthetic <synthetic@example.test>'));await new Promise(resolve=>setTimeout(resolve,35));assert.ok(!descendants(f.wrap).some(n=>n.textContent==='Synthetic <synthetic@example.test>'));}finally{f.mount();}
 let live=true,release!:(value:{presentation:SourcePresentation;expires_at:string})=>void;const late=fixture(presentation,()=>new Promise(resolve=>{release=resolve;}),()=>live);
 try{live=false;release({presentation,expires_at:new Date(Date.now()+60000).toISOString()});await flush();assert.ok(!descendants(late.wrap).some(n=>n.textContent==='Message details'));}finally{late.mount();}
});
test.after(()=>{Object.assign(globalThis,{document:originalDocument,MutationObserver:originalObserver});});

test('automatic app-data images require current saved-choice checks before I/O and disclosure',async()=>{
 const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;let created=0,revoked=0,reads=0,proofs=0;
 URL.createObjectURL=()=>`blob:policy/${++created}`;URL.revokeObjectURL=()=>{revoked++;};
 const images=[{image_ref:'a'.repeat(64),kind:'remote' as const,index:0,alt:''}];
 const f=fixture({...p(images),external_images:'always'},undefined,()=>true,{automaticImages:async()=>{proofs++;return proofs<3;},readBinary:async()=>{reads++;return {bytes:new Uint8Array([1]),media_type:'image/png'};}});
 try{await flush();assert.equal(reads,1);assert.equal(created,0);assert.equal(revoked,0);assert.ok(descendants(f.wrap).some(n=>n.textContent.includes('saved image choice changed')));assert.equal(descendants(f.wrap).some(n=>n.textContent==='External images loaded for this message.'),false);}finally{f.mount();URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;}
});
test('explicit blocking choice overrides the source default, while per-message loading still works',async()=>{
 let reads=0;const images=[{image_ref:'a'.repeat(64),kind:'remote' as const,index:0,alt:''}];
 const f=fixture({...p(images),external_images:'always'},undefined,()=>true,{automaticImages:async()=>false,readBinary:async()=>{reads++;return {bytes:new Uint8Array([1]),media_type:'image/png'};}});
 try{await flush();assert.equal(reads,0);assert.ok(descendants(f.wrap).some(n=>n.textContent.includes('blocked until')));await descendants(f.wrap).find(n=>n.textContent==='Load external images')!.onclick!();assert.equal(reads,1);}finally{f.mount();}
});

test('an absent saved preference uses the source automatic-image default',async()=>{
 let reads=0;const images=[{image_ref:'a'.repeat(64),kind:'remote' as const,index:0,alt:''}];
 const f=fixture({...p(images),external_images:'always'},undefined,()=>true,{automaticImages:async()=>undefined,readBinary:async()=>{reads++;return {bytes:new Uint8Array([1]),media_type:'image/png'};}});
 try{await flush();assert.equal(reads,1);assert.ok(descendants(f.wrap).some(n=>n.textContent==='External images loaded for this message.'));}finally{f.mount();}
});

test('an unavailable saved preference never falls back to automatic images',async()=>{
 let reads=0;const images=[{image_ref:'a'.repeat(64),kind:'remote' as const,index:0,alt:''}];
 const f=fixture({...p(images),external_images:'always'},undefined,()=>true,{automaticImages:async()=>{throw Error('unavailable');},readBinary:async()=>{reads++;return {bytes:new Uint8Array([1]),media_type:'image/png'};}});
 try{await flush();assert.equal(reads,0);assert.ok(descendants(f.wrap).some(n=>n.textContent.includes('choice is unavailable')));}finally{f.mount();}
});

test('presentations without remote images skip automatic policy and never show remote loading',async()=>{
 for(const images of [[],[{image_ref:'c'.repeat(64),kind:'cid' as const,index:0,alt:''}]]){
  let choices=0,reads=0;const f=fixture({...p(images),external_images:'always'},undefined,()=>true,{automaticImages:async()=>{choices++;return true;},readBinary:async()=>{reads++;return {bytes:new Uint8Array([1]),media_type:'image/png'};}});
  try{await flush();assert.equal(choices,0,'no remote image means no remote preference request');assert.equal(reads,images.length);assert.ok(!descendants(f.wrap).some(n=>/external images|saved image choice/i.test(n.textContent)));assert.equal(f.wrap.querySelector('.ex-safe-document')?.textContent,'Source text');}finally{f.mount();}
 }
});
