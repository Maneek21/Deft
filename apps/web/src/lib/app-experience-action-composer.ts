import { validateComposePlainContent } from './app-experience-compose-controls';
import { parseSafeComposeHtml } from '../../../../packages/app-kit/src/safe-compose-html';
import { parseMailboxList } from '../../../../packages/app-kit/src/mailbox-list';
import { parseResourceRecordList } from '../../../../packages/app-kit/src/resource-record-list';
import { RuntimeObjectSchema } from '../../../../packages/app-kit/src/runtime-authoring';

export type ComposerScalar = string | number | boolean | null;
export type ComposerInput = Record<string, ComposerScalar>;
export function composerCompletion(current: () => Readonly<{active:boolean;generation:number}>) {
  const {active,generation} = current();
  return () => { const latest=current(); return active && latest.active && generation===latest.generation; };
}
export type ExperienceComposeRequest = Readonly<{
  action_key: string; input?: ComposerInput; draft_state_key: string; draft_id: string;
}>;
export type ComposerField = Readonly<{ key: string; label: string; type: 'string' | 'number' | 'boolean'; maxLength?: number; minLength?: number; format?: 'email' | 'single_line' | 'mailbox_list' | 'safe_html' | 'resource_record_list'; maxItems?: number; plainTextKey?: string; resourceKey?: string; readOnly?: boolean; minimum?: number; maximum?: number; required: boolean }>;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export function composerFields(schema: unknown): readonly ComposerField[] {
  const parsed = RuntimeObjectSchema.safeParse(schema);
  if (!parsed.success) throw new Error('Unsupported action fields.');
  schema = parsed.data;
  if (!object(schema) || schema.type !== 'object' || schema.additionalProperties !== false || !object(schema.properties)
    || !Array.isArray(schema.required) || Object.keys(schema.properties).length > 32) throw new Error('Unsupported action fields.');
  const required = schema.required;
  return Object.entries(schema.properties).map(([key, value]) => {
    if (!/^[a-zA-Z0-9_]{1,80}$/.test(key) || !object(value) || !['string', 'number', 'integer', 'boolean'].includes(String(value.type))) throw new Error('Unsupported action fields.');
    if (value.type === 'string' && (!Number.isInteger(value.maxLength) || Number(value.maxLength) < 1 || Number(value.maxLength) > 16384)) throw new Error('Unsupported action fields.');
    if (value.format !== undefined && (value.type !== 'string' || !['email','single_line','mailbox_list','safe_html','resource_record_list'].includes(String(value.format)))) throw new Error('Unsupported action fields.');
    if (value.format === 'mailbox_list' || value.format === 'resource_record_list') {
      if (!Number.isInteger(value.maxItems) || Number(value.maxItems) < 1 || Number(value.maxItems) > (value.format === 'mailbox_list' ? 32 : 25) || Number(value.maxLength) > (value.format === 'mailbox_list' ? 2048 : 925)) throw new Error('Unsupported action fields.');
    } else if (value.maxItems !== undefined) throw new Error('Unsupported action fields.');
    if (value.format === 'resource_record_list' ? typeof value.resourceKey !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/u.test(value.resourceKey) || ['__proto__','constructor','prototype'].includes(value.resourceKey) : value.resourceKey !== undefined) throw new Error('Unsupported action fields.');
    const name = key.replaceAll('_', ' ').replace(/\bid\b/gi, 'ID');
    return { key, label: typeof value.title === 'string' ? value.title : name.charAt(0).toUpperCase() + name.slice(1), type: value.type === 'integer' ? 'number' : value.type as ComposerField['type'],
      ...(typeof value.minLength === 'number' ? {minLength:value.minLength} : {}),
      ...(value.format !== undefined ? {format:value.format as ComposerField['format']} : {}),
      ...(value.maxItems !== undefined ? {maxItems:Number(value.maxItems)} : {}),
      ...(value.format === 'safe_html' ? {plainTextKey:String(value.plainTextKey)} : {}),
      ...(value.resourceKey !== undefined ? {resourceKey:String(value.resourceKey)} : {}), ...(value.readOnly === true ? {readOnly:true} : {}),
      ...(value.type === 'string' ? { maxLength: Number(value.maxLength) } : {}),
      ...(typeof value.minimum === 'number' ? { minimum: value.minimum } : {}),
      ...(typeof value.maximum === 'number' ? { maximum: value.maximum } : {}), required: required.includes(key) };
  }).sort((left, right) => {
    const rank = (field: ComposerField) => field.type === 'string' && field.format !== 'mailbox_list' && Number(field.maxLength) > 512 ? 2 : field.required ? 0 : 1;
    return rank(left) - rank(right) || (left.required && right.required ? required.indexOf(left.key) - required.indexOf(right.key) : 0);
  });
}
/** Early feedback; the host independently validates the contract before issuing a ticket. */
export function composerValidationError(fields: readonly ComposerField[], input: ComposerInput): string | null {
  for (const field of fields) {
    const value=input[field.key];
    if (field.type === 'string') {
      if (typeof value !== 'string' || value.length < (field.minLength ?? 0) || value.length > (field.maxLength ?? 16384)) return `Check ${field.label.toLowerCase()}.`;
      if (field.format === 'email' && !/^[^\s<>,;"@]+@[^\s<>,;"@]+\.[^\s<>,;"@]+$/.test(value)) return `Enter one valid email address for ${field.label.toLowerCase()}.`;
      if (field.format === 'single_line' && /[\r\n\0]/u.test(value)) return `Use one line without null characters for ${field.label.toLowerCase()}.`;
      if (field.format === 'mailbox_list') {
        try { parseMailboxList(value, {maxItems:field.maxItems,allowEmpty:(field.minLength ?? 0) === 0}); } catch { return `Check ${field.label.toLowerCase()}.`; }
      }
      if (field.format === 'safe_html') {
        try { if (value !== '' && parseSafeComposeHtml(value, {maxCharacters:field.maxLength}).plainText !== input[field.plainTextKey!])
          return `The plain text for ${field.label.toLowerCase()} must match its formatting.`; }
        catch { return `Check the bounded formatting for ${field.label.toLowerCase()}.`; }
      }
      if (field.format === 'resource_record_list') {
        try { parseResourceRecordList(value, {maxItems:field.maxItems,allowEmpty:(field.minLength ?? 0) === 0}); } catch { return `Check ${field.label.toLowerCase()}.`; }
      }
      if (!field.readOnly && !['mailbox_list','safe_html','resource_record_list'].includes(field.format ?? '') && (field.maxLength ?? 0) > 512) {
        const error = validateComposePlainContent({ format: 'plain', text: value }, 4 * (field.maxLength ?? 16384), field.maxLength);
        if (error) return `${field.label}: ${error.error}`;
      }
    }
  }
  return null;
}
export function mergeComposerDraft(saved: ComposerInput, input: ComposerInput): ComposerInput {
  const value = { ...saved };
  for (const key of Object.keys(value)) if (Object.hasOwn(input, key)) value[key] = input[key];
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 16384) throw new Error('Saved data exceeds its limit.');
  return value;
}
export function createComposerSaver(initialRevision: number, write: (revision: number, value: ComposerInput, keepalive: boolean) => Promise<number>) {
  let revision = initialRevision, latest: ComposerInput | null = null, generation = 0, written = 0;
  let pending: Promise<void> | null = null, blocked = false, closed = false, keepalive = false;
  let mutation: Promise<unknown> | null = null, held = false;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  const flush = (): Promise<void> => {
    if (pending) return pending;
    if (closed || blocked || held || !latest || written === generation) return Promise.resolve();
    pending = (async () => {
      while (!closed && !blocked && !held && latest && written !== generation) {
        const captured = latest, version = generation;
        try { revision = await write(revision, captured, keepalive); written = version; }
        catch { blocked = true; }
      }
    })().finally(() => { pending = null; notify(); });
    notify(); return pending;
  };
  return {
    get dirty() { return written !== generation; }, get blocked() { return blocked; }, get saving() { return pending !== null || mutation !== null; }, get revision() { return revision; },
    change(value: ComposerInput) { if (closed) return; latest = { ...value }; generation++; notify(); void flush(); },
    flush(allowKeepalive = false) {
      keepalive ||= allowKeepalive;
      return mutation ? mutation.then(() => flush(), () => undefined) : flush();
    },
    /** Files and scalar edits share one CAS lane. Edits made during the external
     * mutation wait for its acknowledged revision; ambiguous failure stops both. */
    mutate<T>(operation: (revision: number) => Promise<{ revision: number; value: T }>): Promise<T> {
      if (closed || blocked || mutation) return Promise.reject(Error('Draft needs a current read'));
      held = true;
      const captured = latest, version = generation;
      const task = (async () => {
        await pending;
        if (closed || blocked) throw Error('Unconfirmed saved draft');
        if (captured && written !== version) { revision = await write(revision, captured, keepalive); written = version; }
        if (closed || blocked) throw Error('Draft closed');
        const previous = revision, result = await operation(previous);
        if (closed || !Number.isSafeInteger(result.revision) || result.revision < previous || result.revision > 2147483646) throw Error('Unconfirmed draft mutation');
        revision = result.revision; return result.value;
      })().catch(error => { blocked = true; throw error; }).finally(() => {
        mutation = null; held = false; notify(); if (!closed && !blocked) void flush();
      });
      mutation = task; notify(); return task;
    },
    resumeAfterRead(currentRevision: number, alreadySaved: boolean) {
      if (closed || pending || mutation || !Number.isSafeInteger(currentRevision) || currentRevision < revision) return false;
      revision = currentRevision; blocked = false;
      if (alreadySaved) written = generation;
      notify(); if (!alreadySaved) void flush(); return true;
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { closed = true; latest = null; listeners.clear(); },
  };
}

export function composerRecoveryMode(saved: ComposerInput, revision: number, restored: { baseRevision: number; value: ComposerInput; submission?: unknown } | null): 'none' | 'restore' | 'conflict' | 'submission' {
  if (restored?.submission) return 'submission';
  if (!restored || (Object.keys(restored.value).length === Object.keys(saved).length
    && Object.entries(saved).every(([key,value]) => Object.hasOwn(restored.value,key) && restored.value[key] === value))) return 'none';
  return restored.baseRevision === revision ? 'restore' : 'conflict';
}
