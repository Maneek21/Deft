export type ComposerScalar = string | number | boolean | null;
export type ComposerInput = Record<string, ComposerScalar>;
export function composerCompletion(current: () => Readonly<{active:boolean;generation:number}>) {
  const {active,generation} = current();
  return () => { const latest=current(); return active && latest.active && generation===latest.generation; };
}
export type ExperienceComposeRequest = Readonly<{
  action_key: string; input?: ComposerInput; draft_state_key: string; draft_id: string;
}>;
export type ComposerField = Readonly<{ key: string; label: string; type: 'string' | 'number' | 'boolean'; maxLength?: number; minimum?: number; maximum?: number; required: boolean }>;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export function composerFields(schema: unknown): readonly ComposerField[] {
  if (!object(schema) || schema.type !== 'object' || schema.additionalProperties !== false || !object(schema.properties)
    || !Array.isArray(schema.required) || Object.keys(schema.properties).length > 32) throw new Error('Unsupported action fields.');
  const required = schema.required;
  return Object.entries(schema.properties).map(([key, value]) => {
    if (!/^[a-zA-Z0-9_]{1,80}$/.test(key) || !object(value) || !['string', 'number', 'integer', 'boolean'].includes(String(value.type))) throw new Error('Unsupported action fields.');
    if (value.type === 'string' && (!Number.isInteger(value.maxLength) || Number(value.maxLength) < 1 || Number(value.maxLength) > 16384)) throw new Error('Unsupported action fields.');
    const name = key.replaceAll('_', ' ').replace(/\bid\b/gi, 'ID');
    return { key, label: name.charAt(0).toUpperCase() + name.slice(1), type: value.type === 'integer' ? 'number' : value.type as ComposerField['type'],
      ...(value.type === 'string' ? { maxLength: Number(value.maxLength) } : {}),
      ...(typeof value.minimum === 'number' ? { minimum: value.minimum } : {}),
      ...(typeof value.maximum === 'number' ? { maximum: value.maximum } : {}), required: required.includes(key) };
  }).sort((left, right) => {
    const rank = (field: ComposerField) => field.type === 'string' && Number(field.maxLength) > 512 ? 2 : field.required ? 0 : 1;
    return rank(left) - rank(right) || (left.required && right.required ? required.indexOf(left.key) - required.indexOf(right.key) : 0);
  });
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
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  const flush = (): Promise<void> => {
    if (pending) return pending;
    if (closed || blocked || !latest || written === generation) return Promise.resolve();
    pending = (async () => {
      while (!closed && !blocked && latest && written !== generation) {
        const captured = latest, version = generation;
        try { revision = await write(revision, captured, keepalive); written = version; }
        catch { blocked = true; }
      }
    })().finally(() => { pending = null; notify(); });
    notify(); return pending;
  };
  return {
    get dirty() { return written !== generation; }, get blocked() { return blocked; }, get saving() { return pending !== null; }, get revision() { return revision; },
    change(value: ComposerInput) { if (closed) return; latest = { ...value }; generation++; notify(); void flush(); },
    flush(allowKeepalive = false) { keepalive ||= allowKeepalive; return flush(); },
    resumeAfterRead(currentRevision: number, alreadySaved: boolean) {
      if (closed || pending || !Number.isSafeInteger(currentRevision) || currentRevision < revision) return false;
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
