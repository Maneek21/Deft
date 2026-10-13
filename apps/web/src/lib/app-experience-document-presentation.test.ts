import assert from 'node:assert/strict';
import { test } from 'node:test';
import { experienceDocumentStyleValue as style, experienceDocumentPresentation } from './app-experience-document-presentation';

test('newsletter and receipt presentation retains local type, spacing, table and colour values', () => {
  for (const [property, value] of [['width','600px'],['max-width','100%'],['padding','24px 16px'],['background-color','#ffffff'],['color','#202124'],['font-size','24px'],['font-family','Arial, sans-serif'],['text-align','center'],['border','1px solid #ddd'],['border-collapse','collapse']]) assert.ok(style(property,value), `${property}:${value}`);
});
test('message styling cannot fetch, escape its surface, hide authority controls or generate content', () => {
  for (const [property,value] of [['background','url(https://tracking.test)'],['background-color','var(--credential)'],['color','expression(alert(1))'],['font-family','url(https://font.test)'],['position','fixed'],['z-index','99999'],['display','contents'],['content','attr(data-secret)'],['width','9999px'],['height','100vh'],['margin','-100px'],['padding','calc(100vw)'],['color','red!important'],['color','r\\65d'],['transform','translateX(200px)'],['overflow','visible']]) assert.equal(style(property,value),null,`${property}:${value}`);
});

// Typical newsletter values are local presentation, without network authority.
test('common newsletter backgrounds, line heights and inert preheaders survive',()=>{
 for(const [property,value] of [['background','#fff'],['background','rgb(32, 33, 36)'],['line-height','24px'],['line-height','1.5em'],['line-height','1px'],['font-size','1px'],['display','none'],['visibility','hidden']])assert.ok(style(property,value),`${property}:${value}`);
 for(const [property,value] of [['background','url(https://tracking.test) red'],['background','linear-gradient(red, blue)'],['display','fixed'],['visibility','collapse'],['line-height','9999px'],['line-height','calc(2em)'],['background','red!important']])assert.equal(style(property,value),null);
});

test('legacy center/font presentation and nested cellpadding retain local safe intent',()=>{
 const element=(tagName:string,attrs:Record<string,string>,cells:unknown[]=[])=>({tagName,style:Object.assign([],{getPropertyValue:()=>''}),getAttribute:(key:string)=>attrs[key]??null,querySelectorAll:()=>cells}) as unknown as HTMLElement;
 assert.equal(experienceDocumentPresentation(element('CENTER',{})),'text-align:center');
 assert.equal(experienceDocumentPresentation(element('FONT',{color:'#fff',face:'Arial, sans-serif',size:'4'})),'color:#fff;font-family:arial, sans-serif;font-size:18px');
 assert.equal(experienceDocumentPresentation(element('FONT',{color:'url(https://bad.test)',face:'expression(alert(1))',size:'100'})),'');
 const outer=element('TABLE',{cellpadding:'0'}),inner=element('TABLE',{cellpadding:'16'});
 const outerCell={style:{padding:''},closest:()=>outer},innerCell={style:{padding:''},closest:()=>inner};
 Object.assign(outer,{querySelectorAll:()=>[outerCell,innerCell]});Object.assign(inner,{querySelectorAll:()=>[innerCell]});
 experienceDocumentPresentation(outer);experienceDocumentPresentation(inner);assert.equal(outerCell.style.padding,'0px');assert.equal(innerCell.style.padding,'16px');
});

test('source-backed centered tables, auto margins and bounded radii survive without positioning authority',()=>{
 for(const [property,value] of [['margin','0 auto'],['margin-left','auto'],['border-radius','20px 20px 0 0'],['border-top-left-radius','20px']])assert.ok(style(property,value));
 for(const [property,value] of [['padding','auto'],['margin','-1px auto'],['margin','auto auto auto auto auto'],['border-radius','1000px'],['border-radius','url(https://tracking.test)'],['border-radius','calc(100vw)']])assert.equal(style(property,value),null);
 const table={tagName:'TABLE',style:Object.assign([],{getPropertyValue:()=>''}),getAttribute:(key:string)=>key==='align'?'center':null,querySelectorAll:()=>[]};const rendered=experienceDocumentPresentation(table as unknown as HTMLElement);assert.ok(rendered.includes('margin-left:auto'));assert.ok(rendered.includes('margin-right:auto'));
});
