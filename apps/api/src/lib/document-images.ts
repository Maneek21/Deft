// Images in document content, for code that copies content (templates, M1).
// Independent of the one-off notes move (lib/drives-move/**).
import type { jsonToText } from '@deft/doc-schema';

type JSONContent = Parameters<typeof jsonToText>[0];

/** What a dropped image becomes. The same words as the notes move uses. */
export const IMAGE_PLACEHOLDER = 'Image not available';

/** The Deft files the content's images name, in order of first appearance. */
export function imageFileIds(json: JSONContent): string[] {
  const ids = new Set<string>();
  const walk = (node: JSONContent) => {
    const fileId: unknown = node.attrs?.fileId;
    if (node.type === 'image' && typeof fileId === 'string' && fileId !== '') ids.add(fileId);
    node.content?.forEach(walk);
  };
  walk(json);
  return [...ids];
}

/**
 * Every image whose `fileId` isn't in `keepFileIds` becomes an "Image not
 * available" paragraph (with its alt text, when it had one): an image with
 * no or an empty `fileId`, and one from another site (`src` only), included.
 */
export function replaceImagesExcept(json: JSONContent, keepFileIds: ReadonlySet<string>): JSONContent {
  const visit = (node: JSONContent): JSONContent => {
    if (node.type === 'image') {
      const fileId: unknown = node.attrs?.fileId;
      if (typeof fileId === 'string' && fileId !== '' && keepFileIds.has(fileId)) return node;
      const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt.trim() : '';
      return { type: 'paragraph', content: [{ type: 'text', text: alt ? `${IMAGE_PLACEHOLDER}: ${alt}` : IMAGE_PLACEHOLDER }] };
    }
    return node.content ? { ...node, content: node.content.map(visit) } : node;
  };
  return visit(json);
}
