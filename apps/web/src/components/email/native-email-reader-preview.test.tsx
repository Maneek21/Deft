import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import * as ts from 'typescript';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {nativeAttachmentPreviewKind,type NativeReaderState} from '../../lib/email-native-reader';
import {experienceDocumentPresentation} from '../../lib/app-experience-document-presentation';
import {nativeReceivedFileLimit} from '../../lib/email-native-received-limits';

const source=readFileSync(process.env.NATIVE_READER_SOURCE??new URL('./native-email-reader.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('native-email-reader.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const surface=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='NativeEmailReaderSurface')!;
const file={file_ref:'c'.repeat(64),filename:'résumé <report>.pdf',media_type:'application/pdf',size_bytes:1024,disposition:'attachment' as const,preview:'pdf' as const};
const state:NativeReaderState={loading:false,notice:'',externalStatus:'',embeddedStatus:'',externalBusy:false,externalAvailable:false,embeddedBusy:false,embeddedAvailable:false,imageLimit:false,preview:null,sourceAvailable:true,
  value:{schema_version:'deft.email_presentation.v1',account_id:'account',provider:'gmail',logical_message_id:'mail_'+'a'.repeat(64),source_digest:'b'.repeat(64),content_trust:'unsanitized',files:[file],
    presentation:{format:'plain',content:'Body',plain_text:'Body',truncated:false,images:[],headers:[],metadata:{account_id:'account'}}}};
function mount(value:NativeReaderState){let index=0;const refs:Array<{current:any}>=[],effects:Array<()=>void>=[];
  const component=runInNewContext(ts.transpileModule('('+surface.getText(tree)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None,jsx:ts.JsxEmit.React}}).outputText,
  {React,nativeAttachmentPreviewKind,nativeReceivedFileLimit,useRef:(initial:unknown)=>{const ref={current:initial};refs.push(ref);return ref;},useState:()=>[index++===0?value:null,()=>{}],useEffect:(fn:()=>void)=>effects.push(fn),useLayoutEffect:()=>{},NativeEmailHeaderSummary:()=>null,NativeEmailCalendarInvitationAction:()=>null,NativeEmailContextTransferAction:()=>null,NativeEmailAskDefty:()=>null,NativeEmailRelatedKnowledge:()=>null,MoreHorizontal:()=>null});
  return {element:component({accountId:'account',logicalMessageId:state.value!.logical_message_id,sessionScope:'session',onRetry:()=>{}}),refs,effects};}
const render=(value:NativeReaderState)=>renderToStaticMarkup(mount(value).element);
test('oversized source-only attachment remains named and offers original; aggregate ZIP limit keeps individual actions available',()=>{
 const oversized=render({...state,value:{...state.value!,files:[{...file,size_bytes:nativeReceivedFileLimit+1}]}});assert.match(oversized,/résumé &lt;report&gt;\.pdf/);assert.match(oversized,/Download original message for/);assert.match(oversized,/Over the 25 MiB attachment limit/);assert.doesNotMatch(oversized,/aria-label="Download résumé|aria-label="Preview /);assert.match(oversized,/disabled=""[^>]*>Download all attachments/);
 const combined=render({...state,value:{...state.value!,files:[{...file,size_bytes:18*1024*1024},{...file,file_ref:'d'.repeat(64),filename:'second.dat',size_bytes:16*1024*1024}]}});assert.match(combined,/25 MiB ZIP limit/);assert.match(combined,/aria-label="Download second.dat"/);assert.doesNotMatch(combined,/Over the 25 MiB attachment limit/);
 const inline=render({...state,value:{...state.value!,files:[{...file,filename:'large-inline.png',size_bytes:nativeReceivedFileLimit+1,disposition:'inline'}]}});assert.match(inline,/large-inline.png/);assert.match(inline,/Download original message for large-inline.png/);assert.doesNotMatch(inline,/Download all attachments/);
});
test('actual reader offers separate accessible Preview and Download only for supported declared attachments',()=>{
  const html=render(state);assert.match(html,/aria-label="Preview résumé &lt;report&gt;\.pdf"/);assert.match(html,/aria-label="Download résumé &lt;report&gt;\.pdf"/);assert.match(html,/aria-expanded="false"/);
  const unsupported=render({...state,value:{...state.value!,files:[{...file,media_type:'text/html'}]}});assert.doesNotMatch(unsupported,/aria-label="Preview /);assert.match(unsupported,/aria-label="Download /);
});
test('actual preview region renders inert text, clipping, raster and explicit native PDF viewer fallback',()=>{
  const preview={fileRef:file.file_ref,filename:file.filename,kind:'text' as const,loading:false,error:'',text:'<script>attack()</script>',clipped:true,url:''};
  const text=render({...state,preview});assert.match(text,/&lt;script&gt;attack\(\)&lt;\/script&gt;/);assert.doesNotMatch(text,/<script>/);assert.match(text,/Only part of this attachment/);assert.match(text,/tabindex="-1" role="region"/);assert.match(text,/Close attachment preview/);
  const pdf=render({...state,preview:{...preview,kind:'pdf',text:'',url:'blob:pdf'}});assert.match(pdf,/href="blob:pdf" target="_blank" rel="noopener noreferrer"/);assert.match(pdf,/Open PDF preview/);assert.match(pdf,/viewer is unavailable/);assert.match(pdf,/Download attachment/);assert.doesNotMatch(pdf,/<iframe/);
  const image=render({...state,preview:{...preview,kind:'image',url:'blob:image'}});assert.match(image,/src="blob:image"/);assert.match(image,/alt="Preview of résumé/);
});
test('actual attachment loading/error states keep close and download fallback available',()=>{
  const preview={fileRef:file.file_ref,filename:file.filename,kind:'pdf' as const,loading:true,error:'',text:'',clipped:false,url:''};
  assert.match(render({...state,preview}),/Loading attachment preview/);const failed=render({...state,preview:{...preview,loading:false,error:'Preview failed'}});
  assert.match(failed,/Preview failed/);assert.match(failed,/Retry preview/);assert.match(failed,/Close attachment preview/);assert.match(failed,/Download attachment/);
});
test('actual preview focuses its region and Close returns focus to the originating Preview button',()=>{
  const preview={fileRef:file.file_ref,filename:file.filename,kind:'pdf' as const,loading:true,error:'',text:'',clipped:false,url:''};
  const mounted=mount({...state,preview});let panelFocused=0,buttonFocused=0,closed=0;
  mounted.refs[1].current={closePreview:()=>{closed++;}};mounted.refs[2].current={focus:()=>{panelFocused++;}};
  mounted.refs[3].current.set(file.file_ref,{focus:()=>{buttonFocused++;}});mounted.effects[0]();assert.equal(panelFocused,1);
  const find=(node:any):any=>{if(!node||typeof node!=='object')return null;if(node.props?.['aria-label']==='Close attachment preview')return node;
    for(const child of React.Children.toArray(node.props?.children)){const match=find(child);if(match)return match;}return null;};
  find(mounted.element).props.onClick();assert.equal(closed,1);assert.equal(buttonFocused,1);
});
test('failed native presentation offers original source fallback only while source access remains available',()=>{
 const failed={...state,value:null,notice:'Message content is unavailable.'};const html=render(failed);assert.match(html,/Load message again/);assert.match(html,/>Download original<\/button>/);assert.match(html,/up to 35 MiB/);
 const denied=render({...failed,sourceAvailable:false,notice:'Account access ended.'});assert.doesNotMatch(denied,/>Download original<\/button>/);
});
test('omitted native files disclose their count and source action even when no files are nominated',()=>{
 const html=render({...state,value:{...state.value!,files:[],omitted_file_count:3}});assert.match(html,/3 additional files are not listed/);assert.match(html,/Download the original to access every file/);assert.match(html,/aria-label="Attachments"/);assert.match(html,/>Download original<\/button>/);
 assert.doesNotMatch(render({...state,value:{...state.value!,files:[]}}),/aria-label="Attachments"/);
});
test('actual received-attachment ZIP action distinguishes all/listed, keeps original and never claims a subset is all',()=>{
 assert.match(render(state),/>Download all attachments \(\.zip\)<\/button>/);
 const listed=render({...state,value:{...state.value!,omitted_file_count:2}});assert.match(listed,/>Download listed attachments \(\.zip\)<\/button>/);assert.doesNotMatch(listed,/Download all attachments/);assert.match(listed,/>Download original<\/button>/);
 assert.doesNotMatch(render({...state,value:{...state.value!,files:[],omitted_file_count:2}}),/Download (?:all|listed) attachments/);
 const denied=render({...state,value:null,sourceAvailable:false,archive:null});assert.doesNotMatch(denied,/Download (?:all|listed) attachments/);
});
test('actual archive busy/incomplete UI disables competing files and exposes one cancel/status with individual fallback',()=>{
 const preparing=render({...state,archive:{busy:true,notice:'Preparing attachments…'}});assert.match(preparing,/Preparing attachments/);assert.match(preparing,/>Cancel ZIP<\/button>/);assert.match(preparing,/disabled="" aria-label="Download résumé/);assert.match(preparing,/disabled="" aria-label="Preview résumé/);
 const incomplete=render({...state,archive:{busy:false,notice:'The ZIP is incomplete. No ZIP was saved. Try again or download attachments individually.'}});
 assert.match(incomplete,/No ZIP was saved/);assert.match(incomplete,/Download all attachments/);assert.match(incomplete,/aria-label="Download résumé/);assert.doesNotMatch(incomplete,/>Cancel ZIP<\/button>/);
});

// DOM/style intent only: this fixture does not compute browser CSS or contrast.
// Root owns white-body and authored-layout rendered acceptance.
test('native body link styling preserves sanitized white/dark ancestor foreground and leaves reader controls outside the scope',()=>{
 const mounted=mount(state),find=(node:any):any=>{if(!node||typeof node!=='object')return null;if(node.props?.ref===mounted.refs[0])return node;for(const child of React.Children.toArray(node.props?.children)){const match=find(child);if(match)return match;}return null;};
 const body=find(mounted.element);assert.ok(body);assert.ok(body.props.className.split(/\s/u).includes('native-email-document'));
 assert.ok(!mounted.element.props.className.includes('native-email-document'));
 const css=readFileSync(process.env.NATIVE_READER_STYLES??new URL('../../app/globals.css',import.meta.url),'utf8'),rule=/\.native-email-document a\[href\]\s*\{([^}]+)\}/u.exec(css)?.[1];assert.ok(rule);
 // Unstyled links inherit through the renderer; CSS cannot override an
 // explicitly sanitized CTA foreground on its authored safe background.
 assert.doesNotMatch(rule,/color:\s*[^;]+!important/u);assert.match(rule,/text-decoration:\s*underline/u);
 assert.match(css,/\.native-email-document a\[href\]:focus-visible\s*\{[^}]*outline:\s*2px solid currentColor/u);
 for(const [foreground,background] of [['#202124','#fff'],['white','#111']]){
  const values:Record<string,string>={color:foreground,'background-color':background},style=Object.assign(Object.keys(values),{getPropertyValue:(key:string)=>values[key]??''});
  const safe=experienceDocumentPresentation({tagName:'DIV',style,getAttribute:()=>null} as unknown as HTMLElement);
  assert.equal(safe,`color:${foreground};background-color:${background}`);
  // The scoped rule deliberately inherits this nearest approved foreground;
  // no source class, theme var, or fixed dark color is nominated by the fixture.
  assert.doesNotMatch(rule,/var\(|#[a-f0-9]{3,8}/iu);
 }
});
