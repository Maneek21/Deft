import test from 'node:test';
import assert from 'node:assert/strict';
import {mountExperienceSourcePresentation} from './app-experience-source-presentation';
import type {SourcePresentation} from './app-experience-source-view';

// Exercise the real presentation controller without a browser or provider.
class Element {
  children:Element[]=[];parent:Element|null=null;
  style:Record<string,string>={};attributes:Record<string,string>={};
  className='';textContent='';isConnected=true;type='';disabled=false;
  onclick:(()=>Promise<void>)|null=null;
  get parentElement(){return this.parent;}
  append(...nodes:Element[]){for(const node of nodes){node.remove();node.parent=this;this.children.push(node);}}
  prepend(...nodes:Element[]){for(const node of [...nodes].reverse()){node.remove();node.parent=this;this.children.unshift(node);}}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);this.parent=null;}
  replaceWith(node:Element){if(this.parent){const index=this.parent.children.indexOf(this);this.parent.children[index]=node;node.parent=this.parent;this.parent=null;}}
  querySelector(query:string){return this.children.find(node=>query==='.ex-safe-document'&&node.className==='ex-safe-document')??null;}
  querySelectorAll(){return [];}
  setAttribute(key:string,value:string){this.attributes[key]=value;}
  removeAttribute(key:string){delete this.attributes[key];}
}
const descendants=(element:Element):Element[]=>element.children.flatMap(child=>[child,...descendants(child)]);
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
type Binary={bytes:Uint8Array;media_type:string};
function deferred(){let resolve!:(value:Binary)=>void;const promise=new Promise<Binary>(done=>{resolve=done;});return{promise,resolve};}

function fixture(images:SourcePresentation['images'],readBinary:NonNullable<Parameters<typeof mountExperienceSourcePresentation>[0]['readBinary']>){
  const originalDocument=globalThis.document,originalObserver=globalThis.MutationObserver;
  const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
  const created:string[]=[],revoked:string[]=[];let current=true;
  Object.assign(globalThis,{document:{hidden:false,documentElement:new Element(),createElement:()=>new Element(),
    createTextNode:(value:string)=>Object.assign(new Element(),{textContent:value}),addEventListener(){},removeEventListener(){}},
    MutationObserver:class{observe(){}disconnect(){}}});
  URL.createObjectURL=()=>{const url=`blob:fixture/${created.length+1}`;created.push(url);return url;};
  URL.revokeObjectURL=url=>{revoked.push(url);};
  const wrap=new Element();wrap.append(Object.assign(new Element(),{className:'ex-safe-document',textContent:'Loaded text'}));
  const presentation:SourcePresentation={format:'plain',content:'Source text',plain_text:'Source text',truncated:false,images,headers:[]};
  const mount=mountExperienceSourcePresentation({wrap:wrap as unknown as HTMLElement,
    node:{kind:'document',id:'message',format:'plain',content:'Loaded text'},
    scope:{exposure_id:'fixture-exposure',exposure_epoch:1},sessionId:'session',resourceKey:'inbox',recordId:'record',
    current:()=>current,load:async()=>({presentation,expires_at:new Date(Date.now()+60000).toISOString()}),readBinary});
  return{wrap,mount,created,revoked,revoke:()=>{current=false;},
    restore:()=>{mount();Object.assign(globalThis,{document:originalDocument,MutationObserver:originalObserver});URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;}};
}
const image=(character:string,index:number,kind:'remote'|'cid'='remote')=>({image_ref:character.repeat(64),kind,index,alt:''});
const loadButton=(wrap:Element)=>{const button=descendants(wrap).find(node=>node.textContent==='Load external images');assert.ok(button?.onclick);return button;};

test('actual image queue starts only one request until its predecessor settles',async()=>{
  const pending:{ref:string;value:ReturnType<typeof deferred>}[]=[];let active=0,maximum=0;
  const f=fixture([image('a',0),image('b',1),image('c',2)],async input=>{
    assert.equal(input.operation,'read_image');active++;maximum=Math.max(maximum,active);
    const value=deferred();pending.push({ref:input.image_ref!,value});
    try{return await value.promise;}finally{active--;}
  });
  let loading:Promise<void>|undefined;
  try{
    await flush();loading=loadButton(f.wrap).onclick!();await flush();
    assert.equal(pending.length,1,'a second request must not spend its authority deadline waiting behind the first');
    for(let index=0;index<3;index++){
      assert.equal(pending.length,index+1);assert.equal(pending[index].ref,['a','b','c'][index].repeat(64));
      const bytes=new Uint8Array([index+1]);pending[index].value.resolve({bytes,media_type:'image/png'});
      await flush();assert.deepEqual([...bytes],[0],'response bytes are erased after rendering');
    }
    await loading;assert.equal(maximum,1);assert.equal(f.created.length,3);
    assert.ok(descendants(f.wrap).some(node=>node.textContent==='External images loaded for this message.'));
  }finally{
    f.mount();for(const item of pending)item.value.resolve({bytes:new Uint8Array([1]),media_type:'image/png'});
    await loading;f.restore();
  }
});

test('one failed image preserves successful images and retries only the failed reference',async()=>{
  const calls:string[]=[],bytes:Uint8Array[]=[];let fail=true;
  const f=fixture([image('a',0),image('b',1),image('c',2)],async input=>{
    calls.push(input.image_ref!);
    if(input.image_ref==='b'.repeat(64)&&fail)throw Error('fixture fetch failed');
    const value=new Uint8Array([1,2]);bytes.push(value);return{bytes:value,media_type:'image/png'};
  });
  try{
    await flush();const button=loadButton(f.wrap);await button.onclick!();
    assert.deepEqual(calls,['a','b','c'].map(value=>value.repeat(64)));assert.equal(f.created.length,2);
    assert.equal(button.textContent,'Retry external images');assert.equal(button.disabled,false);
    assert.ok(descendants(f.wrap).some(node=>node.textContent.includes('Some images could not be loaded')));
    assert.ok(bytes.every(value=>value.every(byte=>byte===0)));
    fail=false;await button.onclick!();
    assert.deepEqual(calls,['a','b','c','b'].map(value=>value.repeat(64)));assert.equal(f.created.length,3);
    assert.ok(!descendants(f.wrap).includes(button));
  }finally{f.restore();}
});

test('revocation or disposal discards a late image and revokes previously rendered URLs',async()=>{
  for(const stop of ['revoke','dispose'] as const){
    const late=deferred(),lateBytes=new Uint8Array([3,4]);let signal:AbortSignal|undefined;const calls:string[]=[];
    const f=fixture([image('a',0,'cid'),image('b',1),image('c',2)],async(input,requestSignal)=>{
      calls.push(input.image_ref!);signal=requestSignal;
      if(input.image_ref==='a'.repeat(64))return{bytes:new Uint8Array([1]),media_type:'image/png'};
      return late.promise;
    });
    let loading:Promise<void>|undefined;
    try{
      await flush();assert.equal(f.created.length,1);loading=loadButton(f.wrap).onclick!();await flush();
      if(stop==='revoke')f.revoke();else f.mount();
      late.resolve({bytes:lateBytes,media_type:'image/png'});await loading;
      assert.equal(signal?.aborted,true);assert.equal(f.created.length,1,'late result must not create an object URL');
      assert.deepEqual(f.revoked,f.created);assert.deepEqual([...lateBytes],[0,0]);
      assert.deepEqual(calls,['a','b'].map(value=>value.repeat(64)),'no next image may start after authority ends');
      if(stop==='revoke')assert.ok(descendants(f.wrap).some(node=>node.textContent.includes('access expired')));
    }finally{f.mount();late.resolve({bytes:lateBytes,media_type:'image/png'});await loading;f.restore();}
  }
});
