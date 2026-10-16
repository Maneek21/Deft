import {parseDeftExperienceMenuNode,type DeftExperienceMenuNode} from './experience-menu.js';
export * from './experience-menu.js';
export function createDeftMenuNode(input:Omit<DeftExperienceMenuNode,'kind'>,capabilities:readonly DeftExperienceCapability[]):DeftExperienceMenuNode {
 if(!capabilities.includes('menu.v1'))throw Error('EXPERIENCE_CAPABILITY_UNAVAILABLE');
 if(input&&Object.hasOwn(input,'kind'))throw Error('Invalid menu');
 const node=parseDeftExperienceMenuNode({...input,kind:'menu'});if(!node)throw Error('Invalid menu');return node;
}
import type {DeftExperienceLocalJobScheduleNode,DeftExperienceLocalJobListNode} from './local-job-controls.js';
export {inspectNativeComposeRaster,validateNativeComposeRaster} from './native-compose-raster.js';
// Type-only imports keep the Worker leaf independent of the schema validator.
import type { DeftExperienceCapability, DeftExperienceResourceDocumentNode } from './experience-capabilities.js';
import type { DeftExperienceRichtextFieldNode, DeftExperienceFileFieldNode, DeftExperienceResourceRefreshNode } from './experience-capabilities.js';
import type {AppDataRecord,AppDataResult,DeftExperienceRecordFormV2Node,DeftExperienceRecordFormNode,DeftExperienceRecordDocumentNode} from './app-data.js';
export type {DeftExperienceRecordFormV3Node,DeftExperienceRecordFormV3Profile,DeftExperienceRecordFormV2Node,DeftExperienceRecordFormV2Profile,DeftExperienceRecordFormNode,DeftExperienceRecordDocumentNode} from './app-data.js';
import { parseNativeSafeComposeHtml as parseRichHtml, parseSafeComposeHtml as parseBasicHtml } from './safe-compose-html.js';
export type { DeftExperienceCapability, DeftExperienceCapabilities, DeftExperienceCapabilityRequest,
  DeftExperienceResourceDocumentNode, DeftExperienceRichtextFieldProfile, DeftExperienceFileFieldProfile,
  DeftExperienceFileReference, DeftExperienceResourceRefreshRequest, DeftExperienceResourceFreshness } from './experience-capabilities.js';
export type { DeftExperienceRichtextFieldNode, DeftExperienceFileFieldNode, DeftExperienceResourceRefreshNode } from './experience-capabilities.js';
const controlId = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value);
const controlKey = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(value);
const controlObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const controlClosed = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const controlLimit = (value: unknown, cap: number): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= cap;
function requireControl(input: unknown, capability: DeftExperienceCapability, capabilities: readonly DeftExperienceCapability[], keys: readonly string[], labelCap=128) {
  if (!capabilities.includes(capability)) throw Error('EXPERIENCE_CAPABILITY_UNAVAILABLE');
  if (!controlObject(input) || !controlClosed(input, keys) || !controlId(input.id)
    || typeof input.label !== 'string' || input.label.length < 1 || input.label.length > labelCap
    || input.disabled !== undefined && typeof input.disabled !== 'boolean') throw Error('Invalid Experience control');
}
/** Inline files are unavailable until a scoped CID/disposition custody port ships. */
export function createDeftRichtextFieldNode(input: Omit<DeftExperienceRichtextFieldNode, 'kind'>,
  capabilities: readonly DeftExperienceCapability[]): DeftExperienceRichtextFieldNode {
  requireControl(input, 'richtext_field.v1', capabilities, ['id','label','profile','value','disabled']);
  const p = input.profile, v = input.value;
  if (!controlObject(p) || !controlClosed(p, ['profile_version','format','max_characters','max_bytes','links','inline_images'])
    || p.profile_version !== 'deft.richtext_field.v1' || p.format !== 'safe_compose_html'
    || !controlLimit(p.max_characters, 4096) || !controlLimit(p.max_bytes, 16384)
    || !['none','host_validated'].includes(p.links) || p.inline_images !== 'none'
    || !controlObject(v) || !controlClosed(v, ['html','plain_text']) || typeof v.html !== 'string' || typeof v.plain_text !== 'string'
    || v.html.length > p.max_characters || v.plain_text.length > p.max_characters
    || new TextEncoder().encode(JSON.stringify(v)).byteLength > p.max_bytes) throw Error('Invalid richtext control');
  if (v.html !== '' && (p.links === 'host_validated' ? parseRichHtml : parseBasicHtml)(v.html,
    {maxCharacters:p.max_characters,maxBytes:p.max_bytes}).plainText !== v.plain_text
    || v.html === '' && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]/u.test(v.plain_text)) throw Error('Invalid richtext pair');
  return Object.freeze({kind:'richtext_field',...input,profile:Object.freeze({...p}),value:Object.freeze({...v})});
}
export function createDeftFileFieldNode(input: Omit<DeftExperienceFileFieldNode, 'kind'>,
  capabilities: readonly DeftExperienceCapability[]): DeftExperienceFileFieldNode {
  requireControl(input, 'file_field.v1', capabilities, ['id','label','state_key','record_id','expected_revision','profile','disabled']);
  const p = input.profile;
  if (!controlKey(input.state_key) || !resourceRecordId(input.record_id) || !controlLimit(input.expected_revision,2147483646)
    || !controlObject(p) || !controlClosed(p,['profile_version','max_files','max_file_bytes','max_total_bytes','purpose'])
    || p.profile_version !== 'deft.file_field.v1' || p.purpose !== 'attachment' || !controlLimit(p.max_files,8)
    || !controlLimit(p.max_file_bytes,2097152) || !controlLimit(p.max_total_bytes,8388608)
    || p.max_file_bytes > p.max_total_bytes) throw Error('Invalid file control');
  return Object.freeze({kind:'file_field',...input,profile:Object.freeze({...p})});
}
/** This node only works when the host has negotiated a real refresh adapter.
 * It does not turn readResourceRecord into a provider refresh request. */
export function createDeftResourceRefreshNode(input: Omit<DeftExperienceResourceRefreshNode, 'kind'>,
  capabilities: readonly DeftExperienceCapability[]): DeftExperienceResourceRefreshNode {
  requireControl(input, 'resource_refresh.v1', capabilities, ['id','label','resource_key','record_id','disabled']);
  if (!controlKey(input.resource_key) || input.record_id !== undefined && !resourceRecordId(input.record_id)) throw Error('Invalid refresh control');
  return Object.freeze({kind:'resource_refresh',...input});
}
/** Build a reference only after the host negotiated the resource-document profile.
 * The host validates the reference again against the signed resource declaration. */
export function createDeftResourceDocumentNode(
  input: Omit<DeftExperienceResourceDocumentNode, 'kind' | 'profile_version'>,
  capabilities: readonly DeftExperienceCapability[],
): DeftExperienceResourceDocumentNode {
  if (!capabilities.includes('resource_document.v1')) throw Error('EXPERIENCE_CAPABILITY_UNAVAILABLE');
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['id', 'resource_key', 'record_id', 'printable', 'print_control_id'].includes(key))
    || typeof input.id !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(input.id)
    || typeof input.resource_key !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(input.resource_key)
    || !resourceRecordId(input.record_id) || input.printable !== undefined && typeof input.printable !== 'boolean'
    || input.print_control_id !== undefined && (input.printable !== true || typeof input.print_control_id !== 'string'
      || !/^[a-z][a-z0-9_]{0,63}$/.test(input.print_control_id))) throw Error('Invalid resource document reference');
  return Object.freeze({ kind: 'resource_document', profile_version: 'deft.resource_document.v1', ...input });
}
export function createDeftRecordDocumentNode(input:Omit<DeftExperienceRecordDocumentNode,'kind'|'profile_version'>,
 capabilities:readonly DeftExperienceCapability[]):DeftExperienceRecordDocumentNode {
 if(!capabilities.includes('record_document.v1'))throw Error('EXPERIENCE_CAPABILITY_UNAVAILABLE');
 if(!controlObject(input)||!controlClosed(input,['id','store_key','resource_key','record_id','content_digest','printable','print_control_id','image_policy'])
  ||!controlId(input.id)||!controlKey(input.store_key)||!controlKey(input.resource_key)||!resourceRecordId(input.record_id)
  ||!/^sha256:[a-f0-9]{64}$/u.test(input.content_digest)||input.printable!==undefined&&typeof input.printable!=='boolean'
  ||input.print_control_id!==undefined&&(input.printable!==true||!controlId(input.print_control_id)))throw Error('Invalid record document');
 if(input.image_policy){const p=input.image_policy;if(!capabilities.includes('record_document_policy.v1'))throw Error('EXPERIENCE_CAPABILITY_UNAVAILABLE');if(!controlObject(p)||!controlClosed(p,['store_key','record_id','expected_revision','content_digest','field','automatic_value'])||!controlKey(p.store_key)||!resourceRecordId(p.record_id)||!controlLimit(p.expected_revision,2147483646)||!/^sha256:[a-f0-9]{64}$/u.test(p.content_digest)||!controlKey(p.field)||typeof p.automatic_value!=='string'||!p.automatic_value.length||p.automatic_value.length>64)throw Error('Invalid document policy');}
 return Object.freeze({kind:'record_document',profile_version:'deft.record_document.v1',...input,...(input.image_policy?{image_policy:Object.freeze({...input.image_policy})}:{})});
}
export function createDeftRecordFormNode(input:Omit<DeftExperienceRecordFormNode,'kind'>,
 capabilities:readonly DeftExperienceCapability[]):DeftExperienceRecordFormNode {
 requireControl(input,'record_form.v1',capabilities,['id','label','store_key','record_id','expected_revision','content_digest','profile','seed','initial_change','record_changes','source_refs','action_key','presentation','disabled']);
 if(input.presentation!==undefined){if(!capabilities.includes('record_form_presentation.v1'))throw Error('EXPERIENCE_CAPABILITY_UNAVAILABLE');if(!['normal','minimized'].includes(input.presentation))throw Error('Invalid form presentation');}
 if(!controlKey(input.store_key)||!resourceRecordId(input.record_id)||!(input.seed?input.expected_revision===0:controlLimit(input.expected_revision,2147483646))
  ||!/^sha256:[a-f0-9]{64}$/u.test(input.content_digest)||input.action_key!==undefined&&!controlKey(input.action_key))throw Error('Invalid record form');
 if(input.source_refs!==undefined&&(!Array.isArray(input.source_refs)||input.source_refs.length>1||input.source_refs.some(ref=>!controlObject(ref)||!controlClosed(ref,['resource_key','record_id','content_digest'])||!controlKey(ref.resource_key)||!resourceRecordId(ref.record_id)||!/^sha256:[a-f0-9]{64}$/u.test(ref.content_digest))))throw Error('Invalid record source');
 if(input.record_changes!==undefined&&(!Array.isArray(input.record_changes)||!input.record_changes.length||input.record_changes.length>8||new Set(input.record_changes.map(row=>row.operation_key)).size!==input.record_changes.length||input.record_changes.some(row=>!controlObject(row)||!controlClosed(row,['operation_key','source_store_key','label','parameters'])||!controlKey(row.operation_key)||!controlKey(row.source_store_key)||row.source_store_key===input.store_key||typeof row.label!=='string'||!row.label||row.label.length>160||/[\u0000-\u001f\u007f<>]/u.test(row.label))))throw Error('Invalid record change controls');
 if(input.initial_change){const c=input.initial_change;if(!capabilities.includes('record_initial_change.v1'))throw Error('EXPERIENCE_CAPABILITY_UNAVAILABLE');if(!controlObject(c)||!controlClosed(c,['operation_key','source_store_key','source_identity_field'])||!controlKey(c.operation_key)||!controlKey(c.source_store_key)||c.source_store_key===input.store_key||!controlKey(c.source_identity_field))throw Error('Invalid initial change');}
 if(input.record_changes?.some(row=>row.parameters!==undefined&&row.parameters!=='runtime_prompt'))throw Error('Invalid parameter prompt');
 if(input.record_changes?.some(row=>row.parameters)&&!capabilities.includes('record_change_parameters.v1'))throw Error('EXPERIENCE_CAPABILITY_UNAVAILABLE');
 if(input.seed&&(!capabilities.includes('record_form_seed.v1')||!controlObject(input.seed)||!controlClosed(input.seed,['schema_version','value'])||input.seed.schema_version!=='deft.record_form_seed.v1'||!controlObject(input.seed.value)||new TextEncoder().encode(JSON.stringify(input.seed.value)).byteLength>491520||input.content_digest!=='sha256:'+'0'.repeat(64)||input.source_refs?.length))throw Error('Invalid unsaved seed');
 const p=input.profile;
 if(!controlObject(p)||!controlClosed(p,['schema_version','max_record_bytes','addresses','identity','subject','richtext','files'])
  ||p.schema_version!=='deft.record_form_profile.v1'||!controlLimit(p.max_record_bytes,491520)||!Array.isArray(p.addresses)||p.addresses.length>16
  ||!controlObject(p.subject)||!controlObject(p.richtext)||!controlObject(p.files))throw Error('Invalid record form profile');
 const fields=[...p.addresses.map(row=>row.field),...(p.identity?[p.identity.field]:[]),p.subject.field,p.richtext.html_field,p.richtext.plain_field,p.files.field];
 if(fields.some(field=>!controlKey(field))||new Set(fields).size!==fields.length||!controlLimit(p.subject.max_characters,998)
  ||!controlLimit(p.richtext.max_characters,262144)||p.richtext.links!=='host_validated'||!['none','host_files'].includes(p.richtext.inline_images)
  ||!Number.isSafeInteger(p.files.max_files)||p.files.max_files<0||p.files.max_files>32||!controlLimit(p.files.max_file_bytes,26214400)
  ||!controlLimit(p.files.max_total_bytes,26214400)||p.files.max_file_bytes>p.files.max_total_bytes)throw Error('Invalid record form profile');
 return Object.freeze({kind:'record_form',...input});
}
/** Typed scalar/rich records stay in the host; this reference contains no values. */
export function createDeftRecordFormV2Node(input:Omit<DeftExperienceRecordFormV2Node,'kind'>,
 capabilities:readonly DeftExperienceCapability[]):DeftExperienceRecordFormV2Node {
 requireControl(input,'record_form.v2',capabilities,['id','label','store_key','record_id','expected_revision','content_digest','profile','disabled'],200);
 if(!/^[^\u0000-\u001f\u007f<>]+$/u.test(input.label))throw Error('Invalid record label');
 const key=(value:unknown)=>controlKey(value)&&!['constructor','prototype','__proto__'].includes(value as string);
 const label=(value:unknown)=>typeof value==='string'&&value.length>=1&&value.length<=160&&!/[\u0000-\u001f\u007f<>]/u.test(value);
 if(!key(input.store_key)||!resourceRecordId(input.record_id)||!controlLimit(input.expected_revision,2147483646)||!/^sha256:[a-f0-9]{64}$/u.test(input.content_digest))throw Error('Invalid record fields');
 const p=input.profile;
 if(!controlObject(p)||!controlClosed(p,['schema_version','max_record_bytes','fields','richtext','repeated_fields'])||p.schema_version!=='deft.record_form_profile.v2'
  ||!controlLimit(p.max_record_bytes,491520)||!Array.isArray(p.fields)||p.fields.length>16)throw Error('Invalid record fields profile');
 const mapped:string[]=[];
 for(const f of p.fields){
  if(!controlObject(f)||!key(f.field)||!label(f.label))throw Error('Invalid scalar field');mapped.push(f.field as string);
  const base=['kind','field','label'];
  if(f.kind==='text'){if(!controlClosed(f,[...base,'max_characters','required'])||!controlLimit(f.max_characters,2048)||typeof f.required!=='boolean')throw Error('Invalid text field');}
  else if(f.kind==='boolean'){if(!controlClosed(f,base))throw Error('Invalid boolean field');}
  else if(f.kind==='verified_identity'){if(!controlClosed(f,[...base,'editable'])||f.editable!==false)throw Error('Invalid identity field');}
  else if(f.kind==='choice'){if(!controlClosed(f,[...base,'options','activation'])||!Array.isArray(f.options)||f.options.length<1||f.options.length>16||f.options.some(o=>!controlObject(o)||!controlClosed(o,['value','label'])||!key(o.value)||!label(o.label))||new Set(f.options.map(o=>o.value)).size!==f.options.length)throw Error('Invalid choice field');if(f.activation){const a=f.activation;if(!capabilities.includes('record_initial_change.v1'))throw Error('EXPERIENCE_CAPABILITY_UNAVAILABLE');if(!controlObject(a)||!controlClosed(a,['field','schema_version','inactive_value'])||!key(a.field)||typeof a.schema_version!=='string'||a.schema_version.length>96||!/^deft\.[a-z0-9_]+\.v[1-9][0-9]*$/u.test(a.schema_version)||!key(a.inactive_value)||!f.options.some(o=>o.value===a.inactive_value))throw Error('Invalid choice activation');mapped.push(a.field);}}
  else throw Error('Invalid field kind');
 }
 if(p.repeated_fields!==undefined){if(!capabilities.includes('repeated_fields.v1'))throw Error('EXPERIENCE_CAPABILITY_UNAVAILABLE');if(!Array.isArray(p.repeated_fields)||p.repeated_fields.length<1||p.repeated_fields.length>4)throw Error('Repeated field limit');
  for(const group of p.repeated_fields){if(!controlObject(group)||!controlClosed(group,['schema_version','field','label','min_rows','max_rows','row'])||group.schema_version!=='deft.repeated_fields.v1'||!key(group.field)||!label(group.label)||!Number.isInteger(group.min_rows)||group.min_rows<0||group.min_rows>10||!controlLimit(group.max_rows,10)||group.min_rows>group.max_rows||!controlObject(group.row))throw Error('Invalid repeated fields');mapped.push(group.field);const row=group.row;
   if(row.kind==='choice'){if(!controlClosed(row,['kind','options','unique'])||typeof row.unique!=='boolean'||!Array.isArray(row.options)||row.options.length<1||row.options.length>16||row.options.some(option=>!controlObject(option)||!controlClosed(option,['value','label'])||!key(option.value)||!label(option.label))||new Set(row.options.map(option=>option.value)).size!==row.options.length||row.unique&&group.min_rows>row.options.length)throw Error('Invalid repeated choices');}
   else if(row.kind==='object'){if(!controlClosed(row,['kind','fields'])||!Array.isArray(row.fields)||row.fields.length<1||row.fields.length>8||row.fields.some(field=>!['text','boolean','choice'].includes(field.kind)||Object.hasOwn(field,'activation')))throw Error('Invalid repeated row');createDeftRecordFormV2Node({...input,profile:{schema_version:'deft.record_form_profile.v2',max_record_bytes:p.max_record_bytes,fields:row.fields}},capabilities);}
   else throw Error('Invalid repeated row kind');
  }
 }
 if(p.richtext!==undefined){const r=p.richtext;if(!controlObject(r)||!controlClosed(r,['html_field','plain_field','label','max_html_characters','max_plain_characters','links','inline_images'])||!key(r.html_field)||!key(r.plain_field)||!label(r.label)||!controlLimit(r.max_html_characters,262144)||!controlLimit(r.max_plain_characters,262144)||r.links!=='host_validated'||r.inline_images!=='none')throw Error('Invalid rich field');mapped.push(r.html_field,r.plain_field);}
 if(!mapped.length||new Set(mapped).size!==mapped.length)throw Error('Duplicate or empty field mappings');
 const cloned=structuredClone(input);if(cloned.profile.repeated_fields){for(const group of cloned.profile.repeated_fields){if(group.row.kind==='choice'){group.row.options.forEach(Object.freeze);Object.freeze(group.row.options);}else{for(const field of group.row.fields){if(field.kind==='choice'){field.options.forEach(Object.freeze);Object.freeze(field.options);}Object.freeze(field);}Object.freeze(group.row.fields);}Object.freeze(group.row);Object.freeze(group);}Object.freeze(cloned.profile.repeated_fields);}for(const f of cloned.profile.fields){if(f.kind==='choice'){f.options.forEach(Object.freeze);Object.freeze(f.options);if(f.activation)Object.freeze(f.activation);}Object.freeze(f);}Object.freeze(cloned.profile.fields);if(cloned.profile.richtext)Object.freeze(cloned.profile.richtext);Object.freeze(cloned.profile);
 return Object.freeze({kind:'record_form',...cloned});
}
export type {NativeComposeRasterInfo,NativeComposeRasterProfile} from './native-compose-raster.js';
export type {NativeComposeOptions,NativeComposeInlineAttachment} from './safe-compose-html.js';
export { nativeComposeImageCid,nativeComposeInlineFileIds,removeNativeComposeInlineFiles,NATIVE_COMPOSE_BODY_LIMITS,plainTextToNativeComposeHtml,plainTextToSafeComposeHtml, parseSafeComposeHtml,parseNativeSafeComposeHtml,canonicalNativeComposeLink,nativeSafeComposeHtmlFromEditorDocument,nativeComposeDraftFromEditorDocument } from './safe-compose-html.js';
/** Provider-independent trusted editor controls; legacy names remain wire compatible. */
export {parseNativeSafeComposeHtml as parseTrustedRichtextHtml,nativeSafeComposeHtmlFromEditorDocument as trustedRichtextHtmlFromEditorDocument,
 nativeComposeDraftFromEditorDocument as trustedRichtextDraftFromEditorDocument,nativeComposeInlineFileIds as trustedRichtextInlineFileIds,
 removeNativeComposeInlineFiles as removeTrustedRichtextInlineFiles} from './safe-compose-html.js';
/** Public author-side SDK leaf. Bundlers inline this into the immutable Worker.
 * It contains no credential, URL, fetch or direct workspace API surface. */
export { parseMailboxList, formatMailboxList } from './mailbox-list.js';
export const DEFT_EXPERIENCE_SDK_VERSION = 'deft.experience_bridge.v1' as const;

export type ExperienceSdkPort = Pick<MessagePort, 'postMessage' | 'close' | 'onmessage'>;
export type ExperienceDocumentLeaf = Readonly<{ kind: 'document'; id: string; format: 'plain' | 'html'; content: string; truncated?: boolean; printable?: boolean; print_control_id?: string; title?: string; metadata?: readonly Readonly<{ label: string; value: string }>[] }>;
export type ExperienceResourceDocument = Readonly<{ format: 'plain' | 'html'; content: string; truncated: boolean; plain_text?: string; metadata?: Readonly<Record<string, string | number | boolean>> }>;
export type ExperienceSdkIntent = 'resource' | 'open_resource' | 'action' | 'run_status' | 'run_inspect' | 'run_cancel' | 'navigate' | 'dialog' | 'private_state' | 'app_data';
export type ExperienceResourceSummaryPage = Readonly<{ schema_version: 'deft.experience_resource_payload.v1'; operation: 'list_summary';
  items: readonly Readonly<{ record_id: string; label: string }>[]; next_cursor: string | null; freshness: 'unknown' }>;
export type ExperienceResourceRecord = Readonly<{ schema_version: 'deft.experience_resource_payload.v1'; operation: 'read_one';
  item: Readonly<{ record_id: string; label: string; data: Readonly<Record<string, string | number | boolean>>; freshness: 'unknown' }> }>;
export type ExperienceResourceSearchPage = Readonly<{ schema_version: 'deft.experience_resource_search_page.v1'; operation: 'search';
  items: readonly Readonly<{ record_id: string; label: string; snippet: string; field_key: string }>[];
  scan: Readonly<{ records_scanned: number; complete: boolean }>; next_cursor: string | null; freshness: 'unknown' }>;
export type ExperienceProviderPage = Readonly<{ schema_version: 'deft.experience_provider_page.v1';
  items: readonly Readonly<{ record_id: string; label: string; data: Readonly<Record<string, string | number | boolean>> }>[];
  next_cursor: string | null; complete: boolean; observed_at: string;
  count: Readonly<{ returned: number; exact_total: null }>; failure_count: number }>;
function providerPageReply(value: unknown): ExperienceProviderPage {
  const row = value as Record<string, unknown>, count = row?.count as Record<string, unknown>;
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'complete,count,failure_count,items,next_cursor,observed_at,schema_version'
    || row.schema_version !== 'deft.experience_provider_page.v1' || !Array.isArray(row.items) || row.items.length > 10
    || typeof row.complete !== 'boolean' || row.complete && (row.next_cursor !== null || row.failure_count !== 0)
    || !(row.next_cursor === null || resourceRecordId(row.next_cursor))
    || typeof row.observed_at !== 'string' || !Number.isFinite(Date.parse(row.observed_at))
    || !count || Array.isArray(count) || Object.keys(count).sort().join(',') !== 'exact_total,returned'
    || count.returned !== row.items.length || count.exact_total !== null
    || !Number.isInteger(row.failure_count) || (row.failure_count as number) < 0 || (row.failure_count as number) > 10
    || new TextEncoder().encode(JSON.stringify(row)).byteLength > 60 * 1024) throw new Error('Invalid provider page response');
  for (const item of row.items) resourceReply({ schema_version: 'deft.experience_resource_payload.v1', operation: 'read_one',
    item: { ...item, freshness: 'unknown' } }, 'read_one');
  return row as unknown as ExperienceProviderPage;
}
function resourceSearchReply(value: unknown, fields: readonly string[]): ExperienceResourceSearchPage {
  const object = (row: unknown): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row);
  const exact = (row: Record<string, unknown>, keys: readonly string[]) => Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
  if (!object(value) || !exact(value, ['schema_version', 'operation', 'items', 'scan', 'next_cursor', 'freshness'])
    || value.schema_version !== 'deft.experience_resource_search_page.v1' || value.operation !== 'search' || value.freshness !== 'unknown'
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > 60 * 1024 || !Array.isArray(value.items) || value.items.length > 10
    || !value.items.every(item => object(item) && exact(item, ['record_id', 'label', 'snippet', 'field_key'])
      && resourceRecordId(item.record_id) && typeof item.label === 'string' && item.label.length <= 200
      && typeof item.snippet === 'string' && item.snippet.length <= 240 && typeof item.field_key === 'string' && fields.includes(item.field_key))
    || !object(value.scan) || !exact(value.scan, ['records_scanned', 'complete'])
    || !Number.isInteger(value.scan.records_scanned) || (value.scan.records_scanned as number) < 0 || (value.scan.records_scanned as number) > 100
    || typeof value.scan.complete !== 'boolean' || value.scan.complete !== (value.next_cursor === null)
    || !(value.next_cursor === null || typeof value.next_cursor === 'string' && value.next_cursor.length > 0 && value.next_cursor.length <= 2048))
    throw new Error('Invalid Experience search response');
  return value as unknown as ExperienceResourceSearchPage;
}
const resourceRecordId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function resourceReply(value: unknown, operation: 'list_summary' | 'read_one') {
  const object = (row: unknown): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row);
  const exact = (row: Record<string, unknown>, keys: readonly string[]) => Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
  const label = (value: unknown) => typeof value === 'string' && value.length <= 200;
  const invalid = () => { throw new Error('Invalid Experience resource response'); };
  if (!object(value) || value.schema_version !== 'deft.experience_resource_payload.v1' || value.operation !== operation
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > 60 * 1024) return invalid();
  if (operation === 'list_summary') {
    if (!exact(value, ['schema_version', 'operation', 'items', 'next_cursor', 'freshness']) || value.freshness !== 'unknown'
      || !Array.isArray(value.items) || value.items.length > 10
      || !value.items.every(item => object(item) && exact(item, ['record_id', 'label']) && resourceRecordId(item.record_id) && label(item.label))
      || (value.next_cursor !== null && (typeof value.next_cursor !== 'string' || !value.next_cursor || value.next_cursor.length > 2048))) return invalid();
    return value as unknown as ExperienceResourceSummaryPage;
  }
  const item = value.item;
  if (!exact(value, ['schema_version', 'operation', 'item']) || !object(item)
    || !exact(item, ['record_id', 'label', 'data', 'freshness']) || !resourceRecordId(item.record_id) || !label(item.label) || item.freshness !== 'unknown'
    || !object(item.data) || Object.keys(item.data).length > 32
    || !Object.entries(item.data).every(([key, data]) => key.length > 0 && key.length <= 48 && !['__proto__', 'constructor', 'prototype'].includes(key)
      && (typeof data === 'boolean' || (typeof data === 'string' && data.length <= 4096) || (typeof data === 'number' && Number.isFinite(data))))) return invalid();
  return value as unknown as ExperienceResourceRecord;
}

export type ExperiencePrivateSourceReference = Readonly<{field:string;action_key:string;input_field:string;record_id:string}>;
export type ExperiencePrivateStateMeta = Readonly<{ record_id: string; revision: number; updated_at: string; expires_at: string }>;
/** Owner/installation/key usage includes retained records from other versions and targets. */
export type ExperiencePrivateStateQuota = Readonly<{ used_records: number; max_records: number; used_bytes: number; max_total_bytes: number }>;
export type ExperiencePrivateStateList = Readonly<{ operation: 'list'; items: readonly ExperiencePrivateStateMeta[]; quota?: ExperiencePrivateStateQuota }>;
export type ExperiencePrivateStateRecord = ExperiencePrivateStateMeta & Readonly<{ value: Readonly<Record<string, string | number | boolean>> }>;

export function createDeftExperienceSdk(port: ExperienceSdkPort, sessionId: string) {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(sessionId)) throw new Error('Invalid Experience session');
  let sequence = 0;
  let closed = false;
  const pending = new Map<string, { resolve(value: unknown): void; reject(reason: Error): void }>();
  let onUiEvent: ((event: unknown) => void) | undefined;
  port.onmessage = (message: MessageEvent) => {
    const value: unknown = message.data;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const reply = value as Record<string, unknown>;
    if (reply.version !== DEFT_EXPERIENCE_SDK_VERSION || reply.session_id !== sessionId) return;
    if (reply.kind === 'ui_event') { onUiEvent?.(reply.event); return; }
    if (reply.kind !== 'response' || typeof reply.request_id !== 'string') return;
    const promise = pending.get(reply.request_id);
    if (!promise) return;
    pending.delete(reply.request_id);
    if (reply.ok === true) promise.resolve(reply.output);
    else promise.reject(new Error(typeof reply.code === 'string' ? reply.code : 'UNAVAILABLE'));
  };
  const post = (message: Record<string, unknown>): number => {
    if (closed) throw new Error('Experience session closed');
    sequence += 1;
    port.postMessage({ version: DEFT_EXPERIENCE_SDK_VERSION,
      session_id: sessionId, sequence, ...message });
    return sequence;
  };
  const request = (operation: ExperienceSdkIntent, key?: string, input?: unknown): Promise<unknown> => {
    if (pending.size >= 16) return Promise.reject(new Error('Experience request limit'));
    const requestId = `request_${sequence + 1}`;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      try { post({ kind: 'request', request_id: requestId, operation, key, input }); }
      catch (error) { pending.delete(requestId); reject(error); }
    });
  };
  const resourceKey = (key: string) => {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(key)) throw new Error('Invalid resource key');
  };
  return Object.freeze({
    render(view: unknown): void { post({ kind: 'view', view }); },
    request,
    listRecords(storeKey:string,cursor:string|null=null,targetKey?:string):Promise<AppDataResult> {
      resourceKey(storeKey);return request('app_data',storeKey,{operation:'record_list',input:{store_key:storeKey,cursor,limit:10},...(targetKey===undefined?{}:{target_key:(resourceKey(targetKey),targetKey)})}) as Promise<AppDataResult>;
    },
    readRecordMeta(storeKey:string,recordId:string):Promise<Pick<AppDataRecord,'record_id'|'revision'|'content_revision'|'content_digest'|'status'|'source_refs'>> {
      resourceKey(storeKey);if(!resourceRecordId(recordId))throw Error('Invalid record');
      return request('app_data',storeKey,{operation:'record_read',input:{store_key:storeKey,record_id:recordId}}) as Promise<Pick<AppDataRecord,'record_id'|'revision'|'content_revision'|'content_digest'|'status'|'source_refs'>>;
    },
    createRecord(storeKey:string,recordId:string,value:Record<string,unknown>,sourceRefs?:readonly {resource_key:string;record_id:string;content_digest:string}[]):Promise<AppDataResult> {
      resourceKey(storeKey);if(!resourceRecordId(recordId)||new TextEncoder().encode(JSON.stringify(value)).byteLength>16384)throw Error('Initial record exceeds Worker intent budget');
      if(sourceRefs&&(sourceRefs.length>1||sourceRefs.some(source=>!controlKey(source.resource_key)||!resourceRecordId(source.record_id)||!/^sha256:[a-f0-9]{64}$/u.test(source.content_digest))))throw Error('Invalid record source');
      return request('app_data',storeKey,{operation:'record_create',input:{store_key:storeKey,record_id:recordId,value,...(sourceRefs===undefined?{}:{source_refs:sourceRefs})}}) as Promise<AppDataResult>;
    },
    archiveRecord(storeKey:string,recordId:string,expectedRevision:number,expectedContentDigest:string):Promise<AppDataResult> {
      resourceKey(storeKey);if(!resourceRecordId(recordId))throw Error('Invalid record');
      return request('app_data',storeKey,{operation:'record_archive',input:{store_key:storeKey,record_id:recordId,
        expected_revision:expectedRevision,expected_content_digest:expectedContentDigest}}) as Promise<AppDataResult>;
    },
    listAccountTargets(storeKey:string):Promise<{targets:readonly {key:string;label:string}[];selected_target_key:string}> {
      resourceKey(storeKey);return request('app_data',storeKey,{operation:'account_catalog',input:{store_key:storeKey}}) as Promise<{targets:readonly {key:string;label:string}[];selected_target_key:string}>;
    },
    listDataResources(storeKey:string,resource:string,cursor:string|null=null,query?:string,targetKey?:string):Promise<AppDataResult> {
      resourceKey(storeKey);resourceKey(resource);return request('app_data',storeKey,{operation:'resource_list',input:{store_key:storeKey,resource_key:resource,cursor,limit:10,...(query===undefined?{}:{query})},...(targetKey===undefined?{}:{target_key:(resourceKey(targetKey),targetKey)})}) as Promise<AppDataResult>;
    },
    refreshDataResource(storeKey:string,resource:string):Promise<AppDataResult> {
      resourceKey(storeKey);resourceKey(resource);return request('app_data',storeKey,{operation:'resource_refresh',input:{store_key:storeKey,resource_key:resource}}) as Promise<AppDataResult>;
    },
    listPrivateState(key: string): Promise<ExperiencePrivateStateList> {
      resourceKey(key);
      return request('private_state', key, { operation: 'list' }) as Promise<ExperiencePrivateStateList>;
    },
    readPrivateState(key: string, recordId: string): Promise<Readonly<{ operation: 'read'; item: ExperiencePrivateStateRecord }>> {
      resourceKey(key); if (!resourceRecordId(recordId)) throw new Error('Invalid private state record');
      return request('private_state', key, { operation: 'read', record_id: recordId }) as Promise<{ operation: 'read'; item: ExperiencePrivateStateRecord }>;
    },
    putPrivateState(key: string, recordId: string, revision: number, value: Readonly<Record<string, string | number | boolean>>, options?: Readonly<{source_refs:readonly ExperiencePrivateSourceReference[]}>): Promise<Readonly<{ operation: 'put'; item: ExperiencePrivateStateMeta }>> {
      resourceKey(key); if (!resourceRecordId(recordId) || !Number.isInteger(revision) || revision < 0 || revision > 2147483646
        || !value || Array.isArray(value) || Object.keys(value).length > 32 || new TextEncoder().encode(JSON.stringify(value)).byteLength > 16384) throw new Error('Invalid private state input');
      if (options !== undefined) {
        if (!options || Array.isArray(options) || Object.keys(options).join(',') !== 'source_refs' || !Array.isArray(options.source_refs)
          || !options.source_refs.length || options.source_refs.length > 4 || new Set(options.source_refs.map(ref => ref.field)).size !== options.source_refs.length) throw new Error('Invalid private source reference');
        for (const ref of options.source_refs) {
          if (!ref || Object.keys(ref).sort().join(',') !== 'action_key,field,input_field,record_id' || !resourceRecordId(ref.record_id)
            || value[ref.field] !== ref.record_id) throw new Error('Invalid private source reference');
          resourceKey(ref.field);resourceKey(ref.action_key);resourceKey(ref.input_field);
        }
      }
      return request('private_state', key, { operation: 'put', record_id: recordId, expected_revision: revision, value, ...(options ? {source_refs:options.source_refs} : {}) }) as Promise<{ operation: 'put'; item: ExperiencePrivateStateMeta }>;
    },
    deletePrivateState(key: string, recordId: string, revision: number): Promise<Readonly<{ operation: 'delete'; record_id: string; revision: number }>> {
      resourceKey(key); if (!resourceRecordId(recordId) || !Number.isInteger(revision) || revision < 0 || revision > 2147483646) throw new Error('Invalid private state revision');
      return request('private_state', key, { operation: 'delete', record_id: recordId, expected_revision: revision }) as Promise<{ operation: 'delete'; record_id: string; revision: number }>;
    },
    listResourceSummaries(key: string, options: { limit?: number; cursor?: string } = {}): Promise<ExperienceResourceSummaryPage> {
      resourceKey(key);
      if (Object.keys(options).some(field => !['limit', 'cursor'].includes(field))
        || (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10))
        || (options.cursor !== undefined && (typeof options.cursor !== 'string' || !options.cursor || options.cursor.length > 2048))) {
        throw new Error('Invalid resource list input');
      }
      return request('resource', key, { schema_version: 'deft.experience_resource_request.v1', operation: 'list_summary', ...options })
        .then(value => resourceReply(value, 'list_summary') as ExperienceResourceSummaryPage);
    },
    readResourceRecord(key: string, recordId: string): Promise<ExperienceResourceRecord> {
      resourceKey(key);
      if (!resourceRecordId(recordId)) throw new Error('Invalid record locator');
      return request('resource', key, { schema_version: 'deft.experience_resource_request.v1', operation: 'read_one', record_id: recordId })
        .then(value => resourceReply(value, 'read_one') as ExperienceResourceRecord);
    },
    async readResourceDocument(key: string, recordId: string): Promise<ExperienceResourceDocument> {
      resourceKey(key); if (!resourceRecordId(recordId)) throw new Error('Invalid record locator');
      const value = await request('resource', key, { operation: 'read_document', record_id: recordId });
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Document unavailable');
      const row = value as Record<string, unknown>;
      if (Object.keys(row).some(key => !['format','content','truncated','metadata','plain_text'].includes(key))
        || !['plain','html'].includes(String(row.format)) || typeof row.content !== 'string' || row.content.length > 16384 || row.content.includes('\0') || typeof row.truncated !== 'boolean'
        || row.plain_text !== undefined && (typeof row.plain_text !== 'string' || row.plain_text.length > 16384 || row.plain_text.includes('\0'))
        || row.format === 'html' && typeof row.plain_text !== 'string'
        || new TextEncoder().encode(JSON.stringify(row)).byteLength > 60 * 1024) throw new Error('Document unavailable');
      if (row.metadata !== undefined) {
        if (!row.metadata || typeof row.metadata !== 'object' || Array.isArray(row.metadata) || Object.keys(row.metadata).length > 32
          || !Object.entries(row.metadata).every(([key, data]) => /^[a-z][a-z0-9_]{0,47}$/u.test(key) && !['__proto__','constructor','prototype'].includes(key)
            && (typeof data === 'boolean' || typeof data === 'number' && Number.isFinite(data) || typeof data === 'string' && data.length <= 16384))) throw new Error('Document unavailable');
      }
      return row as ExperienceResourceDocument;
    },
    searchResourceRecords(key: string, options: { query: string; field_keys: readonly string[]; cursor?: string }): Promise<ExperienceResourceSearchPage> {
      resourceKey(key);
      if (Object.keys(options).some(field => !['query', 'field_keys', 'cursor'].includes(field))
        || typeof options.query !== 'string' || !options.query.trim() || options.query.length > 200
        || !Array.isArray(options.field_keys) || options.field_keys.length < 1 || options.field_keys.length > 32
        || new Set(options.field_keys).size !== options.field_keys.length
        || !options.field_keys.every(field => typeof field === 'string' && field.length > 0 && field.length <= 48 && !['__proto__', 'constructor', 'prototype'].includes(field))
        || options.cursor !== undefined && (typeof options.cursor !== 'string' || !options.cursor || options.cursor.length > 2048))
        throw new Error('Invalid resource search input');
      const fields = [...options.field_keys];
      return request('resource', key, { schema_version: 'deft.experience_resource_request.v2', operation: 'search',
        query: options.query, field_keys: fields, ...(options.cursor === undefined ? {} : { cursor: options.cursor }) })
        .then(value => resourceSearchReply(value, fields));
    },
    /** One current provider page. Saved-index search and its cursors remain separate. */
    browseResourceRecords(key: string, options: { operation: 'list' | 'search' | 'conversation'; folder: string;
      query?: string;filters?:Readonly<Record<string,string|boolean>>; cursor?: string; record_id?: string }): Promise<ExperienceProviderPage> {
      resourceKey(key);
      if (!options || Object.keys(options).some(field => !['operation', 'folder', 'query', 'filters','cursor', 'record_id'].includes(field))
        || !['list', 'search', 'conversation'].includes(options.operation) || !/^[a-z][a-z0-9_]{0,127}$/.test(options.folder)
        || options.query !== undefined && (typeof options.query !== 'string' || options.query.length > 200 || /[\r\n\0]/.test(options.query))
        || options.cursor !== undefined && !resourceRecordId(options.cursor)
        || options.record_id !== undefined && !resourceRecordId(options.record_id)
        || options.filters!==undefined&&(!options.filters||typeof options.filters!=='object'||Array.isArray(options.filters)||Object.keys(options.filters).length<1||Object.keys(options.filters).some(field=>!['text','from','to','cc','bcc','subject','filename','has_attachments','received_on','after','before','unread','flagged'].includes(field))||Object.entries(options.filters).some(([field,value])=>['has_attachments','unread','flagged'].includes(field)?typeof value!=='boolean':typeof value!=='string'||!value||value.length>500||/["\\\u0000-\u001f\u007f]/.test(value)))
        || (options.operation === 'search' ? (!!options.query?.trim()===!!options.filters) || options.record_id !== undefined
          : options.operation === 'conversation' ? !options.record_id || options.query !== undefined||options.filters!==undefined
            : options.query !== undefined || options.record_id !== undefined||options.filters!==undefined)) throw new Error('Invalid provider page input');
      const { operation, ...fields } = options;
      return request('resource', key, { operation: 'browse', kind: operation, ...fields }).then(providerPageReply);
    },
    async readTriageOptions(key:string,recordId:string):Promise<Readonly<{schema_version:'deft.experience_triage_options.v1';account_id:string;provider:'gmail'|'microsoft'|'imap_smtp';destinations:readonly Readonly<{id:string;label:string;kind:'folder'|'label'}>[];labels:readonly Readonly<{id:string;label:string}>[];complete:boolean;labels_supported:boolean}>>{
      resourceKey(key);if(!resourceRecordId(recordId))throw Error('Resource unavailable');
      const value=await request('resource',key,{operation:'triage_options',record_id:recordId}) as any;
      if(!value||value.schema_version!=='deft.experience_triage_options.v1'||Object.keys(value).sort().join(',')!=='account_id,complete,destinations,labels,labels_supported,provider,schema_version'||typeof value.account_id!=='string'||!value.account_id||value.account_id.length>256||!['gmail','microsoft','imap_smtp'].includes(value.provider)||typeof value.complete!=='boolean'||typeof value.labels_supported!=='boolean'||!Array.isArray(value.destinations)||!Array.isArray(value.labels)||value.destinations.length+value.labels.length>100||[...value.destinations,...value.labels].some((row:any)=>!row||typeof row!=='object'||typeof row.id!=='string'||!row.id||row.id.length>256||typeof row.label!=='string'||!row.label||row.label.length>256||/[\r\n\0]/.test(row.id+row.label))||value.destinations.some((row:any)=>!['folder','label'].includes(row.kind))||new Set(value.destinations.map((row:any)=>row.id)).size!==value.destinations.length||new Set(value.labels.map((row:any)=>row.id)).size!==value.labels.length)throw Error('Resource unavailable');return value;
    },
    /** Open the host's owner-checked source and files panel. No URL or file bytes enter App code. */
    async openOriginalSource(key: string, recordId: string): Promise<Readonly<{ opened: true }>> {
      resourceKey(key); if (!resourceRecordId(recordId)) throw new Error('Resource unavailable');
      const result=await request('open_resource',key,{operation:'read_source',record_id:recordId});
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1 || !('opened' in result) || result.opened !== true) throw new Error('Source unavailable');
      return {opened:true};
    },
    async openResource(key: string, recordId: string): Promise<Readonly<{ opened: true }>> {
      resourceKey(key); if (!resourceRecordId(recordId)) throw new Error('Invalid record locator');
      const result = await request('open_resource', key, { record_id: recordId });
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1
        || !('opened' in result) || result.opened !== true) throw new Error('Resource unavailable');
      return { opened: true };
    },
    onEvent(handler: (event: unknown) => void): void { onUiEvent = handler; },
    close(): void {
      if (closed) return;
      closed = true;
      for (const request of pending.values()) request.reject(new Error('Experience session closed'));
      pending.clear();
      port.onmessage = null;
      port.close();
    },
  });
}


export function createDeftLocalJobScheduleNode(input:Omit<DeftExperienceLocalJobScheduleNode,'kind'>,capabilities:readonly DeftExperienceCapability[]):DeftExperienceLocalJobScheduleNode{
 if(!capabilities.includes('local_job.v1'))throw Error('EXPERIENCE_CAPABILITY_UNAVAILABLE');return structuredClone({...input,kind:'local_job_schedule'});
}
export function createDeftLocalJobListNode(input:Omit<DeftExperienceLocalJobListNode,'kind'>,capabilities:readonly DeftExperienceCapability[]):DeftExperienceLocalJobListNode{
 if(!capabilities.includes('local_job.v1'))throw Error('EXPERIENCE_CAPABILITY_UNAVAILABLE');return structuredClone({...input,kind:'local_job_list'});
}
