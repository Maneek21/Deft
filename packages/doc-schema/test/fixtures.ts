import type { JSONContent } from '@tiptap/core';

/** A fixed block id; `n` picks the last digits so ids stay readable in failures. */
export function blockId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export function text(value: string, marks?: JSONContent['marks']): JSONContent {
  return marks ? { type: 'text', text: value, marks } : { type: 'text', text: value };
}

export function paragraph(id: string | null, content?: JSONContent[]): JSONContent {
  return content ? { type: 'paragraph', attrs: { id }, content } : { type: 'paragraph', attrs: { id } };
}

const cell = (type: 'tableCell' | 'tableHeader', id: number, value: string): JSONContent => ({
  type,
  attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
  content: [paragraph(blockId(id), [text(value)])],
});

/**
 * A document that uses every node and mark of the document schema, written
 * the way ProseMirror's `toJSON` writes it: every attribute present, marks in
 * schema order. Each block type that carries a block id has one.
 */
export const ALL_NODES: JSONContent = {
  type: 'doc',
  content: [
    { type: 'tableOfContents', attrs: { id: blockId(1) } },
    { type: 'heading', attrs: { id: blockId(2), level: 1 }, content: [text('Launch plan')] },
    { type: 'heading', attrs: { id: blockId(3), level: 2 }, content: [text('Goals')] },
    { type: 'heading', attrs: { id: blockId(4), level: 3 }, content: [text('Details')] },
    paragraph(blockId(5), [
      text('Plain, '),
      text('bold', [{ type: 'bold' }]),
      text(', '),
      text('both', [{ type: 'bold' }, { type: 'italic' }]),
      text(', '),
      text('struck', [{ type: 'strike' }]),
      text(', '),
      text('code()', [{ type: 'code' }]),
      text(', '),
      text('underlined', [{ type: 'underline' }]),
      text(', '),
      text('highlighted', [{ type: 'highlight' }]),
      text(', '),
      text('a link', [{
        type: 'link',
        attrs: { href: 'https://example.com/plan', target: '_blank', rel: 'noopener noreferrer nofollow', class: null, title: null },
      }]),
      { type: 'hardBreak' },
      text('Ask '),
      { type: 'nativeMention', attrs: { kind: 'person', id: 'user_42' } },
      text(' about it.'),
    ]),
    {
      type: 'bulletList',
      attrs: { id: blockId(6) },
      content: [
        { type: 'listItem', content: [paragraph(blockId(7), [text('First point')])] },
        {
          type: 'listItem',
          content: [
            paragraph(blockId(8), [text('Second point')]),
            {
              type: 'bulletList',
              attrs: { id: blockId(9) },
              content: [{ type: 'listItem', content: [paragraph(blockId(10), [text('Nested point')])] }],
            },
          ],
        },
      ],
    },
    {
      type: 'orderedList',
      attrs: { id: blockId(11), start: 1, type: null },
      content: [
        { type: 'listItem', content: [paragraph(blockId(12), [text('Step one')])] },
        { type: 'listItem', content: [paragraph(blockId(13), [text('Step two')])] },
      ],
    },
    {
      type: 'taskList',
      attrs: { id: blockId(14) },
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [paragraph(blockId(15), [text('Write the brief')])] },
        { type: 'taskItem', attrs: { checked: false }, content: [paragraph(blockId(16), [text('Review it')])] },
      ],
    },
    { type: 'blockquote', attrs: { id: blockId(17) }, content: [paragraph(blockId(18), [text('Quoted words')])] },
    { type: 'codeBlock', attrs: { id: blockId(19), language: 'ts' }, content: [text('const a = 1;\n\nconst b = 2;')] },
    { type: 'horizontalRule', attrs: { id: blockId(20) } },
    { type: 'image', attrs: { id: blockId(21), src: null, alt: 'Roadmap', title: 'Roadmap', fileId: 'file_123' } },
    {
      type: 'table',
      attrs: { id: blockId(22) },
      content: [
        { type: 'tableRow', content: [cell('tableHeader', 23, 'Owner'), cell('tableHeader', 24, 'Due')] },
        { type: 'tableRow', content: [cell('tableCell', 25, 'Asha'), cell('tableCell', 26, 'Friday')] },
      ],
    },
    {
      type: 'callout',
      attrs: { id: blockId(27), emoji: '⚠️' },
      content: [paragraph(blockId(28), [text('Mind the '), text('freeze', [{ type: 'bold' }])])],
    },
    {
      type: 'details',
      attrs: { id: blockId(29), open: true },
      content: [
        { type: 'detailsSummary', content: [text('More context')] },
        { type: 'detailsContent', content: [paragraph(blockId(30), [text('Hidden until opened.')])] },
      ],
    },
    { type: 'taskView', attrs: { id: blockId(31), config: { project_id: 'proj_1', statuses: ['todo', 'in_progress'] } } },
    paragraph(blockId(32)),
    paragraph(blockId(33), [text('The end.')]),
  ],
};
