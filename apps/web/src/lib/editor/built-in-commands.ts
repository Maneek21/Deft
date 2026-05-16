/**
 * Registers built-in block-insertion slash commands on the singleton registry.
 *
 * Surfaces this is imported into will receive all the commands; per-surface
 * gating is done via each command's `surfaces` array. This module has a
 * side effect (registration) and should only be imported once — see the
 * surface mounts.
 */
import { slashRegistry, type SlashCommand } from './commands';

const COMMON_SURFACES: SlashCommand['surfaces'] = ['chat', 'note', 'task', 'task-comment', 'canvas'];
// Chat tends to be short-form; we omit headings/toggle/callout there.
const DOC_SURFACES: SlashCommand['surfaces'] = ['note', 'task', 'canvas'];

const commands: SlashCommand[] = [
  {
    id: 'heading-1',
    group: 'block',
    label: 'Heading 1',
    description: 'Top-level section heading',
    keywords: ['h1', 'title'],
    surfaces: DOC_SURFACES,
    iconName: 'Heading1',
    run: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run();
    },
  },
  {
    id: 'heading-2',
    group: 'block',
    label: 'Heading 2',
    description: 'Medium heading',
    keywords: ['h2', 'subtitle'],
    surfaces: DOC_SURFACES,
    iconName: 'Heading2',
    run: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run();
    },
  },
  {
    id: 'heading-3',
    group: 'block',
    label: 'Heading 3',
    description: 'Small heading',
    keywords: ['h3'],
    surfaces: DOC_SURFACES,
    iconName: 'Heading3',
    run: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run();
    },
  },
  {
    id: 'bullet-list',
    group: 'block',
    label: 'Bullet list',
    description: 'Unordered list',
    keywords: ['ul', 'bullets'],
    surfaces: COMMON_SURFACES,
    iconName: 'List',
    run: ({ editor, range }) => {
      (editor.chain() as any).focus().deleteRange(range).toggleBulletList().run();
    },
  },
  {
    id: 'numbered-list',
    group: 'block',
    label: 'Numbered list',
    description: 'Ordered list',
    keywords: ['ol', 'ordered'],
    surfaces: COMMON_SURFACES,
    iconName: 'ListOrdered',
    run: ({ editor, range }) => {
      (editor.chain() as any).focus().deleteRange(range).toggleOrderedList().run();
    },
  },
  {
    id: 'task-list',
    group: 'block',
    label: 'Task list',
    description: 'Checkboxes',
    keywords: ['todo', 'checkbox'],
    surfaces: COMMON_SURFACES,
    iconName: 'CheckSquare',
    run: ({ editor, range }) => {
      (editor.chain() as any).focus().deleteRange(range).toggleTaskList().run();
    },
  },
  {
    id: 'quote',
    group: 'block',
    label: 'Quote',
    description: 'Quoted text',
    keywords: ['blockquote', 'cite'],
    surfaces: COMMON_SURFACES,
    iconName: 'Quote',
    run: ({ editor, range }) => {
      (editor.chain() as any).focus().deleteRange(range).toggleBlockquote().run();
    },
  },
  {
    id: 'divider',
    group: 'block',
    label: 'Divider',
    description: 'Horizontal rule',
    keywords: ['hr', 'separator'],
    surfaces: DOC_SURFACES,
    iconName: 'Minus',
    run: ({ editor, range }) => {
      (editor.chain() as any).focus().deleteRange(range).setHorizontalRule().run();
    },
  },
  {
    id: 'code-block',
    group: 'block',
    label: 'Code block',
    description: 'Code with syntax highlighting',
    keywords: ['code', 'snippet'],
    surfaces: COMMON_SURFACES,
    iconName: 'Code',
    run: ({ editor, range }) => {
      (editor.chain() as any).focus().deleteRange(range).setCodeBlock().run();
    },
  },
  {
    id: 'callout',
    group: 'block',
    label: 'Callout',
    description: 'Highlighted block with emoji',
    keywords: ['note', 'info', 'warning'],
    surfaces: DOC_SURFACES,
    iconName: 'Lightbulb',
    run: ({ editor, range }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({
          type: 'callout',
          attrs: { emoji: '💡' },
          content: [{ type: 'paragraph' }],
        })
        .run();
    },
  },
  {
    id: 'toggle',
    group: 'block',
    label: 'Toggle',
    description: 'Collapsible section',
    keywords: ['details', 'collapsible'],
    surfaces: DOC_SURFACES,
    iconName: 'ChevronRight',
    run: ({ editor, range }) => {
      (editor.chain() as any).focus().deleteRange(range).setDetails().run();
    },
  },
];

let registered = false;
export function registerBuiltInCommands() {
  if (registered) return;
  for (const cmd of commands) slashRegistry.register(cmd);
  registered = true;
}
