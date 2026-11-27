import { Node, mergeAttributes } from '@tiptap/core';
import {
  NativeMentionKindSchema,
  ResourceOpaqueIdSchema,
  nativeMentionPlaceholder,
  nativeMentionRef,
  nativeMentionToken,
} from '@deft/shared';

export function isNativeMention(kind: unknown, id: unknown): boolean {
  return NativeMentionKindSchema.safeParse(kind).success && ResourceOpaqueIdSchema.safeParse(id).success;
}

/** The `[[deft:kind:id]]` token, or '' when the attributes name nothing valid. */
export function nativeMentionText(kind: unknown, id: unknown): string {
  if (!isNativeMention(kind, id)) return '';
  return nativeMentionToken(nativeMentionRef(NativeMentionKindSchema.parse(kind), String(id)));
}

/**
 * The schema half of the editor's native mention: the same name, attributes
 * and HTML as `apps/web/src/lib/editor/native-mention-extension.tsx`, without
 * the suggestion menu or the React chip.
 */
export const NativeMention = Node.create({
  name: 'nativeMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      kind: { default: 'person', parseHTML: el => el.getAttribute('data-deft-ref-kind'), rendered: false },
      id: { default: '', parseHTML: el => el.getAttribute('data-deft-ref-id'), rendered: false },
    };
  },

  parseHTML() {
    return [{
      tag: 'span[data-deft-ref-kind][data-deft-ref-id]',
      getAttrs: el => isNativeMention(el.getAttribute('data-deft-ref-kind'), el.getAttribute('data-deft-ref-id')) ? null : false,
    }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const kind = NativeMentionKindSchema.safeParse(node.attrs.kind);
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-deft-ref-kind': node.attrs.kind, 'data-deft-ref-id': node.attrs.id }),
      kind.success ? nativeMentionPlaceholder(kind.data) : '',
    ];
  },

  renderText({ node }) {
    return nativeMentionText(node.attrs.kind, node.attrs.id);
  },
});
