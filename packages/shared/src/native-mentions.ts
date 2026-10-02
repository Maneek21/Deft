import { z } from 'zod';
import { ResourceOpaqueIdSchema, TaskResourceRefV1Schema } from './resources';
import { PersonResourceRefV2Schema, WikiPageResourceRefV2Schema } from './resources-v2';

export const NativeMentionRefSchema = z.union([
  PersonResourceRefV2Schema, TaskResourceRefV1Schema, WikiPageResourceRefV2Schema,
]);
export type NativeMentionRef = z.infer<typeof NativeMentionRefSchema>;
export const NativeMentionKindSchema = z.enum(['person', 'task', 'wiki_page']);
export type NativeMentionKind = z.infer<typeof NativeMentionKindSchema>;
export const NativeMentionSourceSchema = z.strictObject({
  kind: z.enum(['message', 'task', 'task_comment', 'wiki_page']),
  id: ResourceOpaqueIdSchema,
});
export type NativeMentionSource = z.infer<typeof NativeMentionSourceSchema>;
export const NATIVE_MENTION_LIMIT = 100;
export class NativeMentionLimitError extends Error {
  constructor() { super('Too many native references (maximum 100)'); }
}
export const NativeMentionRefsSchema = z.array(NativeMentionRefSchema).max(NATIVE_MENTION_LIMIT);

export function nativeMentionRef(kind: NativeMentionKind, id: string): NativeMentionRef {
  return NativeMentionRefSchema.parse({
    schema_version: kind === 'task' ? 'deft.resource_ref.v1' : 'deft.resource_ref.v2',
    provider: { kind: 'core', provider_instance_id:
      kind === 'person' ? 'people' : kind === 'task' ? 'tasks' : 'wiki_pages' },
    resource_type: kind, resource_id: id,
  });
}

export function nativeMentionKey(ref: NativeMentionRef): string {
  return `${ref.resource_type}:${ref.resource_id}`;
}

/** Markdown stores only identity; labels are live, authorized projections. */
export function nativeMentionToken(ref: NativeMentionRef): string {
  NativeMentionRefSchema.parse(ref);
  return `[[deft:${nativeMentionKey(ref)}]]`;
}

export function nativeMentionPlaceholder(kind: NativeMentionKind): string {
  return kind === 'person' ? '@Person' : kind === 'task' ? '@Task' : '@Wiki';
}

/** Ignore literal/quoted contexts, including incomplete code while an editor saves. */
function visibleNativeContent(content: string): string {
  const mask = (value: string) => value.replace(/[^\n]/g, ' ');
  let fence: string | null = null;
  const markdown = content.split('\n').map(line => {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (delimiter) {
      if (!fence) fence = delimiter[1]!;
      else if (delimiter[1]![0] === fence[0] && delimiter[1]!.length >= fence.length) fence = null;
      return mask(line);
    }
    if (fence || /^\s*>/.test(line) || /^(?: {4}|\t)/.test(line)) return mask(line);
    return line;
  }).join('\n');
  const literals = markdown.replace(/(`+)[\s\S]*?\1/g, mask).replace(/`[^\n]*$/gm, mask)
    .replace(/!?\[[^\n]*?\]\([^\n]*?\)/g, mask)
    .replace(/(?:\\)+\[\[deft:[^\]]+\]\]/g, mask);
  const stack: string[] = [];
  return literals.replace(/<!--[\s\S]*?(?:-->|$)|<\/?[a-z][^>]*>|[^<]+|</gi, token => {
    if (token.startsWith('<!--')) return mask(token);
    const tag = token.match(/^<(\/?)(pre|code|blockquote|script|style|textarea)\b/i);
    if (tag) {
      const name = tag[2]!.toLowerCase();
      if (!tag[1]) stack.push(name);
      else { const index = stack.lastIndexOf(name); if (index >= 0) stack.splice(index); }
      return mask(token);
    }
    return stack.length ? mask(token) : token;
  });
}

/** Parse identity-bearing atoms, never resolve names or client-supplied URLs. */
export function extractNativeMentions(content: string): NativeMentionRef[] {
  const visible = visibleNativeContent(content);
  const refs = new Map<string, NativeMentionRef>();
  const add = (kind: unknown, id: unknown) => {
    const parsedKind = NativeMentionKindSchema.safeParse(kind);
    const parsedId = ResourceOpaqueIdSchema.safeParse(id);
    if (!parsedKind.success || !parsedId.success) return;
    const ref = nativeMentionRef(parsedKind.data, parsedId.data);
    refs.set(nativeMentionKey(ref), ref);
    if (refs.size > NATIVE_MENTION_LIMIT) throw new NativeMentionLimitError();
  };
  for (const match of visible.replace(/<[^>]*>/g, value => value.replace(/[^\n]/g, ' ')).matchAll(/\[\[deft:(person|task|wiki_page):([^\]\s]+)\]\]/g)) {
    add(match[1], match[2]);
  }
  for (const match of visible.matchAll(/<span\b([^>]*)>/gi)) {
    const attrs = new Map<string, string>();
    for (const attr of match[1]!.matchAll(/(?:^|\s)(data-deft-ref-kind|data-deft-ref-id)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const key = attr[1]!.toLowerCase();
      // Duplicate identity attributes are malformed, not last-write-wins.
      if (attrs.has(key)) { attrs.clear(); break; }
      attrs.set(key, attr[2] ?? attr[3] ?? '');
    }
    add(attrs.get('data-deft-ref-kind'), attrs.get('data-deft-ref-id'));
  }
  return [...refs.values()];
}

/** Keep identity atoms out of legacy fuzzy name matching. */
export function stripNativeMentionAtoms(content: string): string {
  return content.replace(/<span\b[^>]*data-deft-ref-kind[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/\[\[deft:(person|task|wiki_page):[^\]]+\]\]/g, '');
}
/** Replace tokens before Markdown rendering; caller must sanitize the result. */
export function nativeMentionTokensToHtml(content: string): string {
  const visible = visibleNativeContent(content).replace(/<[^>]*>/g, value => value.replace(/[^\n]/g, ' '));
  return content.replace(/\[\[deft:(person|task|wiki_page):([^\]\s]+)\]\]/g, (token, kind, id, offset) => {
    if (visible.slice(offset, offset + token.length) !== token) return token;
    const parsed = ResourceOpaqueIdSchema.safeParse(id);
    if (!parsed.success) return token;
    return `<span data-deft-ref-kind="${kind}" data-deft-ref-id="${id}">${nativeMentionPlaceholder(kind)}</span>`;
  });
}
