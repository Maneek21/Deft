import { extractNativeMentions, nativeMentionToken, NativeMentionLimitError, type NativeMentionRef } from '@deft/shared';
import { loadNativeSource, resolveNativeMentions, searchNativeMentions, type NativeMentionContext } from './native-mentions.js';

function canReadType(ref: NativeMentionRef, scopes?: readonly string[]) {
  return !scopes || ref.resource_type === 'person'
    || scopes.includes(ref.resource_type === 'task' ? 'read:tasks' : 'read:wiki');
}
export async function searchAgentNativeMentions(ctx: NativeMentionContext, query: string, scopes?: readonly string[]) {
  const items = await searchNativeMentions(ctx, query);
  return items.filter(item => canReadType(item.ref, scopes)).map(item => ({ ...item, token: nativeMentionToken(item.ref) }));
}
export async function nativeMentionAgentSourceContext(ctx: NativeMentionContext, content: string, scopes?: readonly string[]) {
  let references: NativeMentionRef[] = [], referencesLimited = false;
  try { references = extractNativeMentions(content); }
  catch (error) { if (!(error instanceof NativeMentionLimitError)) throw error; referencesLimited = true; }
  const authorizedReferences = await resolveNativeMentions(ctx, references.filter(ref => canReadType(ref, scopes)));
  return { content: content.slice(0, 5000), truncated: content.length > 5000,
    references: authorizedReferences, references_limited: referencesLimited, untrusted: true as const };
}
export async function resolveAgentNativeMentions(ctx: NativeMentionContext, refs: NativeMentionRef[], scopes?: readonly string[]) {
  const allowed = refs.filter(ref => canReadType(ref, scopes));
  const projections = await resolveNativeMentions(ctx, allowed);
  const byIdentity = new Map(projections.map(item => [nativeMentionToken(item.ref), item]));
  return Promise.all(refs.map(async ref => {
    const item = byIdentity.get(nativeMentionToken(ref));
    if (!item || item.state !== 'available') return { ref, state: 'unavailable' as const };
    const source = ref.resource_type === 'person' ? null : await loadNativeSource(ctx, {
      kind: ref.resource_type === 'task' ? 'task' : 'wiki_page', id: ref.resource_id,
    });
    if (ref.resource_type !== 'person' && !source) return { ref, state: 'unavailable' as const };
    return { ...item, token: nativeMentionToken(ref), ...(source ? {
      current_source: await nativeMentionAgentSourceContext(ctx, source.content, scopes),
    } : {}) };
  }));
}
