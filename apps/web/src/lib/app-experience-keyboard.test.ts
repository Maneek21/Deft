import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExperienceView } from './app-experience-bridge';
import { bindExperienceKeyboard } from './app-experience-keyboard';
import { DeftExperienceKeyboardSchema } from '../../../../packages/app-kit/src/experience-keyboard';

const profile = { schema_version:'deft.experience_keyboard.v1' as const,
  bindings:[{ key:'c',target_id:'compose',behavior:'activate' as const },{ key:'/',target_id:'query',behavior:'focus' as const }],
  navigation:{ previous_key:'k',next_key:'j',list_id:'messages' } };
const view = { schema_version:'deft.experience_view.v2',capabilities:['keyboard_controls.v1'], keyboard:profile,
  root:{kind:'stack',id:'root',children:[{kind:'button',id:'compose',label:'Compose'},
    {kind:'input',id:'query',label:'Search',value:''},
    {kind:'stack',id:'messages',layout:'list',children:[{kind:'button',id:'row',label:'Message',variant:'list'}]}]} };
const options = { capabilities:['keyboard_controls.v1'] as const };
test('keyboard declarations require a current negotiated capability and exact current root controls',()=>{
  assert.ok(parseExperienceView(view,options));assert.equal(parseExperienceView(view),null);
  for(const keyboard of [{...profile,unknown:true},{...profile,bindings:[{key:'C',target_id:'compose',behavior:'activate'}]},
    {...profile,bindings:[{key:'c',target_id:'foreign',behavior:'activate'}]},
    {...profile,bindings:[{key:'c',target_id:'query',behavior:'activate'}]},
    {...profile,bindings:[{key:'j',target_id:'compose',behavior:'activate'}]},
    {...profile,navigation:{...profile.navigation,list_id:'compose'}},
    {...profile,bindings:[{key:'c',target_id:'compose',behavior:'focus',focus_after:'query'}]}])
    assert.equal(parseExperienceView({...view,keyboard},options),null);
  assert.equal(DeftExperienceKeyboardSchema.safeParse({...profile,bindings:Array.from({length:9},(_,i)=>({key:String.fromCharCode(97+i),target_id:'compose',behavior:'activate'}))}).success,false);
  const oversized=structuredClone(view);oversized.root.children[2].children=Array.from({length:101},(_,i)=>({kind:'button',id:'row_'+i,label:'Row',variant:'list'}));
  // Keep ordinary node child bounds independent of the keyboard count bound.
  assert.equal(parseExperienceView(oversized,options),null);
});

class Element {
  children:Element[]=[];parent:Element|null=null;dataset:Record<string,string>={};attributes=new Map<string,string>();
  isConnected=true;shown=true;clicks=0;scrolled=0;editing=false;dialog=false;
  constructor(readonly tagName:string,readonly ownerDocument:Doc){}
  getClientRects(){return this.shown?[{}]:[];}
  hasAttribute(key:string){return this.attributes.has(key);}
  getAttribute(key:string){return this.attributes.get(key)??null;}
  closest(selector:string):Element|null{
    if(selector.includes('[hidden]')&&(this.hasAttribute('hidden')||this.hasAttribute('inert')||this.getAttribute('aria-hidden')==='true'))return this;
    if(selector.includes('input')&&this.editing||selector.includes('[role="dialog"]')&&this.dialog)return this;
    return this.parent?.closest(selector)??null;
  }
  append(child:Element){child.parent=this;this.children.push(child);}
  contains(target:Element):boolean{return target===this||this.children.some(child=>child.contains(target));}
  querySelectorAll(selector:string):Element[]{return this.children.flatMap(child=>[child,...child.querySelectorAll('*')]).filter(child=>selector==='*'
    ||selector==='[data-render-key]'?selector==='*'||!!child.dataset.renderKey
    :selector.startsWith('button')?child.tagName==='BUTTON'&&child.getAttribute('class')==='ex-button-list'&&!!child.dataset.focusKey:!!child.dataset.focusKey);}
  focus(){this.ownerDocument.activeElement=this;}
  click(){this.clicks++;}
  scrollIntoView(){this.scrolled++;}
}
class Doc {
  body=new Element('BODY',this);documentElement=new Element('HTML',this);activeElement:Element|null=null;modals:Element[]=[];
  listener:((event:KeyboardEvent)=>void)|undefined;
  defaultView={addEventListener:(_kind:string,callback:(event:KeyboardEvent)=>void)=>{this.listener=callback;},removeEventListener:()=>{this.listener=undefined;}};
  querySelectorAll(){return this.modals;}
}
test('actual keyboard listener retains normal controls, row focus and all workspace editing/lifecycle guards',()=>{
  const saved=Object.getOwnPropertyDescriptor(globalThis,'HTMLElement');Object.assign(globalThis,{HTMLElement:Element});
  try{
    const doc=new Doc(),container=new Element('DIV',doc),list=new Element('DIV',doc),compose=new Element('BUTTON',doc),query=new Element('INPUT',doc);
    container.append(compose);container.append(query);container.append(list);compose.dataset.focusKey='compose';query.dataset.focusKey='query';query.editing=true;list.dataset.renderKey='messages';
    const rows=Array.from({length:3},(_,i)=>{const row=new Element('BUTTON',doc);row.dataset.focusKey='row_'+i;row.attributes.set('class','ex-button-list');list.append(row);return row;});
    let live=true;const dispose=bindExperienceKeyboard(container as unknown as HTMLElement,profile,()=>live);
    const press=(key:string,extra:Record<string,unknown>={})=>{let prevented=false;doc.listener?.({key,isTrusted:true,target:doc.activeElement??doc.body,preventDefault:()=>{prevented=true;},...extra} as unknown as KeyboardEvent);return prevented;};
    assert.equal(press('c'),true);assert.equal(compose.clicks,1);
    assert.equal(press('j'),true);assert.equal(doc.activeElement,rows[0]);press('j');assert.equal(doc.activeElement,rows[1]);press('k');assert.equal(doc.activeElement,rows[0]);
    assert.equal(rows.reduce((sum,row)=>sum+row.clicks,0),0,'navigation focuses and never reads/changes a message');
    assert.equal(press('Enter'),false,'native focused-button Enter remains untouched');
    assert.equal(press('/'),true);assert.equal(doc.activeElement,query);assert.equal(press('c'),false);
    doc.activeElement=null;
    for(const extra of [{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true},{repeat:true},{isComposing:true},{keyCode:229},{defaultPrevented:true},{isTrusted:false}])assert.equal(press('c',extra),false);
    const outside=new Element('BUTTON',doc);assert.equal(press('c',{target:outside}),false);
    const dialog=new Element('DIV',doc);dialog.dialog=true;doc.modals=[dialog];assert.equal(press('c'),false);doc.modals=[];
    compose.attributes.set('disabled','');assert.equal(press('c'),false);compose.attributes.delete('disabled');
    container.shown=false;assert.equal(press('c'),false);container.shown=true;
    live=false;assert.equal(press('c'),false);assert.equal(compose.clicks,1);
    dispose();assert.equal(doc.listener,undefined);
  }finally{if(saved)Object.defineProperty(globalThis,'HTMLElement',saved);else Reflect.deleteProperty(globalThis,'HTMLElement');}
});
