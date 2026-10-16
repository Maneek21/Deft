import { parseExperienceView, type ExperienceNode, type ExperienceView, type ExperienceViewOptions } from './app-experience-bridge';
import { createExperienceDocumentElement, printExperienceDocument } from './app-experience-safe-document';
import { bindExperienceKeyboard, cancelExperienceKeyboardFocus } from './app-experience-keyboard';

export type ExperienceUiEvent = Readonly<{
  kind: 'click' | 'input' | 'grid_select' | 'grid_edit' | 'canvas_stroke';
  node_id: string;
  row_id?: string;
  column?: number;
  value?: string;
  points?: readonly Readonly<{ x: number; y: number }>[];
  richtext?: Readonly<{ html: string; plain_text: string }>;
  draft_revision?: number;
  file_ids?: readonly string[];
  record_id?:string;record_revision?:number;content_digest?:string;record_state?:string;valid?:boolean;dirty?:boolean;
}>;
export type ExperienceDocumentContext = Readonly<{ signal: AbortSignal; current: () => boolean }>;
type DocumentNode = Extract<ExperienceNode, { kind: 'document' }>;
type ResourceDocumentNode = Extract<ExperienceNode, { kind: 'resource_document' }>;
type RecordDocumentNode=Extract<ExperienceNode,{kind:'record_document'}>;
export type ExperienceRendererOptions = ExperienceViewOptions & Readonly<{
  enhanceDocument?: (node: DocumentNode, wrapper: HTMLElement) => void | (() => void);
  printDocument?: (node: Extract<ExperienceNode, { kind: 'document' }>) => boolean;
  openRecordIntegration?: (node:RecordDocumentNode,kind:'task'|'knowledge',context:ExperienceDocumentContext)=>Promise<void>;
  resolveResourceDocument?: (node: ResourceDocumentNode, context: ExperienceDocumentContext) => Promise<DocumentNode>;
  enhanceResourceDocument?: (node: ResourceDocumentNode, resolved: DocumentNode, wrapper: HTMLElement,
    context: ExperienceDocumentContext) => void | (() => void);
  mountMenu?: (node:Extract<ExperienceNode,{kind:'menu'}>,wrapper:HTMLElement,select:(id:string)=>unknown,context:ExperienceDocumentContext)=>void|(()=>void);
  mountControl?: (node: Extract<ExperienceNode, {kind:'richtext_field'|'file_field'|'resource_refresh'}>,
    wrapper: HTMLElement, emit: (event: ExperienceUiEvent) => unknown, context: ExperienceDocumentContext) => void | (() => void);
  mountRecordMirrorControl?:(node:Extract<ExperienceNode,{kind:'record_mirror_control'}>,wrapper:HTMLElement,emit:(event:ExperienceUiEvent)=>unknown,context:ExperienceDocumentContext)=>void|(()=>void);
  mountLocalJobControl?:(node:Extract<ExperienceNode,{kind:'local_job_schedule'|'local_job_list'}>,wrapper:HTMLElement,emit:(event:ExperienceUiEvent)=>unknown,context:ExperienceDocumentContext)=>void|(()=>void);
  mountRecordForm?:(node:Extract<ExperienceNode,{kind:'record_form'}>,wrapper:HTMLElement,emit:(event:ExperienceUiEvent)=>unknown,context:ExperienceDocumentContext)=>void|(()=>void);
  resolveRecordDocument?:(node:RecordDocumentNode,context:ExperienceDocumentContext)=>Promise<DocumentNode>;
  enhanceRecordDocument?:(node:RecordDocumentNode,resolved:DocumentNode,wrapper:HTMLElement,context:ExperienceDocumentContext)=>void|(()=>void);
}>;
type RendererContext = ExperienceRendererOptions & Readonly<{
  printControls: ReadonlyMap<string, DocumentNode | ResourceDocumentNode | RecordDocumentNode>;
  recordDocuments: ReadonlyMap<string,RecordDocumentNode>;
  resolvedDocuments: Map<string, DocumentNode>;
  signal: AbortSignal;
  addDisposer: (dispose: void | (() => void)) => void;
  current: () => boolean;
}>;
type ExperienceEventDelivery = (event: ExperienceUiEvent) => unknown;

export const EXPERIENCE_RENDERER_CSS = `
.deft-experience { font:inherit; line-height:1.5; container-type:inline-size; color:var(--foreground,#1e293b); background:var(--surface,#fff); min-height:100%; padding:24px; box-sizing:border-box }
.deft-experience * { box-sizing:border-box }
.deft-experience .ex-mirror-fields > button { justify-self:start }
.deft-experience .ex-mirror-fields > label { display:grid; gap:6px; max-width:360px; width:100% }
.deft-experience .ex-stack { display:grid; gap:16px; min-width:0; align-content:start }
.deft-experience .ex-stack-list { gap:0 }
.deft-experience .ex-stack-horizontal { display:flex; flex-wrap:wrap; align-items:center; gap:10px }
.deft-experience .ex-stack-split { grid-template-columns:minmax(240px,32%) minmax(0,1fr); gap:24px }
.deft-experience .ex-stack-panel { padding:20px; border:0; border-radius:14px; background:var(--surface-container-low,#f8fafc) }
.deft-experience .ex-stack-title { margin:0; font-size:18px; font-weight:650; letter-spacing:-.02em; grid-column:1/-1 }
.deft-experience .ex-grid-scroll { overflow:auto; border:1px solid var(--border,#e2e8f0); border-radius:10px; max-width:100% }
.deft-experience .ex-grid-scroll table { width:100%; min-width:560px; border-collapse:collapse; background:var(--surface,#fff) }
.deft-experience .ex-grid-scroll th,.deft-experience .ex-grid-scroll td { border-bottom:1px solid var(--border,#e2e8f0); padding:7px 8px; text-align:left }
.deft-experience .ex-grid-scroll th { background:var(--surface-container-low,#f8fafc); color:var(--foreground-secondary,#64748b); font-size:12px; white-space:nowrap }
.deft-experience .ex-grid-scroll tr[aria-selected=true] { background:var(--accent-subtle,#eff6ff) }
.deft-experience input,.deft-experience textarea { width:100%; min-width:80px; padding:10px 12px; border:1px solid transparent; border-radius:7px; color:var(--foreground,#1e293b); background:transparent; font:inherit }
.deft-experience input:focus,.deft-experience textarea:focus { outline:2px solid var(--accent,#93c5fd); border-color:var(--accent,#3b82f6); background:var(--surface,#fff) }
.deft-experience button { min-height:44px; border:1px solid transparent; background:var(--accent,#2563eb); color:var(--on-primary-container,#fff); border-radius:999px; padding:10px 16px; cursor:pointer; font:inherit; font-weight:600; transition:background-color 150ms,opacity 150ms }
.deft-experience button:hover { filter:brightness(.97) }
.deft-experience button:focus-visible { outline:2px solid var(--accent,#3b82f6); outline-offset:2px }
.deft-experience button:disabled { cursor:default; opacity:.5 }
.deft-experience .ex-button-secondary { background:var(--surface-container-low,#f1f5f9); border-color:transparent; color:var(--foreground-secondary,#475569) }
.deft-experience .ex-button-ghost { background:transparent; border-color:transparent; color:var(--foreground-secondary,#475569) }
.deft-experience .ex-button-list { width:100%; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:5px 12px; text-align:left; border:0; border-radius:0; background:var(--surface,#fff); color:var(--foreground,#1e293b); padding:16px }
.deft-experience .ex-button-list:hover { background:var(--surface-container-low,#f8fafc); filter:none }
.deft-experience .ex-button-list[aria-pressed=true] { background:var(--accent-subtle,#eff6ff); box-shadow:inset 3px 0 var(--accent,#2563eb) }
.deft-experience .ex-button-description { grid-column:1/-1; color:var(--foreground-secondary,#64748b); font-weight:400; font-size:13px; white-space:pre-wrap; overflow-wrap:anywhere }
.deft-experience .ex-button-meta { color:var(--foreground-secondary,#64748b); font-size:11px; font-weight:400 }
.deft-experience .ex-button-label { overflow-wrap:anywhere }
.deft-experience .ex-button-list .ex-button-label { font-size:14px }
.deft-experience .ex-button-list .ex-button-description { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden }
.deft-experience .ex-text { margin:0; white-space:pre-wrap; overflow-wrap:anywhere }
.deft-experience .ex-text-muted { color:var(--foreground-secondary,#64748b) }
.deft-experience .ex-text-heading { font-family:var(--font-heading,inherit); font-size:20px; font-weight:600; letter-spacing:-.025em; line-height:1.4 }
.deft-experience .ex-text-caption { color:var(--foreground-secondary,#64748b); font-size:12px }
.deft-experience .ex-field { display:grid; gap:6px; min-width:0 }
.deft-experience .ex-field label { display:grid; gap:6px; color:var(--foreground-secondary,#475569); font-size:12px; font-weight:550 }
.deft-experience .ex-field input,.deft-experience .ex-field textarea { min-height:44px; border-color:#cbd5e1; border-color:transparent; background:var(--surface-container-low,#f8fafc); font-weight:400; font-size:14px }
.deft-experience .ex-field textarea { min-height:220px; resize:vertical; line-height:1.6 }
.deft-experience canvas { display:block; width:100%; height:200px; border:1px solid var(--border-default,#cbd5e1); border-radius:9px; background:var(--surface-container-low,#f8fafc); touch-action:none }
.deft-experience.ex-workspace { padding:0; height:100%; min-height:0; overflow:hidden }
.deft-experience .ex-stack-workspace { display:flex; flex-direction:column; gap:0; height:100%; min-height:0; overflow:hidden }
.deft-experience .ex-stack-workspace > .ex-stack-split { flex:1; min-height:0; grid-template-columns:clamp(340px,32%,380px) minmax(0,1fr); grid-template-rows:minmax(0,1fr); gap:0; overflow:hidden }
.deft-experience .ex-stack-sidebar { border-right:1px solid var(--border,#e2e8f0); padding:0; overflow:auto; min-height:0; gap:0; background:var(--surface,#fff) }
.deft-experience .ex-stack-document { padding:28px 32px; overflow:auto; min-height:0; gap:20px; background:var(--surface,#fff) }
.deft-experience .ex-stack-toolbar { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; padding:12px 20px; position:sticky; top:0; z-index:1; flex-shrink:0; background:var(--surface,#fff) }
.deft-experience .ex-stack-toolbar > .ex-field-search { flex:1; min-width:180px; max-width:420px }
.deft-experience .ex-stack-sidebar > .ex-text { padding:12px 20px }
.deft-experience .ex-stack-sidebar > .ex-stack-list > .ex-text { padding:24px 20px 12px; font-size:14px }
.deft-experience .ex-stack-sidebar > .ex-button-ghost { justify-self:start; margin:0 8px 12px }
.deft-experience .ex-stack-sidebar > .ex-stack-horizontal { padding:12px 16px }
.deft-experience .ex-stack-sidebar > .ex-field-search { margin:12px 16px }
.deft-experience .ex-text-body { max-width:68ch; font-size:14px; line-height:1.8; color:var(--foreground,#1e293b) }
.deft-experience .ex-button-list { padding:16px 20px; gap:4px 16px; background:transparent }
.deft-experience .ex-button-list[aria-pressed=true] { background:var(--accent-subtle,#eff6ff); box-shadow:inset 2px 0 var(--accent,#2563eb) }
.deft-experience .ex-button-list .ex-button-label { grid-column:1/-1; font-size:14px; font-weight:500; line-height:1.5 }
.deft-experience .ex-button-eyebrow { grid-column:1; grid-row:1; font-size:12px; font-weight:650; color:var(--foreground,#1e293b); overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.deft-experience .ex-button-list .ex-button-meta { grid-column:2; grid-row:1; align-self:center }
.deft-experience .ex-button-list .ex-button-description { font-size:13px; line-height:1.6; -webkit-line-clamp:2 }
.deft-experience button:not(.ex-button-list) { display:inline-flex; align-items:center; justify-content:center; gap:6px; font-family:var(--font-heading,inherit); font-size:12px; border-radius:999px }
.deft-experience .ex-icon { width:16px; height:16px; flex-shrink:0; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round }
.deft-experience .ex-field-search label { position:relative; display:block }
.deft-experience .ex-field-search .ex-field-label,.deft-experience .ex-field-body .ex-field-label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%) }
.deft-experience .ex-field-search .ex-icon { position:absolute; left:12px; top:14px; color:var(--foreground-secondary,#64748b) }
.deft-experience .ex-field-search input { padding-left:38px; border-radius:999px; border-color:transparent; background:var(--surface-container-low,#f8fafc); font-size:13px }
.deft-experience .ex-field-inline label { display:flex; align-items:center; gap:16px; font-weight:400; font-size:13px }
.deft-experience .ex-field-inline .ex-field-label { flex:0 0 56px }
.deft-experience .ex-field-inline input { border:0; border-radius:0; padding:12px 0; background:transparent }
.deft-experience .ex-field-body textarea { border:0; border-radius:0; padding:12px 0; min-height:260px; font-size:15px; line-height:1.8; background:transparent }
@media(pointer:fine) and (min-width:701px) { .deft-experience button:not(.ex-button-list) { min-height:36px; padding:7px 12px } }

.deft-experience .ex-stack-toolbar > .ex-text:first-child { margin-right:auto; font-weight:600; font-size:14px }
.deft-experience .ex-stack-workspace > .ex-stack-toolbar > .ex-text:first-child { font-size:18px; letter-spacing:-.02em }
.deft-experience .ex-stack-horizontal > .ex-field-search { flex:1; min-width:0 }
.deft-experience .ex-stack-horizontal:has(> .ex-field-search) > button > .ex-icon { display:none }
.deft-experience .ex-stack-horizontal > button { flex-shrink:0 }
.deft-experience .ex-stack-document:has(> .ex-field-body) { display:flex; flex-direction:column; gap:0 }
.deft-experience .ex-stack-document:has(> .ex-field-body) > .ex-stack-toolbar { margin:-32px -40px 12px; padding:12px 24px }
.deft-experience .ex-stack-document:has(> .ex-field-body) > .ex-field-body { display:flex; flex:1; min-height:200px; margin-top:12px }
.deft-experience .ex-field-body label { display:flex; flex:1; min-height:0 }
.deft-experience .ex-field-body textarea { flex:1; height:100%; min-height:200px; resize:none }
.deft-experience .ex-stack-document:has(> .ex-field-body) > .ex-stack-horizontal:last-child { margin-top:auto; padding-top:16px; flex-shrink:0 }
.deft-experience .ex-stack-document > .ex-text-muted + .ex-text-caption { margin-top:-16px }
.deft-experience .ex-stack-document > .ex-button-ghost:has(.ex-button-description) { justify-self:start; align-items:flex-start; flex-direction:column; text-align:left; padding:8px 0; color:var(--primary,#6d5bd0) }
.deft-experience .ex-stack-document > .ex-button-ghost:has(.ex-button-description):hover .ex-button-label { text-decoration:underline; text-underline-offset:3px }
.deft-experience .ex-stack-sidebar { background:color-mix(in srgb,var(--foreground,#1e293b) 2%,var(--surface,#fff)); border-right-color:color-mix(in srgb,var(--foreground,#1e293b) 10%,transparent) }
.deft-experience .ex-stack-workspace > .ex-stack:last-child:not(.ex-stack-split):not(.ex-stack-toolbar):not(.ex-stack-sidebar):not(.ex-stack-document) { gap:0 }
.deft-experience .ex-stack-workspace > .ex-stack:last-child:not(.ex-stack-split):not(.ex-stack-toolbar):not(.ex-stack-sidebar):not(.ex-stack-document) > .ex-text:not(:empty) { padding:10px 20px; background:var(--surface-container-low,#f8fafc); font-size:12px }
.deft-experience .ex-text:empty { display:none }

.deft-experience .ex-mobile-only { display:none }
.deft-experience .ex-mobile-only > button { justify-self:start }
@media(max-width:700px) { .deft-experience .ex-stack-document:has(> .ex-field-body) > .ex-stack-toolbar { margin:-24px -20px 12px; padding:12px 16px } .deft-experience .ex-stack-workspace > .ex-stack-split { grid-template-columns:minmax(0,1fr); gap:0 } .deft-experience .ex-stack-document { padding:24px 20px } .deft-experience .ex-stack-sidebar { border-right:0 } .deft-experience .ex-stack-toolbar { padding:12px 16px } .deft-experience .ex-button-list { padding:16px 20px } .deft-experience.ex-workspace { padding:0 } .deft-experience { padding:16px } .deft-experience .ex-stack-split { grid-template-columns:minmax(0,1fr); gap:16px } .deft-experience .ex-stack.ex-mobile-hidden { display:none } .deft-experience .ex-mobile-only { display:grid } .deft-experience .ex-mobile-only.ex-stack-horizontal,.deft-experience .ex-mobile-only.ex-stack-toolbar,.deft-experience .ex-mobile-only.ex-stack-workspace { display:flex } .deft-experience .ex-stack-panel { padding:16px } }
/* Column-owned controls share the workspace hierarchy without adding another app bar. */
.deft-experience .ex-stack-workspace > .ex-stack-split { grid-template-columns:clamp(320px,33%,390px) minmax(0,1fr) }
.deft-experience .ex-stack-sidebar { display:flex; flex-direction:column; background:var(--surface,#fff) }
.deft-experience .ex-stack-sidebar > * { flex-shrink:0 }
.deft-experience .ex-stack-sidebar > .ex-stack-toolbar { align-items:center; gap:10px; padding:14px 16px; min-height:76px }
.deft-experience .ex-stack-sidebar > .ex-stack-toolbar > .ex-stack { gap:2px; min-width:0 }
.deft-experience .ex-stack-sidebar > .ex-stack-toolbar > .ex-stack-horizontal { gap:4px; flex-wrap:nowrap }
.deft-experience .ex-stack-sidebar > .ex-stack-toolbar .ex-text:not(.ex-text-caption) { font-size:16px; font-weight:600; letter-spacing:-.02em }
.deft-experience .ex-stack-toolbar button:is([data-icon=refresh],[data-icon=search],[data-icon=back],[data-icon=close],[data-icon=select],[data-icon=more],[data-icon=archive],[data-icon=trash],[data-icon=mail],[data-icon=read],[data-icon=unread],[data-icon=check],[data-icon=chevron_down],[data-icon=star],[data-icon=folder],[data-icon=label],[data-icon=print]) { width:36px; padding:8px; flex-shrink:0 }
.deft-experience .ex-stack-toolbar button:is([data-icon=refresh],[data-icon=search],[data-icon=back],[data-icon=close],[data-icon=select],[data-icon=more],[data-icon=archive],[data-icon=trash],[data-icon=mail],[data-icon=read],[data-icon=unread],[data-icon=check],[data-icon=chevron_down],[data-icon=star],[data-icon=folder],[data-icon=label],[data-icon=print]) .ex-button-label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%) }
.deft-experience .ex-stack-document { padding:0 28px 28px; gap:18px }
.deft-experience .ex-stack-document > .ex-stack-toolbar { margin:0 -28px; padding:16px 28px; min-height:76px; align-items:center }
.deft-experience .ex-stack-document > .ex-stack-toolbar .ex-text-heading { font-size:18px; line-height:1.4; flex:1; min-width:160px }
.deft-experience .ex-stack-document > .ex-stack-toolbar > .ex-stack-horizontal { gap:4px }
.deft-experience .ex-stack-document > .ex-text:first-child { margin-top:32px }
.deft-experience .ex-document-view { min-width:0; max-width:100%; width:100%; font-size:14px; line-height:1.85; color:var(--foreground,#1e293b); padding:8px 0 20px }
.deft-experience .ex-message-notices { display:grid; gap:4px; margin-bottom:8px; min-width:0 }
.deft-experience .ex-message-notices:not(:has(.ex-message-details)):not(:has(.ex-text:not(:empty))):not(:has(button)),.deft-experience .ex-message-image-controls:not(:has(.ex-text:not(:empty))):not(:has(button)) { display:none }
.deft-experience .ex-message-image-controls { display:flex; flex-wrap:wrap; align-items:center; gap:4px 12px; min-width:0 }
.deft-experience .ex-message-image-controls .ex-text { flex:1 1 220px }
.deft-experience .ex-message-image-controls button { flex-shrink:0; padding:6px 10px; color:var(--primary,#6d5bd0) }
.deft-experience .ex-document-view .ex-safe-document:not(:has(table)) { max-width:70ch }
.deft-experience .ex-stack-document > button { justify-self:start; width:fit-content; max-width:100% }
.deft-experience .ex-stack-toolbar button[data-icon=search] { background:var(--surface-container-low,#f1f5f9) }
.deft-experience .ex-stack-document > .ex-stack-panel { padding:16px; border-radius:12px; gap:10px; background:var(--surface-container-low,#f8fafc) }
.deft-experience .ex-button-list { padding:16px; gap:3px 12px }
.deft-experience .ex-button-eyebrow { font-size:13px; font-weight:600 }
.deft-experience .ex-button-list .ex-button-label { font-size:13px; line-height:1.5 }
.deft-experience .ex-button-list .ex-button-description { font-size:12px; line-height:1.5; -webkit-line-clamp:1 }
.deft-experience .ex-button-list[aria-pressed=true] { background:color-mix(in srgb,var(--accent,#6d5bd0) 8%,var(--surface,#fff)); box-shadow:inset 2px 0 var(--accent,#6d5bd0) }
/* List items use rhythm and selection rather than a rule after every row. */
.deft-experience .ex-stack-document .ex-stack-list > .ex-stack { padding:20px 0; gap:8px }
.deft-experience .ex-stack-document .ex-stack-list > .ex-stack + .ex-stack { margin-top:4px }
.deft-experience .ex-stack-document .ex-stack-list > .ex-stack > .ex-stack-horizontal { gap:6px; padding-top:4px }
.deft-experience .ex-stack-document .ex-stack-list > .ex-stack > .ex-text:first-child { font-size:14px; font-weight:600 }
/* A selectable list row keeps its toggle beside the existing content button. */
.deft-experience .ex-stack-sidebar .ex-stack-list > .ex-stack-horizontal:has(> .ex-button-list) { flex-wrap:nowrap; align-items:stretch; gap:0; padding:0 }
.deft-experience .ex-stack-sidebar .ex-stack-list > .ex-stack-horizontal > .ex-button-list { flex:1; width:auto; min-width:0 }
.deft-experience .ex-stack-sidebar .ex-stack-list > .ex-stack-horizontal:has(> .ex-button-list) > .ex-button-ghost:first-child { width:44px; min-width:44px; padding:0 }
.deft-experience .ex-stack-sidebar .ex-stack-list > .ex-stack-horizontal:has(> .ex-button-list) > .ex-button-ghost:first-child .ex-button-label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%) }
.deft-experience .ex-stack-sidebar .ex-stack-list > .ex-stack-horizontal:has(> .ex-button-list) > .ex-button-ghost:first-child::before { content:''; display:grid; place-items:center; width:16px; height:16px; border:1px solid var(--foreground-secondary,#64748b); border-radius:4px }
.deft-experience .ex-stack-sidebar .ex-stack-list > .ex-stack-horizontal:has(> .ex-button-list) > .ex-button-ghost:first-child[aria-pressed=true]::before { content:'✓'; background:var(--accent,#6d5bd0); border-color:var(--accent,#6d5bd0); color:var(--on-primary-container,#fff); font-size:12px }
.deft-experience .ex-stack-panel .ex-stack-panel { padding:0; border-radius:0; background:transparent }
.deft-experience .ex-stack-document > .ex-stack-horizontal { align-items:flex-start }
.deft-experience .ex-stack-document > .ex-stack-horizontal > .ex-stack { flex:1; gap:3px }
.deft-experience .ex-stack-document > .ex-stack-horizontal > .ex-text-caption { padding-top:3px }
.deft-experience .ex-stack-workspace > .ex-stack-horizontal { flex-shrink:0; flex-wrap:nowrap; overflow-x:auto; padding:8px 16px; gap:4px }
.deft-experience .ex-stack-workspace > .ex-stack-horizontal > button { max-width:240px; min-width:0; flex-shrink:0 }
.deft-experience .ex-stack-workspace > .ex-stack-horizontal > button .ex-button-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.deft-experience .ex-stack-workspace > .ex-text-caption { margin:0; padding:8px 16px; font-size:12px; color:var(--foreground-secondary,#64748b); flex-shrink:0 }
.deft-experience .ex-stack-toolbar button[aria-pressed=true] { background:var(--accent-subtle,#eff6ff); color:var(--primary,#6d5bd0) }
.deft-experience-preferences.deft-experience { padding:0; min-height:0 }
.deft-experience-preferences.deft-experience .ex-stack-panel { padding:0; background:transparent }
.deft-experience-preferences.deft-experience .ex-field textarea { min-height:132px; border-radius:12px; padding:12px }
.deft-experience-preferences.deft-experience .ex-field label { display:grid; gap:8px }
.deft-experience-preferences.deft-experience .ex-field .ex-field-label { position:static; width:auto; height:auto; clip-path:none; flex:auto }
.deft-experience-preferences.deft-experience .ex-stack { gap:14px }
@media(pointer:coarse) { .deft-experience .ex-stack-toolbar button[data-icon] { min-height:44px; min-width:44px } }
@media(max-width:700px) { .deft-experience .ex-stack-workspace > .ex-stack-split { grid-template-columns:minmax(0,1fr) } .deft-experience .ex-stack-document { padding:0 20px 24px } .deft-experience .ex-stack-document > .ex-stack-toolbar { margin:0 -20px; padding:12px 20px } }
.deft-experience .ex-button-list:is([data-icon=select],[data-icon=check]) { grid-template-columns:20px minmax(0,1fr) auto }
.deft-experience .ex-button-list:is([data-icon=select],[data-icon=check]) > .ex-icon { grid-column:1; grid-row:1/4; align-self:center }
.deft-experience .ex-button-list:is([data-icon=select],[data-icon=check]) > .ex-button-eyebrow { grid-column:2; grid-row:1 }
.deft-experience .ex-button-list:is([data-icon=select],[data-icon=check]) > .ex-button-meta { grid-column:3; grid-row:1 }
.deft-experience .ex-button-list:is([data-icon=select],[data-icon=check]) > .ex-button-label { grid-column:2/4; grid-row:2 }
.deft-experience .ex-button-list:is([data-icon=select],[data-icon=check]) > .ex-button-description { grid-column:2/4; grid-row:3 }
@media(max-width:420px) { .deft-experience { padding:12px } .deft-experience .ex-grid-scroll table { min-width:510px } .deft-experience .ex-stack-title { font-size:16px } }
@container(max-width:700px) { .deft-experience .ex-stack-document:has(> .ex-field-body) > .ex-stack-toolbar { margin:-24px -20px 12px; padding:12px 16px } .deft-experience .ex-stack-workspace > .ex-stack-split { grid-template-columns:minmax(0,1fr); gap:0 } .deft-experience .ex-stack-document { padding:24px 20px } .deft-experience .ex-stack-sidebar { border-right:0 } .deft-experience .ex-stack-toolbar { padding:12px 16px } .deft-experience .ex-button-list { padding:16px 20px } .deft-experience.ex-workspace { padding:0 } .deft-experience .ex-stack-split { grid-template-columns:minmax(0,1fr); gap:16px } .deft-experience .ex-stack.ex-mobile-hidden { display:none } .deft-experience .ex-mobile-only { display:grid } .deft-experience .ex-mobile-only.ex-stack-horizontal,.deft-experience .ex-mobile-only.ex-stack-toolbar,.deft-experience .ex-mobile-only.ex-stack-workspace { display:flex } }
@container(max-width:700px) { .deft-experience .ex-stack-document { padding:0 20px 24px } .deft-experience .ex-stack-document > .ex-stack-toolbar { margin:0 -20px; padding:12px 20px } }

/* Shared compact surfaces; app declarations still own navigation and hierarchy. */
.deft-experience .ex-stack-document{padding:0 24px 24px;gap:14px}
.deft-experience .ex-stack-document>.ex-stack-toolbar{margin:0 -24px;padding:10px 24px;min-height:60px;gap:8px}
.deft-experience .ex-stack-sidebar>.ex-stack-toolbar{min-height:60px;padding:10px 14px;gap:8px}
.deft-experience .ex-stack-sidebar>.ex-button-list{padding:12px 16px}
.deft-experience .ex-stack-document>.ex-text:first-child{margin-top:20px}
.deft-experience .ex-stack-toolbar>.ex-text-heading{font-size:18px;line-height:1.35}
.deft-experience .ex-stack-toolbar .ex-stack-horizontal{gap:4px}
.deft-experience .ex-stack-toolbar:has(.ex-menu),.deft-experience .ex-stack-toolbar:has(.ex-menu) .ex-stack-horizontal{flex-wrap:nowrap}
.deft-experience .ex-menu{display:inline-flex;flex-shrink:0}
.deft-experience .ex-menu button{white-space:nowrap}
.deft-experience .ex-stack-toolbar:has(.ex-menu)>.ex-text-heading{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(max-width:720px){.deft-experience .ex-stack-document{padding:0 16px 20px}.deft-experience .ex-stack-document>.ex-stack-toolbar{margin:0 -16px;padding:10px 16px}}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

export const EXPERIENCE_ICON_PATHS = {
  compose: 'M12 20H4V4h8 M16 3l5 5-9 9H7v-5z M14 5l5 5',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-2l2 2 M4 17l2 2a7 7 0 0 0 12-2',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  reply: 'M9 4l-6 6 6 6 M3 10h10a8 8 0 0 1 8 8v2',
  archive: 'M3 3h18v4H3z M5 7v14h14V7 M10 11h4',
  back: 'M15 18l-6-6 6-6',
  close: 'M6 6l12 12 M6 18L18 6',
  send: 'M22 2L9 15 M22 2l-7 20-6-7-7-6z',
  select: 'M4 4h16v16H4z',
  check: 'M4 4h16v16H4z M7 12l3 3 7-7',
  more: 'M5 11h2v2H5z M11 11h2v2h-2z M17 11h2v2h-2z',
  trash:'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  mail:'M3 5h18v14H3z M3 5l9 7 9-7',
  star:'M12 3l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z',
  folder:'M3 5h7l2 2h9v13H3z',
  label:'M3 3h8l10 10-8 8L3 11z M7 7h.01',
  chevron_down:'M6 9l6 6 6-6',
  read:'M3 8l9-6 9 6v13H3z M3 8l9 6 9-6',
  unread:'M3 5h18v14H3z M3 5l9 7 9-7',
  print:'M6 8V3h12v5 M6 17H3V8h18v9h-3 M6 14h12v7H6z',

} as const;

/** Only host-owned paths enter SVG; authors choose a bounded symbolic name. */
function renderIcon(name: keyof typeof EXPERIENCE_ICON_PATHS): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ex-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', EXPERIENCE_ICON_PATHS[name]); svg.append(path);
  return svg;
}

function paint(canvas: HTMLCanvasElement, strokes: ExperienceNode & { kind: 'canvas' }): void {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(ratio, ratio);
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#7dd3fc';
  for (const stroke of strokes.strokes) {
    if (stroke.points.length < 2) continue;
    ctx.beginPath();
    stroke.points.forEach((point, index) => {
      const x = point.x * rect.width;
      const y = point.y * rect.height;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

type InputDelivery = { values: Map<string, string>; authored: Map<string, string>; pending: Map<string, string>; timer?: ReturnType<typeof setTimeout>; emit: ExperienceEventDelivery };
const inputDeliveries = new WeakMap<HTMLElement, InputDelivery>();
const renderGenerations = new WeakMap<HTMLElement, object>();
const documentLifecycles = new WeakMap<HTMLElement, { controller: AbortController; disposers: (() => void)[] }>();
function disposeDocuments(container: HTMLElement): void {
  renderGenerations.delete(container);
  const lifecycle = documentLifecycles.get(container);
  documentLifecycles.delete(container);
  lifecycle?.controller.abort();
  for (const dispose of lifecycle?.disposers ?? []) { try { dispose(); } catch { /* Continue releasing other host handles. */ } }
}
/** Deliver the final native edits before hiding the private surface. */
export function flushExperienceInputs(container: HTMLElement): void {
  const delivery = inputDeliveries.get(container);
  if (delivery) flushInputs(delivery);
}

export function clearExperienceView(container: HTMLElement): void {
  cancelExperienceKeyboardFocus(container);
  const delivery = inputDeliveries.get(container);
  if (delivery?.timer) clearTimeout(delivery.timer);
  inputDeliveries.delete(container);
  disposeDocuments(container);
  container.replaceChildren();
}
/** Keep only native edits not yet acknowledged by the author during suspension. */
export function suspendExperienceView(container: HTMLElement): void {
  cancelExperienceKeyboardFocus(container);
  disposeDocuments(container);
  const delivery = inputDeliveries.get(container);
  if (delivery) {
    for (const input of container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[data-focus-key],textarea[data-focus-key]')) {
      const key = input.dataset.focusKey;
      if (key && delivery.authored.has(key) && input.value !== delivery.authored.get(key)) delivery.values.set(key, input.value);
    }
  }
  container.replaceChildren();
}
function flushInputs(delivery: InputDelivery): void {
  if (delivery.timer) clearTimeout(delivery.timer);
  delivery.timer = undefined;
  const pending = Array.from(delivery.pending); delivery.pending.clear();
  pending.forEach(([node_id, value]) => delivery.emit({ kind: 'input', node_id, value }));
}

function activateControl(id:string,emit:ExperienceEventDelivery,delivery:InputDelivery,options:RendererContext):unknown {
  if(!options.current()||options.signal.aborted)return;
  const linked=options.printControls.get(id);
  if(linked){
    const document=linked.kind==='resource_document'||linked.kind==='record_document'?options.resolvedDocuments.get(linked.id):linked;
    if(linked.kind==='resource_document'||linked.kind==='record_document'){if(document)options.printDocument?.(document);return;}
    if(document&&!options.printDocument?.(document))printExperienceDocument({format:document.format,content:document.content,...(document.truncated===undefined?{}:{truncated:document.truncated})},document.title,document.metadata);
    return;
  }
  flushInputs(delivery);delivery.values.clear();return emit({kind:'click',node_id:id});
}

function renderNode(node: ExperienceNode, emit: ExperienceEventDelivery, delivery: InputDelivery, options: RendererContext, compactButtons = false): HTMLElement {
  if(node.kind==='menu'){
    const wrap=el('div','ex-menu');wrap.dataset.renderKey=node.id;
    if(!options.mountMenu){wrap.textContent='Menu unavailable.';return wrap;}
    options.addDisposer(options.mountMenu(node,wrap,id=>{const item=node.items.find(row=>row.id===id);if(!options.current()||options.signal.aborted||node.disabled||!item||item.disabled)return;
      if(item.integration){const target=options.recordDocuments.get(item.integration.document_id);if(target&&options.resolvedDocuments.has(target.id))return options.openRecordIntegration?.(target,item.integration.kind,{signal:options.signal,current:options.current});return;}
      return activateControl(id,emit,delivery,options);},{signal:options.signal,current:options.current}));return wrap;
  }
  if(node.kind==='record_mirror_control'){const wrap=document.createElement('section');if(!options.mountRecordMirrorControl){wrap.textContent='Sync settings unavailable.';return wrap;}options.addDisposer(options.mountRecordMirrorControl(node,wrap,event=>options.current()?emit(event):undefined,{signal:options.signal,current:options.current}));return wrap;}
  if(node.kind==='local_job_schedule'||node.kind==='local_job_list'){
    const wrap=document.createElement('section');if(!options.mountLocalJobControl){wrap.textContent='Local job control unavailable.';return wrap;}options.addDisposer(options.mountLocalJobControl(node,wrap,event=>options.current()?emit(event):undefined,{signal:options.signal,current:options.current}));return wrap;
  }
  if(node.kind==='record_form'){
    const wrap=el('section','ex-field');wrap.dataset.renderKey=node.id;wrap.dataset.keyboardForm='true';
    if(!options.mountRecordForm){wrap.textContent='Record control unavailable.';return wrap;}
    options.addDisposer(options.mountRecordForm(node,wrap,event=>options.current()?emit(event):undefined,{signal:options.signal,current:options.current}));return wrap;
  }
  if (node.kind === 'richtext_field' || node.kind === 'file_field' || node.kind === 'resource_refresh') {
    const wrap = el('section', 'ex-field'); wrap.dataset.renderKey = node.id;
    if (!options.mountControl) { wrap.textContent = 'Control unavailable.'; return wrap; }
    const context = {signal:options.signal,current:options.current};
    options.addDisposer(options.mountControl(node,wrap,event => options.current() ? emit(event) : undefined,context));
    return wrap;
  }
  if (node.kind === 'resource_document'||node.kind==='record_document') {
    const wrap = el('section', 'ex-document-view'); wrap.dataset.renderKey = node.id;
    wrap.setAttribute('aria-busy', 'true'); wrap.textContent = 'Loading document…';
    const context: ExperienceDocumentContext = { signal: options.signal, current: options.current };
    void Promise.resolve().then(() => {
      if (!options.current() || options.signal.aborted) return undefined;
      return node.kind==='record_document'?options.resolveRecordDocument?.(node,context):options.resolveResourceDocument?.(node, context);
    }).then(resolved => {
      if (!options.current() || options.signal.aborted) return;
      const parsed = resolved && parseExperienceView({ root: { ...resolved, id: node.id, printable: false, print_control_id: undefined } });
      if (!parsed || parsed.root.kind !== 'document') throw Error('APP_DOCUMENT_UNAVAILABLE');
      const documentNode: DocumentNode = { ...parsed.root, printable: node.printable,
        ...(node.print_control_id ? { print_control_id: node.print_control_id } : {}) };
      options.resolvedDocuments.set(node.id, documentNode);
      // Existing safe-document rendering remains the only author-content sink.
      const content = renderNode(documentNode, emit, delivery, { ...options, enhanceDocument: undefined,
        // Resolved private bytes are never a fallback print authority. The host
        // must explicitly revalidate the resource presentation at print time.
        printDocument: document => { options.printDocument?.(document); return true; } });
      wrap.textContent = ''; wrap.replaceChildren(content); wrap.removeAttribute('aria-busy');
      options.addDisposer(node.kind==='record_document'?options.enhanceRecordDocument?.(node,documentNode,content,context):options.enhanceResourceDocument?.(node, documentNode, content, context));
    }).catch(() => {
      if (!options.current() || options.signal.aborted) return;
      wrap.removeAttribute('aria-busy'); wrap.textContent = 'Document unavailable.';
    });
    return wrap;
  }
  if (node.kind === 'document') {
    const wrap = el('section','ex-document-view');
    const value = {format:node.format,content:node.content,...(node.truncated === undefined ? {} : {truncated:node.truncated})};
    wrap.append(createExperienceDocumentElement(value));
    if (node.format === 'html') {
      const notice = el('p','ex-text ex-text-caption ex-document-image-policy'); notice.textContent = 'External images are blocked.'; wrap.append(notice);
    }
    if (node.truncated) {
      const notice = el('p','ex-text ex-text-caption ex-document-truncation'); notice.textContent = 'Only part of this document is shown.'; wrap.append(notice);
    }
    if (node.printable && !node.print_control_id) {
      const print = el('button','ex-button-ghost'); print.type = 'button'; print.textContent = 'Print';
      print.addEventListener('click', () => { if (options.current() && !options.printDocument?.(node)) printExperienceDocument(value,node.title,node.metadata); }); wrap.prepend(print);
    }
    options.addDisposer(options.enhanceDocument?.(node, wrap));
    return wrap;
  }
  if (node.kind === 'text') {
    const p = el(node.tone === 'heading' ? 'h2' : 'p', `ex-text ex-text-${node.tone ?? 'default'}`);
    p.textContent = node.text;
    return p;
  }
  if (node.kind === 'button') {
    const button = el('button', `ex-button-${node.variant ?? 'primary'}`);
    button.type = 'button';
    if (node.icon) {
      button.append(renderIcon(node.icon));
      button.dataset.icon = node.icon;
      button.title = node.label;
    }
    if (node.eyebrow !== undefined) {
      const eyebrow = el('span', 'ex-button-eyebrow'); eyebrow.textContent = node.eyebrow; button.append(eyebrow);
    }
    const label = el('span', 'ex-button-label');
    label.textContent = node.label;
    button.append(label);
    if (node.meta !== undefined) {
      const meta = el('span', 'ex-button-meta'); meta.textContent = node.meta; button.append(meta);
    }
    if (node.description !== undefined) {
      if (compactButtons && node.variant !== 'list') {
        button.title = `${node.label}: ${node.description}`; button.setAttribute('aria-description', node.description);
      } else {
        const description = el('span', 'ex-button-description');
        description.textContent = node.description; button.append(description);
      }
    }
    if (node.selected !== undefined) button.setAttribute('aria-pressed', String(node.selected));
    button.disabled = node.disabled ?? false;
    button.dataset.focusKey = node.id;
    button.addEventListener('click', () => {
      if (!options.current()) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      try {
        void Promise.resolve(activateControl(node.id,emit,delivery,options)).catch(() => undefined).finally(() => {
          button.removeAttribute('aria-busy'); button.disabled = node.disabled ?? false;
        });
      } catch {
        button.removeAttribute('aria-busy'); button.disabled = node.disabled ?? false;
      }
    });
    return button;
  }
  if (node.kind === 'input') {
    const wrap = el('div', `ex-field${node.appearance ? ` ex-field-${node.appearance}` : ''}`);
    wrap.dataset.renderKey = node.id;
    const label = el('label');
    const input = node.multiline ? el('textarea') : el('input');
    if (delivery.values.get(node.id) === node.value) delivery.values.delete(node.id);
    delivery.authored.set(node.id, node.value);
    input.value = delivery.values.get(node.id) ?? node.value;
    input.placeholder = node.placeholder ?? '';
    input.dataset.focusKey = node.id;
    const labelText = el('span', 'ex-field-label'); labelText.textContent = node.label;
    label.append(labelText);
    if (node.appearance === 'search') label.append(renderIcon('search'));
    const changed = () => {
      delivery.values.set(node.id, input.value); delivery.pending.set(node.id, input.value);
      if (delivery.timer) clearTimeout(delivery.timer);
      delivery.timer = setTimeout(() => flushInputs(delivery), 200);
    };
    input.addEventListener('input', changed);
    input.addEventListener('change', () => {
      if (delivery.values.get(node.id) !== input.value) changed();
      flushInputs(delivery);
    });
    label.append(input);
    wrap.append(label);
    return wrap;
  }
  if (node.kind === 'stack') {
    const wrap = el('section', `ex-stack ex-stack-${node.layout ?? 'vertical'} ex-stack-${node.surface ?? 'plain'}${node.mobile ? ` ex-mobile-${node.mobile}` : ''}`);
    wrap.dataset.renderKey = node.id;
    if (node.surface === 'sidebar' || node.surface === 'document') wrap.dataset.scrollKey = node.id;
    if (node.title) {
      const title = el('h2', 'ex-stack-title');
      title.textContent = node.title;
      wrap.append(title);
    }
    node.children.forEach((child) => wrap.append(renderNode(child, emit, delivery, options, compactButtons || node.layout === 'toolbar')));
    return wrap;
  }
  if (node.kind === 'grid') {
    const scroll = el('div', 'ex-grid-scroll');
    const table = el('table');
    table.setAttribute('role', 'grid');
    table.setAttribute('aria-label', node.id.replaceAll('_', ' '));
    const head = el('thead');
    const heading = el('tr');
    node.columns.forEach((column) => {
      const th = el('th'); th.textContent = column; heading.append(th);
    });
    head.append(heading);
    const body = el('tbody');
    node.rows.forEach((row, rowIndex) => {
      const tr = el('tr');
      tr.setAttribute('aria-selected', String(row.id === node.selected_row_id));
      tr.addEventListener('click', () => emit({ kind: 'grid_select', node_id: node.id, row_id: row.id }));
      row.cells.forEach((cell, column) => {
        const td = el('td');
        const input = el('input');
        input.value = cell;
        input.setAttribute('aria-label', `${node.columns[column]}, row ${rowIndex + 1}`);
        input.dataset.focusKey = `${node.id}:${row.id}:${column}`;
        input.dataset.gridRow = String(rowIndex);
        input.dataset.gridColumn = String(column);
        input.addEventListener('change', () => emit({
          kind: 'grid_edit', node_id: node.id, row_id: row.id, column, value: input.value,
        }));
        input.addEventListener('keydown', (event) => {
          let targetRow = rowIndex;
          let targetColumn = column;
          if (event.key === 'ArrowDown') targetRow += 1;
          else if (event.key === 'ArrowUp') targetRow -= 1;
          else if (event.key === 'ArrowRight' && input.selectionStart === input.value.length) targetColumn += 1;
          else if (event.key === 'ArrowLeft' && input.selectionStart === 0) targetColumn -= 1;
          else if (event.key === 'Enter') {
            emit({ kind: 'grid_edit', node_id: node.id, row_id: row.id, column, value: input.value });
            targetRow += 1;
          } else return;
          const next = body.querySelector<HTMLInputElement>(
            `input[data-grid-row="${targetRow}"][data-grid-column="${targetColumn}"]`);
          if (next) { event.preventDefault(); next.focus(); next.select(); }
        });
        td.append(input); tr.append(td);
      });
      body.append(tr);
    });
    table.append(head, body); scroll.append(table);
    return scroll;
  }
  const canvas = el('canvas');
  canvas.setAttribute('aria-label', node.id.replaceAll('_', ' '));
  canvas.setAttribute('role', 'img');
  let points: { x: number; y: number }[] | null = null;
  const relative = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
  };
  canvas.addEventListener('pointerdown', (event) => {
    points = [relative(event)]; canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (points && points.length < 512) points.push(relative(event));
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!points) return;
    points.push(relative(event));
    emit({ kind: 'canvas_stroke', node_id: node.id, points });
    points = null;
  });
  requestAnimationFrame(() => paint(canvas, node));
  return canvas;
}

/** Keep native editors and their ancestor path connected during ordinary view updates. */
function patchInputPath(current: HTMLElement, next: HTMLElement): HTMLElement {
  if (current.tagName !== next.tagName || current.dataset.renderKey !== next.dataset.renderKey
    || current.dataset.focusKey !== next.dataset.focusKey) return next;
  if ((current instanceof HTMLInputElement && next instanceof HTMLInputElement)
    || (current instanceof HTMLTextAreaElement && next instanceof HTMLTextAreaElement)) {
    current.value = next.value; current.placeholder = next.placeholder;
    return current;
  }
  if (!next.querySelectorAll('input[data-focus-key],textarea[data-focus-key]').length) return next;
  current.className = next.className;
  const desired = Array.from(next.children);
  desired.forEach((child, index) => {
    const previous = current.children[index];
    const patched = previous instanceof HTMLElement && child instanceof HTMLElement
      ? patchInputPath(previous, child) : child;
    if (!previous) current.append(patched);
    else if (patched !== previous) current.replaceChild(patched, previous);
  });
  while (current.children.length > desired.length) current.lastElementChild?.remove();
  return current;
}

/** Author content becomes text/value/canvas strokes only; never HTML or URL sinks. */
export function renderExperienceView(
  container: HTMLElement, view: ExperienceView, emit: ExperienceEventDelivery, options: ExperienceRendererOptions = {},
): void {
  const parsed = parseExperienceView(view, options);
  if (!parsed) { clearExperienceView(container); return; }
  disposeDocuments(container);
  const generation = {}; renderGenerations.set(container, generation);
  const lifecycle = { controller: new AbortController(), disposers: [] as (() => void)[] };
  documentLifecycles.set(container, lifecycle);
  const printControls = new Map<string, DocumentNode | ResourceDocumentNode | RecordDocumentNode>();
  const collectPrint = (node: ExperienceNode) => { if ((node.kind === 'document' || node.kind === 'resource_document'||node.kind==='record_document') && node.printable && node.print_control_id) printControls.set(node.print_control_id, node); else if (node.kind === 'stack') node.children.forEach(collectPrint); };
  collectPrint(parsed.root);
  const recordDocuments=new Map<string,RecordDocumentNode>();const collectRecords=(node:ExperienceNode)=>{if(node.kind==='record_document')recordDocuments.set(node.id,node);else if(node.kind==='stack')node.children.forEach(collectRecords);};collectRecords(parsed.root);
  const context: RendererContext = { ...options, printControls, recordDocuments, resolvedDocuments: new Map(), signal: lifecycle.controller.signal,
    addDisposer: dispose => { if (dispose) lifecycle.disposers.push(dispose); },
    current: () => renderGenerations.get(container) === generation };
  let delivery = inputDeliveries.get(container);
  if (!delivery) {
    delivery = { values: new Map(), authored: new Map(), pending: new Map(), emit };
    inputDeliveries.set(container, delivery);
  }
  delivery.emit = emit;
  const scrollPositions = new Map(Array.from(container.querySelectorAll<HTMLElement>('[data-scroll-key]'))
    .map((element) => [element.dataset.scrollKey, element.scrollTop]));
  const focusedElement = document.activeElement instanceof HTMLElement && container.contains(document.activeElement)
    ? document.activeElement : undefined;
  const focused = focusedElement?.dataset.focusKey;
  const selection = (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement)
    ? { start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : undefined;
  container.classList.add('deft-experience');
  container.classList.toggle('ex-workspace', view.root.kind === 'stack' && view.root.layout === 'workspace');
  const nextRoot = renderNode(parsed.root, emit, delivery, context);
  const previousRoot = container.firstElementChild;
  const root = previousRoot instanceof HTMLElement ? patchInputPath(previousRoot, nextRoot) : nextRoot;
  if (root !== previousRoot) container.replaceChildren(root);
  const currentInputs = new Set(Array.from(container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[data-focus-key],textarea[data-focus-key]'))
    .map(element => element.dataset.focusKey));
  for (const key of delivery.values.keys()) if (!currentInputs.has(key)) { delivery.values.delete(key); delivery.pending.delete(key); }
  for (const key of delivery.authored.keys()) if (!currentInputs.has(key)) delivery.authored.delete(key);
  container.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach((element) => {
    element.scrollTop = scrollPositions.get(element.dataset.scrollKey) ?? 0;
  });
  if (focused) {
    const candidate = Array.from(container.querySelectorAll<HTMLElement>('[data-focus-key]'))
      .find((element) => element.dataset.focusKey === focused);
    candidate?.focus();
    if ((candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) && selection?.start !== null
      && selection?.start !== undefined && selection.end !== null && selection.end !== undefined) {
      candidate.setSelectionRange(selection.start, selection.end);
    }
  } else if (focusedElement && container.contains(focusedElement)) {
    // A retained host rich editor owns its ProseMirror selection. Reparenting
    // during an author acknowledgement must restore focus to that same editor.
    focusedElement.focus();
  }
  if (parsed.keyboard) context.addDisposer(bindExperienceKeyboard(container, parsed.keyboard, context.current));
}
