import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (attrs?: { emoji?: string }) => ReturnType;
      toggleCallout: () => ReturnType;
    };
  }
}

/**
 * Takes a callout's blocks from the body wrapper it renders, so the emoji
 * span next to it is not read back as a paragraph. A bare
 * `<div data-callout>` (Markdown, hand-written HTML) holds its blocks directly.
 */
function calloutBody(node: globalThis.Node): HTMLElement {
  const element = node as HTMLElement;
  const body = Array.from(element.children).find(child => child.classList.contains('deft-callout-body'));
  return (body as HTMLElement | undefined) ?? element;
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      emoji: {
        default: '💡',
        parseHTML: el => (el as HTMLElement).getAttribute('data-emoji') || '💡',
        renderHTML: attrs => ({ 'data-emoji': attrs.emoji }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]', contentElement: calloutBody }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-callout': '',
        class: 'deft-callout',
      }),
      ['span', { class: 'deft-callout-emoji', contenteditable: 'false' }, node.attrs.emoji],
      ['div', { class: 'deft-callout-body' }, 0],
    ];
  },

  addCommands() {
    return {
      setCallout:
        (attrs) =>
        ({ commands }) =>
          commands.wrapIn(this.name, attrs),
      toggleCallout:
        () =>
        ({ commands }) =>
          commands.toggleWrap(this.name),
    };
  },
});
