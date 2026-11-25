import { Node, mergeAttributes } from '@tiptap/core';

/** A block that lists the document's headings; the web app draws the list. */
export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,

  parseHTML() {
    return [{ tag: 'div[data-table-of-contents]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-table-of-contents': '' })];
  },
});
