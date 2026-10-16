import {parseDeftExperienceMenuNode,isDeftExperienceIcon,type DeftExperienceIcon,type DeftExperienceMenuNode} from '../../../../packages/app-kit/src/experience-menu';
import {DeftExperienceRecordMirrorControlNodeSchema,type DeftExperienceRecordMirrorControlNode} from '../../../../packages/app-kit/src/record-mirror-controls';
import {DeftExperienceLocalJobScheduleNodeSchema,DeftExperienceLocalJobListNodeSchema,type DeftExperienceLocalJobScheduleNode,type DeftExperienceLocalJobListNode} from '../../../../packages/app-kit/src/local-job-controls';
import {DeftExperienceKeyboardSchema,type DeftExperienceKeyboard} from '../../../../packages/app-kit/src/experience-keyboard';
import {AppDataRecordMetaSchema} from '../../../../packages/app-kit/src/app-data';
import { DeftExperienceResourceDocumentNodeSchema, type DeftExperienceResourceDocumentNode,
  DeftExperienceRichtextFieldNodeSchema, type DeftExperienceRichtextFieldNode,
  DeftExperienceFileFieldNodeSchema, type DeftExperienceFileFieldNode,
  DeftExperienceResourceRefreshNodeSchema, type DeftExperienceResourceRefreshNode,
  DeftExperienceCapabilitySchema,
  type DeftExperienceCapability } from '../../../../packages/app-kit/src/experience-capabilities';
import {DeftExperienceRecordFormV3NodeSchema,type DeftExperienceRecordFormV3Node,DeftExperienceRecordFormV2NodeSchema,type DeftExperienceRecordFormV2Node,DeftExperienceRecordFormNodeSchema,type DeftExperienceRecordFormNode,DeftExperienceRecordDocumentNodeSchema,type DeftExperienceRecordDocumentNode} from '../../../../packages/app-kit/src/app-data';

export type ExperiencePin = Readonly<{
  org_id: string; user_id: string; app_installation_id: string;
  app_version_id: string; grant_snapshot_id: string;
  lifecycle_epoch: number; grant_epoch: number;
  session_id: string; session_epoch: number;
}>;

export type ExperienceNode =
  | DeftExperienceMenuNode
  | DeftExperienceRecordMirrorControlNode
  | DeftExperienceLocalJobScheduleNode | DeftExperienceLocalJobListNode
  | DeftExperienceResourceDocumentNode
  | DeftExperienceRichtextFieldNode | DeftExperienceFileFieldNode | DeftExperienceResourceRefreshNode
  | DeftExperienceRecordFormV3Node | DeftExperienceRecordFormNode | DeftExperienceRecordFormV2Node | DeftExperienceRecordDocumentNode
  | Readonly<{ kind: 'document'; id: string; format: 'plain' | 'html'; content: string; truncated?: boolean; printable?: boolean; print_control_id?: string; title?: string; metadata?: readonly Readonly<{ label: string; value: string }>[] }>
  | Readonly<{ kind: 'text'; id: string; text: string; tone?: 'default' | 'muted' | 'heading' | 'caption' | 'body' }>
  | Readonly<{ kind: 'button'; id: string; label: string; variant?: 'primary' | 'secondary' | 'ghost' | 'list'; description?: string; meta?: string; selected?: boolean; disabled?: boolean; eyebrow?: string; icon?: DeftExperienceIcon }>
  | Readonly<{ kind: 'input'; id: string; label: string; value: string; multiline?: boolean; placeholder?: string; appearance?: 'search' | 'inline' | 'body' }>
  | Readonly<{ kind: 'stack'; id: string; title?: string; layout?: 'vertical' | 'horizontal' | 'split' | 'list' | 'workspace' | 'toolbar'; surface?: 'plain' | 'panel' | 'sidebar' | 'document'; mobile?: 'hidden' | 'only'; children: readonly ExperienceNode[] }>
  | Readonly<{ kind: 'grid'; id: string; columns: readonly string[];
      rows: readonly Readonly<{ id: string; cells: readonly string[] }>[]; selected_row_id?: string }>
  | Readonly<{ kind: 'canvas'; id: string;
      strokes: readonly Readonly<{ points: readonly Readonly<{ x: number; y: number }>[] }>[] }>;

export type ExperienceNavigationItem = Extract<ExperienceNode, { kind: 'button' }>;
export type ExperienceView = Readonly<{ root: ExperienceNode; navigation?: readonly ExperienceNavigationItem[]; preferences?: ExperienceNode; keyboard?: DeftExperienceKeyboard;
  schema_version?: 'deft.experience_view.v2'; capabilities?: readonly DeftExperienceCapability[] }>;
export type ExperienceViewOptions = Readonly<{ capabilities?: readonly DeftExperienceCapability[]; resourceKeys?: readonly string[]; stateKeys?: readonly string[]; storeKeys?:readonly string[];actionKeys?:readonly string[] }>;
export type ExperienceIntent = Readonly<{
  kind: 'resource' | 'open_resource' | 'action' | 'run_status' | 'run_inspect' | 'run_cancel' | 'navigate' | 'dialog' | 'private_state'|'app_data';
  key?: string;
  input?: unknown;
}>;

export type ExperienceBroker = Readonly<{
  isLive(pin: ExperiencePin, signal?: AbortSignal): boolean | Promise<boolean>;
  privateState?: (pin: ExperiencePin, key: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  appData?:(pin:ExperiencePin,key:string,input:unknown,signal:AbortSignal)=>Promise<unknown>;
  resource?: (pin: ExperiencePin, key: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  openResource?: (pin: ExperiencePin, key: string, input: unknown, signal: AbortSignal) => Promise<Readonly<{ opened: true }> | undefined>;
  action?: (pin: ExperiencePin, key: string, input: unknown, signal: AbortSignal,
    requestId: string) => Promise<unknown>;
  runInspect?: (pin:ExperiencePin,input:unknown,signal:AbortSignal)=>Promise<unknown>;
  runStatus?: (pin: ExperiencePin, input: unknown, signal: AbortSignal) => Promise<unknown>;
  runCancel?: (pin: ExperiencePin, input: unknown, signal: AbortSignal) => Promise<unknown>;
  navigate?: (pin: ExperiencePin, key: string, signal: AbortSignal) => Promise<unknown>;
  dialog?: (pin: ExperiencePin, key: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
}>;
export type ExperiencePort = Pick<MessagePort, 'postMessage' | 'close' | 'onmessage'>;

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_NODES = 256;
const MAX_DEPTH = 8;
// Each stack adds an object and children array. The deepest canvas also adds
// strokes, stroke, points, point and scalar wrappers inside the view envelope.
const MAX_VIEW_JSON_DEPTH = MAX_DEPTH * 2 + 7;
const MAX_ROWS = 100;
const MAX_COLUMNS = 16;
const MAX_POINTS = 4096;
const MAX_PENDING = 16;
const MAX_PER_SECOND = 100;
const encoder = new TextEncoder();
const id = (x: unknown): x is string => typeof x === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(x);
const text = (x: unknown, max = 4096): x is string => typeof x === 'string' && x.length <= max;
const record = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(x).every((key) => allowed.includes(key));
const integer = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

function boundedJson(value: unknown, maximumString = 4096, maximumDepth = 12,
  optionalViewProperties = false): boolean {
  // Reject ancestor cycles; structured clone may retain valid sibling aliases.
  const seen = new Set<object>();
  let remaining = 2048;
  const visit = (item: unknown, depth: number, stringLimit = maximumString,
    objectProperty = false): boolean => {
    if (--remaining < 0 || depth > maximumDepth) return false;
    // Structured clone retains absent optional UI fields. Count them against
    // the budget; the exact view parser still rejects unknown/required fields.
    if (item === undefined) return optionalViewProperties && objectProperty;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'string') return item.length <= stringLimit;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || seen.has(item)) return false;
    seen.add(item);
    try {
    if (optionalViewProperties && Object.values(Object.getOwnPropertyDescriptors(item))
      .some(descriptor => descriptor.enumerable && !Object.hasOwn(descriptor, 'value'))) return false;
    if (Array.isArray(item)) return item.length <= 256 && item.every((child) => visit(child, depth + 1));
    return Object.keys(item).length <= 64 && Object.entries(item).every(([key, child]) =>
      key.length <= 64 && key !== '__proto__' && key !== 'constructor' && visit(child, depth + 1,
        record(item) && item.kind === 'document' && key === 'content' ? 16384 : maximumString, true));
    } finally { seen.delete(item); }
  };
  if (!visit(value, 0)) return false;
  try { return encoder.encode(JSON.stringify(value)).byteLength <= MAX_MESSAGE_BYTES; }
  catch { return false; }
}

function parseNode(input: unknown, depth: number, budget: { nodes: number; points: number; capabilities?: readonly DeftExperienceCapability[]; resourceDocuments?: boolean; resourceKeys?: readonly string[]; stateKeys?: readonly string[];storeKeys?:readonly string[];actionKeys?:readonly string[] }): ExperienceNode | null {
  if (!record(input) || !id(input.id) || depth > MAX_DEPTH || ++budget.nodes > MAX_NODES) return null;
  switch (input.kind) {
    case 'record_mirror_control':{
      if(!budget.capabilities?.includes('record_mirror.v1'))return null;const parsed=DeftExperienceRecordMirrorControlNodeSchema.safeParse(input);return parsed.success&&budget.storeKeys?.includes(parsed.data.store_key)?parsed.data:null;
    }
    case 'local_job_schedule':case 'local_job_list':{
      if(!budget.capabilities?.includes('local_job.v1'))return null;const parsed=(input.kind==='local_job_schedule'?DeftExperienceLocalJobScheduleNodeSchema:DeftExperienceLocalJobListNodeSchema).safeParse(input);
      return parsed.success&&budget.storeKeys?.includes(parsed.data.store_key)&&budget.resourceKeys?.includes(parsed.data.kind==='local_job_schedule'?parsed.data.resource.resource_key:parsed.data.resource_key)?parsed.data:null;
    }
    case 'record_form': {
      if(record(input.profile)&&input.profile.schema_version==='deft.record_form_profile.v2'){
       if(!budget.capabilities?.includes('record_form.v2')||input.profile.repeated_fields!==undefined&&!budget.capabilities?.includes('repeated_fields.v1'))return null;if(record(input.profile)&&Array.isArray(input.profile.fields)&&input.profile.fields.some(field=>record(field)&&field.activation)&&!budget.capabilities?.includes('record_initial_change.v1'))return null;const parsed=DeftExperienceRecordFormV2NodeSchema.safeParse(input);
       return parsed.success&&budget.storeKeys?.includes(parsed.data.store_key)?parsed.data:null;
      }
      const v3=record(input.profile)&&input.profile.schema_version==='deft.record_form_profile.v3';if(!budget.capabilities?.includes(v3?'record_form.v3':'record_form.v1'))return null;if(input.seed!==undefined&&!budget.capabilities?.includes('record_form_seed.v1'))return null;if(input.presentation!==undefined&&!budget.capabilities?.includes('record_form_presentation.v1'))return null;if(input.initial_change&&!budget.capabilities?.includes('record_initial_change.v1'))return null;if(Array.isArray(input.record_changes)&&input.record_changes.some(change=>record(change)&&change.parameters)&&!budget.capabilities?.includes('record_change_parameters.v1'))return null;
      const parsed=(v3?DeftExperienceRecordFormV3NodeSchema:DeftExperienceRecordFormNodeSchema).safeParse(input);
      return parsed.success&&budget.storeKeys?.includes(parsed.data.store_key)&&(!parsed.data.source_refs?.length||parsed.data.source_refs.every(ref=>budget.resourceKeys?.includes(ref.resource_key)))&&(!parsed.data.action_key||budget.actionKeys?.includes(parsed.data.action_key))&&(!parsed.data.initial_change||budget.storeKeys?.includes(parsed.data.initial_change.source_store_key))&&(!parsed.data.record_changes||parsed.data.record_changes.every(change=>budget.storeKeys?.includes(change.source_store_key)))?parsed.data:null;
    }
    case 'record_document': {
      if(!budget.capabilities?.includes('record_document.v1'))return null;
      const parsed=DeftExperienceRecordDocumentNodeSchema.safeParse(input);
      if(parsed.success&&parsed.data.image_policy&&(!budget.capabilities?.includes('record_document_policy.v1')||!budget.storeKeys?.includes(parsed.data.image_policy.store_key)))return null;
      return parsed.success&&budget.resourceKeys?.includes(parsed.data.resource_key)&&budget.storeKeys?.includes(parsed.data.store_key)?parsed.data:null;
    }
    case 'richtext_field': {
      if (!budget.capabilities?.includes('richtext_field.v1')) return null;
      const parsed = DeftExperienceRichtextFieldNodeSchema.safeParse(input);
      return parsed.success ? parsed.data : null;
    }
    case 'file_field': {
      if (!budget.capabilities?.includes('file_field.v1')) return null;
      const parsed = DeftExperienceFileFieldNodeSchema.safeParse(input);
      return parsed.success && budget.stateKeys?.includes(parsed.data.state_key) ? parsed.data : null;
    }
    case 'resource_refresh': {
      if (!budget.capabilities?.includes('resource_refresh.v1')) return null;
      const parsed = DeftExperienceResourceRefreshNodeSchema.safeParse(input);
      return parsed.success && budget.resourceKeys?.includes(parsed.data.resource_key) ? parsed.data : null;
    }
    case 'resource_document': {
      if (!budget.resourceDocuments) return null;
      const parsed = DeftExperienceResourceDocumentNodeSchema.safeParse(input);
      return parsed.success && (!budget.resourceKeys || budget.resourceKeys.includes(parsed.data.resource_key)) ? parsed.data : null;
    }
    case 'document':
      return exact(input, ['kind','id','format','content','truncated','printable','print_control_id','title','metadata']) && (input.format === 'plain' || input.format === 'html') && text(input.content,16384) && !input.content.includes('\0')
        && (input.truncated === undefined || typeof input.truncated === 'boolean')
        && (input.printable === undefined || typeof input.printable === 'boolean')
        && (input.print_control_id === undefined || input.printable === true && id(input.print_control_id))
        && (input.title === undefined || text(input.title,200) && !input.title.includes('\0'))
        && (input.metadata === undefined || Array.isArray(input.metadata) && input.metadata.length <= 16 && input.metadata.every(row => record(row) && exact(row,['label','value']) && text(row.label,200) && text(row.value,2000) && !row.label.includes('\0') && !row.value.includes('\0')))
        ? { kind:'document', id:input.id, format:input.format, content:input.content, ...(input.truncated === undefined ? {} : {truncated:input.truncated}), ...(input.printable === undefined ? {} : {printable:input.printable}), ...(input.print_control_id === undefined ? {} : {print_control_id:input.print_control_id as string}), ...(input.title === undefined ? {} : {title:input.title}), ...(input.metadata === undefined ? {} : {metadata:input.metadata as readonly Readonly<{label:string;value:string}>[]}) } : null;
    case 'text':
      return exact(input, ['kind', 'id', 'text', 'tone']) && text(input.text)
        && (input.tone === undefined || (typeof input.tone === 'string' && ['default', 'muted', 'heading', 'caption', 'body'].includes(input.tone)))
        ? { kind: 'text', id: input.id, text: input.text,
          ...(input.tone !== undefined ? { tone: input.tone as 'default' | 'muted' | 'heading' | 'caption' | 'body' } : {}) } : null;
    case 'menu': {
      if(!budget.capabilities?.includes('menu.v1'))return null;const menu=parseDeftExperienceMenuNode(input);
      if(menu&&(budget.nodes+=menu.items.length)<=MAX_NODES)return menu;return null;
    }
    case 'button':
      return exact(input, ['kind', 'id', 'label', 'variant', 'description', 'meta', 'selected', 'disabled', 'eyebrow', 'icon'])
        && text(input.label, 128)
        && (input.variant === undefined || (typeof input.variant === 'string' && ['primary', 'secondary', 'ghost', 'list'].includes(input.variant)))
        && (input.description === undefined || text(input.description, 512))
        && (input.meta === undefined || text(input.meta, 80))
        && (input.selected === undefined || typeof input.selected === 'boolean')
        && (input.disabled === undefined || typeof input.disabled === 'boolean')
        && (input.eyebrow === undefined || text(input.eyebrow, 128))
        && (input.icon === undefined || isDeftExperienceIcon(input.icon))
        ? { kind: 'button', id: input.id, label: input.label,
          ...(input.variant !== undefined ? { variant: input.variant as 'primary' | 'secondary' | 'ghost' | 'list' } : {}),
          ...(input.description !== undefined ? { description: input.description as string } : {}),
          ...(input.meta !== undefined ? { meta: input.meta as string } : {}),
          ...(input.selected !== undefined ? { selected: input.selected as boolean } : {}),
          ...(input.disabled !== undefined ? { disabled: input.disabled as boolean } : {}),
          ...(input.eyebrow !== undefined ? { eyebrow: input.eyebrow as string } : {}),
          ...(input.icon !== undefined ? { icon: input.icon as DeftExperienceIcon } : {}) } : null;
    case 'input':
      return exact(input, ['kind', 'id', 'label', 'value', 'multiline', 'placeholder', 'appearance'])
        && text(input.label, 128) && text(input.value)
        && (input.multiline === undefined || typeof input.multiline === 'boolean')
        && (input.placeholder === undefined || text(input.placeholder, 128))
        && (input.appearance === undefined || (typeof input.appearance === 'string' && ['search', 'inline', 'body'].includes(input.appearance)))
        ? { kind: 'input', id: input.id, label: input.label, value: input.value,
          ...(input.multiline !== undefined ? { multiline: input.multiline as boolean } : {}),
          ...(input.placeholder !== undefined ? { placeholder: input.placeholder as string } : {}),
          ...(input.appearance !== undefined ? { appearance: input.appearance as 'search' | 'inline' | 'body' } : {}) } : null;
    case 'stack': {
      if (!exact(input, ['kind', 'id', 'title', 'children', 'layout', 'surface', 'mobile'])
        || (input.title !== undefined && !text(input.title, 128))
        || (input.layout !== undefined && (typeof input.layout !== 'string' || !['vertical', 'horizontal', 'split', 'list', 'workspace', 'toolbar'].includes(input.layout)))
        || (input.surface !== undefined && (typeof input.surface !== 'string' || !['plain', 'panel', 'sidebar', 'document'].includes(input.surface)))
        || (input.mobile !== undefined && (typeof input.mobile !== 'string' || !['hidden', 'only'].includes(input.mobile)))
        || !Array.isArray(input.children) || input.children.length > 64) return null;
      const children = input.children.map((child) => parseNode(child, depth + 1, budget));
      return children.every((child) => child !== null)
        ? { kind: 'stack', id: input.id, ...(input.title ? { title: input.title } : {}),
          ...(input.layout !== undefined ? { layout: input.layout as 'vertical' | 'horizontal' | 'split' | 'list' | 'workspace' | 'toolbar' } : {}),
          ...(input.surface !== undefined ? { surface: input.surface as 'plain' | 'panel' | 'sidebar' | 'document' } : {}),
          ...(input.mobile !== undefined ? { mobile: input.mobile as 'hidden' | 'only' } : {}),
          children: children as ExperienceNode[] } : null;
    }
    case 'grid': {
      if (!exact(input, ['kind', 'id', 'columns', 'rows', 'selected_row_id'])
        || !Array.isArray(input.columns) || input.columns.length < 1 || input.columns.length > MAX_COLUMNS
        || !input.columns.every((column) => text(column, 80))
        || !Array.isArray(input.rows) || input.rows.length > MAX_ROWS
        || (input.selected_row_id !== undefined && !id(input.selected_row_id))) return null;
      const columns = input.columns as string[];
      const rows = input.rows.map((row) => {
        if (!record(row) || !exact(row, ['id', 'cells']) || !id(row.id)
          || !Array.isArray(row.cells) || row.cells.length !== columns.length
          || !row.cells.every((cell) => text(cell, 512))) return null;
        return { id: row.id, cells: row.cells as string[] };
      });
      return rows.every((row) => row !== null)
        ? { kind: 'grid', id: input.id, columns,
          rows: rows as { id: string; cells: string[] }[],
          ...(input.selected_row_id ? { selected_row_id: input.selected_row_id } : {}) } : null;
    }
    case 'canvas': {
      if (!exact(input, ['kind', 'id', 'strokes']) || !Array.isArray(input.strokes)
        || input.strokes.length > 256) return null;
      const strokes = input.strokes.map((stroke) => {
        if (!record(stroke) || !exact(stroke, ['points']) || !Array.isArray(stroke.points)
          || stroke.points.length > 512) return null;
        budget.points += stroke.points.length;
        if (budget.points > MAX_POINTS) return null;
        const points = stroke.points.map((point) =>
          record(point) && exact(point, ['x', 'y'])
          && typeof point.x === 'number' && typeof point.y === 'number'
          && Number.isFinite(point.x) && Number.isFinite(point.y)
          && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
            ? { x: point.x, y: point.y } : null);
        return points.every((point) => point !== null)
          ? { points: points as { x: number; y: number }[] } : null;
      });
      return strokes.every((stroke) => stroke !== null)
        ? { kind: 'canvas', id: input.id,
          strokes: strokes as { points: { x: number; y: number }[] }[] } : null;
    }
    default: return null;
  }
}

export function parseExperienceView(value: unknown, options: ExperienceViewOptions = {}): ExperienceView | null {
  if (!record(value) || !exact(value, ['root', 'navigation', 'preferences', 'schema_version', 'capabilities', 'keyboard'])) return null;
  const v2 = value.schema_version === 'deft.experience_view.v2';
  if (value.schema_version !== undefined && !v2 || !v2 && value.capabilities !== undefined) return null;
  if (v2 && (!Array.isArray(value.capabilities) || value.capabilities.length < 1 || value.capabilities.length > DeftExperienceCapabilitySchema.options.length
    || new Set(value.capabilities).size !== value.capabilities.length
    || value.capabilities.some(capability => !DeftExperienceCapabilitySchema.safeParse(capability).success
      || !options.capabilities?.includes(capability as DeftExperienceCapability)))) return null;
  const selected = v2 ? value.capabilities as DeftExperienceCapability[] : [];
  const budget = { nodes: 0, points: 0, capabilities: selected,
    resourceDocuments: selected.includes('resource_document.v1'), resourceKeys: options.resourceKeys, stateKeys: options.stateKeys,
    storeKeys:options.storeKeys,actionKeys:options.actionKeys };
  const root = parseNode(value.root, 0, budget);
  if (!root) return null;
  const preferences=value.preferences===undefined?undefined:parseNode(value.preferences,0,budget);
  if(value.preferences!==undefined&&!preferences)return null;
  // Preferences currently has no scoped document/editor/file host adapter.
  // Fail admission here instead of accepting a control that cannot mount there.
  const needsScopedHost = (node:ExperienceNode):boolean => ['menu','record_mirror_control','local_job_schedule','local_job_list','resource_document','richtext_field','file_field','resource_refresh','record_form','record_document'].includes(node.kind)
    || node.kind==='stack'&&node.children.some(needsScopedHost);
  if(preferences&&needsScopedHost(preferences))return null;
  if (value.navigation!==undefined&&(!Array.isArray(value.navigation) || value.navigation.length > 16)) return null;
  const ids = new Set<string>();
  let duplicate = false;
  const collect = (node: ExperienceNode) => { if (ids.has(node.id)) duplicate = true; ids.add(node.id); if (node.kind === 'stack') node.children.forEach(collect); else if(node.kind==='menu')node.items.forEach(item=>collect({kind:'button',...item,disabled:node.disabled||item.disabled})); };
  collect(root);
  if (duplicate) return null;
  let keyboard: DeftExperienceKeyboard | undefined;
  if (value.keyboard !== undefined) {
    if (!selected.includes('keyboard_controls.v1')) return null;
    const parsed = DeftExperienceKeyboardSchema.safeParse(value.keyboard);
    if (!parsed.success) return null;
    const controls = new Map<string, ExperienceNode>();
    const visit = (node: ExperienceNode) => { controls.set(node.id,node); if (node.kind === 'stack') node.children.forEach(visit); };
    visit(root);
    if (parsed.data.bindings.some(binding => {
      const target = controls.get(binding.target_id);
      return binding.behavior === 'activate' ? target?.kind !== 'button' && target?.kind !== 'menu' : target?.kind !== 'button' && target?.kind !== 'menu' && target?.kind !== 'input';
    })) return null;
    if (parsed.data.navigation) {
      const list = controls.get(parsed.data.navigation.list_id);
      if (list?.kind !== 'stack' || list.layout !== 'list') return null;
      let count = 0;
      const countRows = (node: ExperienceNode) => { if (node.kind === 'button' && node.variant === 'list') count++; if (node.kind === 'stack') node.children.forEach(countRows); };
      countRows(list); if (count < 1 || count > 100) return null;
    }
    keyboard = parsed.data;
  }
  const validPrintControls = (tree: ExperienceNode): boolean => {
    const buttons = new Set<string>(), documents: Extract<ExperienceNode,{kind:'document'|'resource_document'|'record_document'}>[] = [], linked = new Set<string>();
    const visit = (node: ExperienceNode) => { if (node.kind === 'button') buttons.add(node.id); else if (node.kind === 'document' || node.kind === 'resource_document'||node.kind==='record_document') documents.push(node); else if (node.kind === 'stack') node.children.forEach(visit); else if(node.kind==='menu')node.items.forEach(item=>visit({kind:'button',...item,disabled:node.disabled||item.disabled})); };
    visit(tree);
    return documents.every(node => {
      if (node.print_control_id === undefined) return true;
      if (!buttons.has(node.print_control_id) || linked.has(node.print_control_id)) return false;
      linked.add(node.print_control_id); return true;
    });
  };
  if (!validPrintControls(root) || preferences && !validPrintControls(preferences)) return null;
  if(preferences){let collision=false;const check=(node:ExperienceNode)=>{if(ids.has(node.id))collision=true;ids.add(node.id);if(node.kind==='stack')node.children.forEach(check);};check(preferences);if(collision)return null;}
  const navigation: ExperienceNavigationItem[] = [];
  for (const input of (value.navigation ?? []) as unknown[]) {
    const item = parseNode(input, 0, budget);
    if (!item || item.kind !== 'button' || ids.has(item.id)) return null;
    ids.add(item.id); navigation.push(item);
  }
  return { root, ...(value.navigation!==undefined?{navigation}:{}), ...(preferences?{preferences}:{}), ...(keyboard?{keyboard}:{}),
    ...(v2 ? { schema_version: 'deft.experience_view.v2' as const, capabilities: [...selected] } : {}) };
}

export function createExperienceBridge(input: Readonly<{
  port: ExperiencePort;
  pin: ExperiencePin;
  resourceKeys: readonly string[];
  capabilities?: readonly DeftExperienceCapability[];
  stateKeys?: readonly string[];
  storeKeys?:readonly string[];
  actionKeys: readonly string[];
  navigationKeys?: readonly string[];
  dialogKeys?: readonly string[];
  broker: ExperienceBroker;
  onView(view: ExperienceView): void;
  now?: () => number;
  /** Hosts/tests may shorten the read deadline, never exceed the runtime's 30 seconds. */
  readTimeoutMs?: number;
}>) {
  const pin = Object.freeze({ ...input.pin });
  const resourceKeys = new Set(input.resourceKeys);
  const stateKeys = new Set(input.stateKeys ?? []);
  const storeKeys=new Set(input.storeKeys??[]);
  const actionKeys = new Set(input.actionKeys);
  const navigationKeys = new Set(input.navigationKeys ?? []);
  const dialogKeys = new Set(input.dialogKeys ?? []);
  const now = input.now ?? Date.now;
  const controller = new AbortController();
  let active = true;
  let sequence = 0;
  let latestViewSequence = 0;
  let pending = 0;
  const pendingRequests = new Set<string>();
  let queuedUiEvents = 0;
  let uiTail = Promise.resolve();
  let windowStart = now();
  let inWindow = 0;
  const revoke = () => {
    if (!active) return;
    // Closing a MessagePort does not reject the published SDK's pending promises.
    // Settle uncertainty only; the App retains its original durable request/record.
    for (const requestId of pendingRequests) {
      try { input.port.postMessage({ version: 'deft.experience_bridge.v1', kind: 'response',
        session_id: pin.session_id, request_id: requestId, ok: false, code: 'UNAVAILABLE' }); } catch {}
    }
    pendingRequests.clear();
    active = false;
    controller.abort();
    input.port.onmessage = null;
    input.port.close();
  };
  const send = (message: unknown) => { if (active) {
    if (record(message) && message.kind === 'response' && typeof message.request_id === 'string') pendingRequests.delete(message.request_id);
    input.port.postMessage(message);
  } };
  input.port.onmessage = (event: MessageEvent) => {
    let value: unknown = event.data;
    // Published SDK requests may retain absent optional fields through
    // structured clone. Normalize only these envelope fields, never input JSON.
    if (record(value) && value.kind === 'request') {
      const envelope = { ...value };
      if (Object.hasOwn(envelope, 'key') && envelope.key === undefined) delete envelope.key;
      if (Object.hasOwn(envelope, 'input') && envelope.input === undefined) delete envelope.input;
      value = envelope;
    }
    if (!active || !boundedJson(value, 4096,
      record(value) && value.kind === 'view' ? MAX_VIEW_JSON_DEPTH : 12,
      record(value) && value.kind === 'view') || !record(value)
      || value.version !== 'deft.experience_bridge.v1'
      || value.session_id !== pin.session_id || !integer(value.sequence)
      || value.sequence !== sequence + 1) { revoke(); return; }
    const at = now();
    if (at < windowStart || at - windowStart >= 1000) { windowStart = at; inWindow = 0; }
    if (++inWindow > MAX_PER_SECOND) { revoke(); return; }
    sequence = value.sequence;
    if (value.kind === 'view') {
      if (!exact(value, ['version', 'session_id', 'sequence', 'kind', 'view'])) { revoke(); return; }
      const view = parseExperienceView(value.view, { capabilities: input.capabilities, resourceKeys: input.resourceKeys, stateKeys: input.stateKeys,storeKeys:input.storeKeys,actionKeys:input.actionKeys });
      if (!view) { revoke(); return; }
      const viewSequence = sequence;
      latestViewSequence = viewSequence;
      void Promise.resolve(input.broker.isLive(pin)).then((live) => {
        if (!live) revoke();
        else if (active && viewSequence === latestViewSequence) input.onView(view);
      }).catch(revoke);
      return;
    }
    if (value.kind !== 'request'
      || !exact(value, ['version', 'session_id', 'sequence', 'kind', 'request_id', 'operation', 'key', 'input'])
      || !id(value.request_id) || value.request_id !== `request_${value.sequence}`
      || pending >= MAX_PENDING
      || !['resource', 'open_resource', 'action', 'run_status', 'run_inspect', 'run_cancel', 'navigate', 'dialog', 'private_state','app_data'].includes(String(value.operation))
      || (value.input !== undefined && !boundedJson(value.input))) { revoke(); return; }
    const requestId = value.request_id;
    const operation = value.operation;
    const key = value.key;
    if ((operation === 'private_state' && (!id(key) || !stateKeys.has(key)))
      ||operation==='app_data'&&(!id(key)||!storeKeys.has(key)||!record(value.input)
        ||!['record_list','record_read','record_create','record_archive','resource_list','resource_refresh','connection_metadata','request_status','account_catalog'].includes(String(value.input.operation)))
      ||operation==='app_data'&&record(value.input)&&value.input.target_key!==undefined&&(!['resource_list','record_list'].includes(String(value.input.operation))||typeof value.input.target_key!=='string'||! /^[a-z][a-z0-9_]{0,47}$/.test(value.input.target_key))
      || ((operation === 'resource' || operation === 'open_resource') && (!id(key) || !resourceKeys.has(key)))
      || (operation === 'action' && (!id(key) || !actionKeys.has(key)))
      || (operation === 'navigate' && (!id(key) || !navigationKeys.has(key)))
      || (operation === 'dialog' && (!id(key) || !dialogKeys.has(key)))
      || (['run_status', 'run_inspect', 'run_cancel'].includes(String(operation)) && key !== undefined)) {
      revoke(); return;
    }
    pending += 1;
    pendingRequests.add(requestId);
    // Mailbox reads include metadata/context and live-authority waits. Runtime
    // deadlines alone do not bound these stages. Refresh may commit a cache
    // checkpoint: abort preserves its request journal; it is never replayed.
    // Durable local create/archive have the same unknown-result recovery contract.
    const readOperation = operation === 'run_inspect' || operation === 'app_data' && record(value.input)
      && ['record_list', 'record_read', 'record_create', 'record_archive', 'resource_list', 'resource_refresh', 'connection_metadata', 'request_status'].includes(String(value.input.operation));
    const readController = readOperation ? new AbortController() : null;
    const requestSignal = readController ? AbortSignal.any([controller.signal, readController.signal]) : controller.signal;
    const readTimeoutMs = Number.isFinite(input.readTimeoutMs)
      ? Math.max(1, Math.min(30_000, input.readTimeoutMs!)) : 30_000;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    const expired = readController ? new Promise<never>((_, reject) => {
      readTimer = setTimeout(() => { readController.abort(); reject(new Error('UNAVAILABLE')); }, readTimeoutMs);
    }) : null;
    const awaitRead = async <T,>(work: () => T | Promise<T>): Promise<T> => {
      requestSignal.throwIfAborted();
      const result = expired ? await Promise.race([Promise.resolve().then(work), expired]) : await work();
      requestSignal.throwIfAborted();
      return result;
    };
    void (async () => {
      try {
        if (!await awaitRead(() => input.broker.isLive(pin,readOperation?requestSignal:undefined)) || !active) { revoke(); return; }
        let output: unknown;
        if (operation === 'private_state') output = await input.broker.privateState?.(pin, key as string, value.input, controller.signal);
        else if(operation==='app_data')output=await awaitRead(() => input.broker.appData?.(pin,key as string,value.input,requestSignal));
        else if (operation === 'resource') output = await input.broker.resource?.(pin, key as string, value.input, controller.signal);
        else if (operation === 'open_resource') output = await input.broker.openResource?.(pin, key as string, value.input, controller.signal);
        else if (operation === 'action') output = await input.broker.action?.(
          pin, key as string, value.input, controller.signal, requestId);
        else if (operation === 'run_inspect') output = await awaitRead(() => input.broker.runInspect?.(pin,value.input,requestSignal));
        else if (operation === 'run_status') output = await input.broker.runStatus?.(pin, value.input, controller.signal);
        else if (operation === 'run_cancel') output = await input.broker.runCancel?.(pin, value.input, controller.signal);
        else if (operation === 'navigate') output = await input.broker.navigate?.(pin, key as string, controller.signal);
        else output = await input.broker.dialog?.(pin, key as string, value.input, controller.signal);
        if (!active || !await awaitRead(() => input.broker.isLive(pin,readOperation?requestSignal:undefined))) { revoke(); return; }
        const documentResponse = operation === 'resource' && record(value.input) && value.input.operation === 'read_document';
        const outputStringLimit = documentResponse ? 16384 : 4096;
        if (output === undefined) {
          send({ version: 'deft.experience_bridge.v1', kind: 'response',
            session_id: pin.session_id, request_id: requestId, ok: false, code: 'UNAVAILABLE' });
        } else if (boundedJson(output, outputStringLimit)) {
          const response = { version: 'deft.experience_bridge.v1', kind: 'response',
            session_id: pin.session_id, request_id: requestId, ok: true, output };
          if (operation === 'resource' && (!boundedJson(response, outputStringLimit)
            || encoder.encode(JSON.stringify(response)).byteLength > 60 * 1024)) {
            send({ version: 'deft.experience_bridge.v1', kind: 'response', session_id: pin.session_id,
              request_id: requestId, ok: false, code: 'RESOURCE_PAYLOAD_TOO_LARGE' });
          } else if (boundedJson(response, outputStringLimit)) send(response);
          else revoke();
        } else {
          revoke();
        }
      } catch (reason) {
        const code = reason instanceof Error && ['RESOURCE_PAYLOAD_TOO_LARGE', 'RESOURCE_CURSOR_STALE'].includes(reason.message)
          ? reason.message : 'UNAVAILABLE';
        if (active) send({ version: 'deft.experience_bridge.v1', kind: 'response',
          session_id: pin.session_id, request_id: requestId, ok: false, code });
      } finally { clearTimeout(readTimer); pendingRequests.delete(requestId); pending -= 1; }
    })();
  };
  const sendUiEvent = (uiEvent: unknown, options?:{signal:AbortSignal}): Promise<boolean> => {
    const cancelled=()=>options?.signal.aborted??false;
    if (!active || cancelled() || !boundedJson(uiEvent) || queuedUiEvents >= MAX_PENDING) return Promise.resolve(false);
    queuedUiEvents += 1;
    const task = uiTail.then(async () => {
      if (!active || cancelled()) return false;
      try {
        if (!await input.broker.isLive(pin,options?.signal)) { if(!cancelled())revoke(); return false; }
      } catch { if(!cancelled())revoke(); return false; }
      if (!active || cancelled()) return false;
      send({ version: 'deft.experience_bridge.v1', kind: 'ui_event',
        session_id: pin.session_id, event: uiEvent });
      return true;
    });
    uiTail = task.then(() => { queuedUiEvents -= 1; }, () => { queuedUiEvents -= 1; });
    return task;
  };
  const emitHostEvent=(raw:unknown):Promise<boolean>=>{
    if(!record(raw)||Object.keys(raw).sort().join(',')!=='intake_key,kind,record'||raw.kind!=='record_intake'||!id(raw.intake_key)||!input.capabilities?.includes('record_intake.mailto.v1'))return Promise.resolve(false);
    if(!record(raw.record)||Object.keys(raw.record).sort().join(',')!=='content_digest,record_id,revision,status,store_key')return Promise.resolve(false);
    const parsed=AppDataRecordMetaSchema.pick({store_key:true,record_id:true,revision:true,content_digest:true,status:true}).safeParse(raw.record);if(!parsed.success||!input.storeKeys?.includes(parsed.data.store_key)||parsed.data.status!=='draft')return Promise.resolve(false);
    return sendUiEvent(raw);
  };
  return Object.freeze({ revoke, sendUiEvent,emitHostEvent, get active() { return active; } });
}
