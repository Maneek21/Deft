import { Image } from '@tiptap/extension-image';

/** Notes saved before `data-file-id` point at the file as `/api/files/<id>`. */
function fileIdFromLegacyUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const match = new URL(value, 'http://deft.invalid').pathname.match(/^\/api\/files\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]!) : null;
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
        parseHTML: el => el.getAttribute('data-file-id') || fileIdFromLegacyUrl(el.getAttribute('src')),
        renderHTML: attrs => attrs.fileId ? { 'data-file-id': attrs.fileId } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'img[data-file-id]' }, { tag: 'img[src]:not([src^="data:"])' }];
  },
}).configure({ inline: false, allowBase64: false });
