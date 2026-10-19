/** A message-only notification must resolve its currently visible space first. */
export function messageDeepLinkDestination(value: unknown, messageId: string, visibleSpaceIds: readonly string[], search: string): string | null {
  if (!value || typeof value !== 'object' || !('parent' in value)) return null;
  const parent = value.parent;
  if (!parent || typeof parent !== 'object' || !('id' in parent) || parent.id !== messageId
    || !('space_id' in parent) || typeof parent.space_id !== 'string' || !visibleSpaceIds.includes(parent.space_id)) return null;
  const query = new URLSearchParams(search);
  if (query.getAll('message').length !== 1 || query.get('message') !== messageId || query.has('space')) return null;
  query.set('space', parent.space_id);
  return `/chat?${query.toString()}`;
}
