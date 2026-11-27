import { Image } from '@tiptap/extension-image';

/**
 * Notes saved before `data-file-id` point at the file with a relative
 * `/api/files/<id>` source. An absolute or protocol-relative URL belongs to
 * another site even when its path looks the same, so it never names a Deft file.
 */
function fileIdFromLegacyPath(value: string | null): string | null {
  const match = value?.match(/^\/api\/files\/([^/?#]+)(?:[?#]|$)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

const stringAttribute = (name: string) => ({
  default: null,
  parseHTML: (el: HTMLElement) => el.getAttribute(name),
  renderHTML: (attrs: Record<string, unknown>) => attrs[name] ? { [name]: attrs[name] } : {},
});

/**
 * A block image. `fileId` names a Deft file, which is fetched with the
 * viewer's own access; `src` is only for images from elsewhere. Reads the
 * notes editor's `img[data-file-id]` as well as plain `img[src]`.
 */
export const DocumentImage = Image.extend({
  addAttributes() {
    return {
      src: stringAttribute('src'),
      alt: stringAttribute('alt'),
      title: stringAttribute('title'),
      fileId: {
        default: null,
        parseHTML: el => el.getAttribute('data-file-id') || fileIdFromLegacyPath(el.getAttribute('src')),
        renderHTML: attrs => attrs.fileId ? { 'data-file-id': attrs.fileId } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'img[data-file-id]' }, { tag: 'img[src]:not([src^="data:"])' }];
  },
}).configure({ inline: false, allowBase64: false });
