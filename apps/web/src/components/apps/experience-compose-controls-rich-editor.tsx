'use client';

import { useEffect, useLayoutEffect, useMemo, useId, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {Extension,type AnyExtension} from '@tiptap/core';
import {Plugin} from '@tiptap/pm/state';
import { Bold, Italic, List, ListOrdered, Link2 } from 'lucide-react';
import { type NativeComposeInlineAttachment, NATIVE_COMPOSE_BODY_LIMITS, parseSafeComposeHtml, parseNativeSafeComposeHtml, canonicalNativeComposeLink, nativeSafeComposeHtmlFromEditorDocument, nativeComposeDraftFromEditorDocument, plainTextToNativeComposeHtml, plainTextToSafeComposeHtml, safeComposeHtmlFromEditorDocument } from '../../../../../packages/app-kit/src/safe-compose-html';
import { ExperienceComposePlainEditor } from './experience-compose-controls-editor';

export type ComposeImagePort={insert:(fileId:string,alt:string)=>boolean};
type HostImages={files:readonly NativeComposeInlineAttachment[];extension:AnyExtension;register:(port:ComposeImagePort|null,previous?:ComposeImagePort)=>void};
type Value = Readonly<{ html: string; plainText: string }>;
const button = 'rounded-full px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50';
/** Only a reviewed paired scalar contract enables this editor. Clipboard HTML
 * and remote/file drops never enter its document parser. */
export function ExperienceComposeRichEditor({label,value,onChange,maxCharacters,maxPlainCharacters,disabled=false,presentationOnly=false,preserveWhitespace=false,hostLinks=false,hostImages,validateValue}: {
  label:string;value:Value;onChange:(value:Value)=>void;maxCharacters:number;maxPlainCharacters:number;disabled?:boolean;presentationOnly?:boolean;preserveWhitespace?:boolean;hostLinks?:boolean;hostImages?:HostImages;validateValue?:(value:Value)=>void;
}) {
  disabled=disabled||presentationOnly;
  const id=useId(), [notice,setNotice]=useState(''), [hardNotice,setHardNotice]=useState(''), [,redraw]=useState(0);
  const hydrated=useRef(false), mounted=useRef(true);
  const docPair=useRef<{doc:object;value:Value;files?:readonly NativeComposeInlineAttachment[]}|null>(null),published=useRef<{doc:object;value:Value;files?:readonly NativeComposeInlineAttachment[]}|null>(null);
  type LinkEdit={value:Value;doc:object;from:number;to:number;text:string;href:string;existing:boolean};
  const [linkEdit,setLinkEdit]=useState<LinkEdit|null>(null),[linkURL,setLinkURL]=useState('');
  const linkOwner=useRef<LinkEdit|null>(null),linkPanel=useRef<HTMLDivElement|null>(null),linkInput=useRef<HTMLInputElement|null>(null);
  const imageOptions={inlineAttachments:hostImages?.files};
  const parseHtml=hostLinks?(html:string,options={})=>parseNativeSafeComposeHtml(html,{...options,...imageOptions}):parseSafeComposeHtml;
  const fromDocument=hostLinks?(doc:unknown)=>nativeSafeComposeHtmlFromEditorDocument(doc,imageOptions):safeComposeHtmlFromEditorDocument;
  const closeLink=(focus=false)=>{linkOwner.current=null;if(mounted.current)setLinkEdit(null);if(focus&&mounted.current&&!latest.current.disabled)editor?.commands.focus();};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;linkOwner.current=null;};},[]);
  useEffect(()=>{if(!linkEdit)return;linkInput.current?.focus();
    const outside=(event:Event)=>{if(event.target instanceof Node&&!linkPanel.current?.contains(event.target))closeLink();};
    document.addEventListener('pointerdown',outside);document.addEventListener('focusin',outside);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('focusin',outside);};
  },[linkEdit]);
  useEffect(()=>{linkOwner.current=null;setLinkEdit(null);},[value.html,value.plainText,disabled,hostLinks]);
  const latest=useRef({value,onChange,disabled,preserveWhitespace,hostLinks,hostImages,maxCharacters,maxPlainCharacters,validateValue});useLayoutEffect(()=>{latest.current={value,onChange,disabled,preserveWhitespace,hostLinks,hostImages,maxCharacters,maxPlainCharacters,validateValue};},[value,onChange,disabled,preserveWhitespace,hostLinks,hostImages,maxCharacters,maxPlainCharacters,validateValue]);
  const rejectedEdit='This edit or paste was not applied because it exceeds the editor limits or contains unsupported content. Your previous draft is kept. Shorten the text or use plain text.';
  const validation=useMemo(()=>{try{return value.html!==''&&parseHtml(value.html,{maxCharacters}).plainText!==value.plainText?'Formatting and plain text must match.':'';}catch{return 'This formatting exceeds its limit or needs correction. Your draft is retained.';}},[value.html,value.plainText,maxCharacters,hostLinks,hostImages?.files]);
  let error=value.plainText.length>maxPlainCharacters?'This message exceeds its plain-text limit. Shorten it to continue.':validation;
  const boundedDocument=useMemo(()=>Extension.create({name:'hostComposeBoundedDraft',addProseMirrorPlugins(){return [new Plugin({filterTransaction(transaction){
    if((!latest.current.hostLinks&&!latest.current.validateValue)||!transaction.docChanged)return true;
    if(!mounted.current||latest.current.disabled&&transaction.getMeta('preventUpdate')!==true)return false;
    try{const next=latest.current.hostLinks?nativeComposeDraftFromEditorDocument(transaction.doc.toJSON(),{inlineAttachments:latest.current.hostImages?.files}):safeComposeHtmlFromEditorDocument(transaction.doc.toJSON());latest.current.validateValue?.(next);docPair.current={doc:transaction.doc,value:next,files:latest.current.hostImages?.files};if(mounted.current)setHardNotice('');return true;}
    catch{if(mounted.current)setHardNotice(rejectedEdit);return false;}
  }})];}}),[]);
  const editor=useEditor({immediatelyRender:false,extensions:[StarterKit.configure({blockquote:false,code:false,codeBlock:false,
    heading:false,horizontalRule:false,link:hostLinks?{autolink:false,linkOnPaste:false,openOnClick:false,HTMLAttributes:{target:null,rel:null,class:null,title:null},isAllowedUri:(url:string)=>{try{return canonicalNativeComposeLink(url)===url;}catch{return false;}}}:false,strike:false,underline:false,trailingNode:false,orderedList:{keepMarks:true}}),...((hostLinks||validateValue)?[boundedDocument,...(hostImages?[hostImages.extension]:[])]:[])],
    content:'',editable:!disabled,
    editorProps:{attributes:{class:'deft-editor px-1 py-4 text-[0.9375rem] leading-7 outline-none'+(hostLinks?' [&_a]:text-[var(--primary)] [&_a]:underline [&_a]:underline-offset-2 [&_a:focus-visible]:outline [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-[var(--primary)] [&_a:focus-visible]:outline-offset-2':''),style:'min-height:clamp(12rem,35dvh,24rem);',role:presentationOnly?'document':'textbox','aria-multiline':presentationOnly?'false':'true','aria-label':label},
      handlePaste(view,event){event.preventDefault();if(latest.current.disabled)return true;
        const raw=event.clipboardData?.getData('text/plain')??'',text=latest.current.preserveWhitespace?raw.replace(/\r\n?/gu,'\n'):raw,before=view.state.doc;if(latest.current.hostLinks&&text.length>NATIVE_COMPOSE_BODY_LIMITS.maxPlainCharacters){setHardNotice(rejectedEdit);return true;}if(text)view.dispatch(view.state.tr.insertText(text));
        if(!latest.current.hostLinks||view.state.doc!==before)setNotice('Pasted as text. Apply formatting with the editor controls.');return true;},
      handleDrop(_view,event){event.preventDefault();setNotice('Use the attachment control to add files.');return true;}},
    onUpdate({editor:e}){if(!hydrated.current||latest.current.disabled||latest.current.value.html===''||latest.current.hostLinks&&!mounted.current)return;
      if(latest.current.hostLinks){
        try{const next=docPair.current?.doc===e.state.doc&&docPair.current.files===latest.current.hostImages?.files?docPair.current.value:nativeComposeDraftFromEditorDocument(e.getJSON(),{inlineAttachments:latest.current.hostImages?.files});
          docPair.current={doc:e.state.doc,value:next,files:latest.current.hostImages?.files};published.current={doc:e.state.doc,value:next,files:latest.current.hostImages?.files};latest.current.onChange(next);
          setNotice(next.html.length>latest.current.maxCharacters||next.plainText.length>latest.current.maxPlainCharacters?'This draft needs correction before it can be sent.':'');}
        catch{setHardNotice(rejectedEdit);}
      }else{try{latest.current.onChange(safeComposeHtmlFromEditorDocument(e.getJSON()));setNotice('');}
        catch{latest.current.onChange({html:e.getHTML(),plainText:e.getText({blockSeparator:'\n'})});setNotice('This draft needs correction before it can be sent.');}}
      redraw(count=>count+1);},onSelectionUpdate(){redraw(count=>count+1);},
  });
  useEffect(()=>{editor?.setEditable(!disabled);},[editor,disabled]);
  useEffect(()=>{
    hydrated.current=false;
    if(!editor||value.html==='')return;
    if(published.current?.doc===editor.state.doc&&published.current.files===hostImages?.files&&published.current.value.html===value.html&&published.current.value.plainText===value.plainText){hydrated.current=true;return;}
    try {if(validation)throw Error();
      let current='';try{current=hostLinks&&docPair.current?.doc===editor.state.doc&&docPair.current.files===hostImages?.files?docPair.current.value.html:fromDocument(editor.getJSON()).html;}catch{current=editor.getHTML();}
      if(current!==value.html)editor.commands.setContent(value.html,{emitUpdate:false,...(preserveWhitespace?{parseOptions:{preserveWhitespace:'full' as const}}:{})});
      hydrated.current=true;
    }catch{/* Never parse invalid retained HTML into a browser document. */}
  },[editor,value.html,value.plainText,maxCharacters,preserveWhitespace,hostLinks,validation,hostImages?.files]);
  useEffect(()=>{if(!hostImages||presentationOnly)return;let active=true;const port:ComposeImagePort={insert(fileId,alt){
    if(!active||!mounted.current||!editor||!hydrated.current||latest.current.disabled||!latest.current.hostImages?.files.some(file=>file.file_id===fileId))return false;
    try{const node=editor.schema.nodes.nativeInlineImage?.create({fileId,alt});if(!node)return false;const before=editor.state.doc;editor.view.dispatch(editor.state.tr.replaceSelectionWith(node,false));if(editor.state.doc===before)return false;editor.commands.focus();return true;}catch{return false;}
  }};hostImages.register(port);return()=>{active=false;hostImages.register(null,port);};},[editor,hostImages?.register,presentationOnly]);
  const [imageEdit,setImageEdit]=useState<{doc:object;from:number;fileId:string}|null>(null),[imageAlt,setImageAlt]=useState('');
  const selectedImage=editor&&'node' in editor.state.selection?(editor.state.selection as unknown as {node:{type:{name:string};attrs:{fileId:string;alt:string}}}).node:null;
  const changeImage=(remove=false)=>{if(!imageEdit||!editor||latest.current.disabled||!mounted.current||editor.state.doc!==imageEdit.doc||editor.state.selection.from!==imageEdit.from){setImageEdit(null);return;}
   try{const transaction=remove?editor.state.tr.deleteSelection():editor.state.tr.setNodeMarkup(imageEdit.from,undefined,{fileId:imageEdit.fileId,alt:imageAlt});nativeSafeComposeHtmlFromEditorDocument(transaction.doc.toJSON(),{inlineAttachments:latest.current.hostImages?.files});editor.view.dispatch(transaction);setImageEdit(null);editor.commands.focus();}catch{setNotice('Use an image description within the message limits.');}
  };
  const enableRich=()=>{try{const html=hostLinks?plainTextToNativeComposeHtml(value.plainText,{maxCharacters}):plainTextToSafeComposeHtml(value.plainText);parseHtml(html,{maxCharacters});
    onChange({html:html||'<p></p>',plainText:value.plainText});setNotice('');}catch{setNotice('Shorten the message before adding formatting.');}};
  if(presentationOnly)return <div role="document" aria-label={label} className="min-w-0 whitespace-pre-wrap break-words text-[0.9375rem] leading-7">
    {error?<><p role="status" className="text-xs text-[var(--muted)]">Formatting unavailable. Saved text is shown.</p><div>{value.plainText}</div></>:value.html===''?value.plainText:<EditorContent editor={editor}/>}
  </div>;
  if(value.html==='')return <div className="space-y-2">
    <ExperienceComposePlainEditor label={label} value={{format:'plain',text:value.plainText}} maxCharacters={maxPlainCharacters} maxBytes={4*maxPlainCharacters}
      disabled={disabled} onChange={next=>onChange({html:'',plainText:next.text})}/>
    <button type="button" className={button} style={{minHeight:44}} disabled={disabled} onClick={enableRich}>Add formatting</button>
    {notice&&<p className="text-xs text-[var(--on-surface-variant)]" role="status">{notice}</p>}
  </div>;
  const openLink=()=>{
    if(!mounted.current||!hostLinks||!latest.current.hostLinks||!editor||latest.current.disabled||!hydrated.current||error)return;
    try{if(parseNativeSafeComposeHtml(latest.current.value.html,{maxCharacters,inlineAttachments:latest.current.hostImages?.files}).plainText!==latest.current.value.plainText)return;}catch{return;}
    const existing=editor.isActive('link');if(existing)editor.chain().extendMarkRange('link').run();
    const {from,to}=editor.state.selection;if(from===to){setNotice('Select text to add a link.');return;}
    const href=existing?String(editor.getAttributes('link').href??''):'';
    const owner={value:latest.current.value,doc:editor.state.doc,from,to,text:editor.state.doc.textBetween(from,to,'\n'),href,existing};
    linkOwner.current=owner;setLinkEdit(owner);setLinkURL(href);setNotice('');
  };
  const changeLink=(remove=false)=>{
    const owner=linkOwner.current;
    if(!owner||!editor||!mounted.current||latest.current.disabled||!hydrated.current||!latest.current.hostLinks||editor.state.doc!==owner.doc||editor.state.selection.from!==owner.from||editor.state.selection.to!==owner.to||latest.current.value.html!==owner.value.html||latest.current.value.plainText!==owner.value.plainText){closeLink();return;}
    try{
      const mark=editor.schema.marks.link;if(!mark)throw Error();
      const transaction=editor.state.tr.removeMark(owner.from,owner.to,mark);
      if(!remove)transaction.addMark(owner.from,owner.to,mark.create({href:canonicalNativeComposeLink(linkURL)}));
      const next=nativeSafeComposeHtmlFromEditorDocument(transaction.doc.toJSON(),{inlineAttachments:latest.current.hostImages?.files});
      if(next.html.length>maxCharacters||next.plainText.length>maxPlainCharacters)throw Error();
      linkOwner.current=null;setLinkEdit(null);editor.view.dispatch(transaction);editor.commands.focus();setNotice('');
    }catch{setNotice('Use a valid http, https or mailto link within the formatting limit.');}
  };
  const commands=[{label:'Bold',icon:Bold,active:'bold',run:()=>editor?.chain().focus().toggleBold().run()},
    {label:'Italic',icon:Italic,active:'italic',run:()=>editor?.chain().focus().toggleItalic().run()},
    {label:'Bullet list',icon:List,active:'bulletList',run:()=>editor?.chain().focus().toggleBulletList().run()},
    {label:'Numbered list',icon:ListOrdered,active:'orderedList',run:()=>editor?.chain().focus().toggleOrderedList().run()}];
  return <div className="min-w-0 space-y-2 pt-4" aria-describedby={`${id}-notice`}>
    <div className="flex flex-wrap items-center justify-between gap-1"><span id={`${id}-label`} className="text-xs text-[var(--on-surface-variant)]">{label}</span>
      <button type="button" className={button} style={{minHeight:44}} disabled={disabled} onClick={()=>{setHardNotice('');onChange({html:'',plainText:value.plainText});}}>Use plain text</button></div>
    <div className={`overflow-hidden rounded-lg bg-transparent focus-within:ring-2 focus-within:ring-[var(--primary)] ${error?'border-[var(--error)]':'border-[var(--outline-variant)]'}`}>
      <div className="flex w-fit max-w-full flex-wrap gap-1 rounded-full bg-[var(--surface-container-low)] p-1" role="toolbar" aria-label={`${label} formatting`}>
        {commands.map(command=><button key={command.label} type="button" className={`${button} ${editor?.isActive(command.active)?'bg-[var(--surface-container-high)] text-[var(--primary)]':''}`}
          style={{minHeight:44,minWidth:44}} title={command.label} aria-label={command.label} disabled={disabled||!editor||Boolean(error)} aria-pressed={editor?.isActive(command.active)??false} onClick={command.run}><command.icon size={16} aria-hidden="true" /></button>)}
        {hostLinks&&<button type="button" className={button} style={{minHeight:44,minWidth:44}} aria-label="Link" title="Link" aria-expanded={Boolean(linkEdit)} aria-controls={`${id}-link`} disabled={disabled||!editor||Boolean(error)} onClick={openLink}><Link2 size={16} aria-hidden="true"/></button>}
      </div>
      {hostImages&&selectedImage?.type.name==='nativeInlineImage'&&<button type="button" className={button} style={{minHeight:44}} disabled={disabled} onClick={()=>{if(!editor)return;setImageEdit({doc:editor.state.doc,from:editor.state.selection.from,fileId:selectedImage.attrs.fileId});setImageAlt(selectedImage.attrs.alt);}}>Edit image description</button>}
      {imageEdit&&<div role="dialog" aria-label="Edit image description" className="my-2 space-y-2 rounded-xl bg-[var(--surface-container)] p-3" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();setImageEdit(null);editor?.commands.focus();}}}><label className="block text-xs">Image description<input aria-label="Image description" value={imageAlt} maxLength={255} disabled={disabled} onChange={event=>setImageAlt(event.target.value)} className="block min-h-10 w-full rounded-lg bg-[var(--surface)] px-2"/></label><button type="button" className={button} disabled={disabled} onClick={()=>changeImage()}>Apply description</button><button type="button" className={button} disabled={disabled} onClick={()=>changeImage(true)}>Remove image from message</button><button type="button" className={button} onClick={()=>{setImageEdit(null);editor?.commands.focus();}}>Cancel</button></div>}
      {linkEdit&&<div ref={linkPanel} id={`${id}-link`} role="dialog" aria-label={linkEdit.existing?'Edit link':'Add link'} className="my-2 max-w-full space-y-2 rounded-xl bg-[var(--surface-container)] p-3 text-sm" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeLink(true);}}}>
        <p className="truncate text-xs text-[var(--on-surface-variant)]">{linkEdit.text}</p>
        <label className="block space-y-1"><span className="text-xs">Link address</span><input ref={linkInput} value={linkURL} maxLength={4096} disabled={disabled} onChange={event=>setLinkURL(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();changeLink();}}} className="min-h-10 w-full rounded-lg bg-[var(--surface)] px-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"/></label>
        <div className="flex flex-wrap gap-1"><button type="button" className={button} style={{minHeight:44}} disabled={disabled} onClick={()=>changeLink()}>Apply link</button>{linkEdit.existing&&<button type="button" className={button} style={{minHeight:44}} disabled={disabled} onClick={()=>changeLink(true)}>Remove link</button>}<button type="button" className={button} style={{minHeight:44}} onClick={()=>closeLink(true)}>Cancel</button></div>
      </div>}
      {!error?<EditorContent editor={editor}/>:<div className="p-3"><p className="mb-2 text-xs text-[var(--error)]">{error}</p>
        <textarea aria-label={`${label} retained formatting`} className="min-h-48 w-full rounded-lg bg-[var(--surface)] text-sm" value={value.html} disabled={disabled}
          onChange={event=>{const html=event.target.value;let plainText=value.plainText;try{plainText=parseHtml(html,{maxCharacters}).plainText;}catch{}onChange({html,plainText});}}/></div>}
    </div>
    <p id={`${id}-notice`} role="status" className={`text-xs ${error?'text-[var(--error)]':'text-[var(--on-surface-variant)]'}`}>
      {hardNotice||error||notice||`${value.plainText.length.toLocaleString()} / ${maxPlainCharacters.toLocaleString()} plain characters · ${value.html.length.toLocaleString()} / ${maxCharacters.toLocaleString()} formatting characters`}
    </p>
  </div>;
}
