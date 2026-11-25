import { getSchema, type Extensions } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Highlight } from '@tiptap/extension-highlight';
import { UniqueID } from '@tiptap/extension-unique-id';
import { Callout } from './nodes/callout';
import { DocumentImage } from './nodes/document-image';
import { NativeMention } from './nodes/native-mention';
import { TableOfContents } from './nodes/table-of-contents';
import { TaskView } from './nodes/task-view';
import { Toggle, ToggleContent, ToggleSummary } from './nodes/toggle';

/** The heading levels a document has; imports fold deeper headings into the last one. */
export const HEADING_LEVELS = [1, 2, 3] as const;

/** The node types that carry a block id (`attrs.id`): every top-level block type. */
export const BLOCK_ID_TYPES = [
  'paragraph', 'heading', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'table',
  'callout', 'details', 'image', 'taskView', 'horizontalRule', 'tableOfContents',
] as const;

/**
 * Every extension that shapes a document: its nodes, marks and attributes.
 * The web editor and the API build the same schema from this list. Nothing
 * here imports React; the only view code is what TipTap's own extensions
 * carry, which runs only inside an editor.
 *
 * StarterKit is already in the list (with undo/redo off, because
 * Collaboration brings its own); an editor adds its own view extensions
 * (Collaboration, carets, placeholder, menus) next to it.
 */
export function documentSchemaExtensions(): Extensions {
  return [
    StarterKit.configure({ heading: { levels: [...HEADING_LEVELS] }, undoRedo: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table,
    TableRow,
    TableHeader,
    TableCell,
    Highlight.configure({ multicolor: false }),
    DocumentImage,
    Callout,
    Toggle,
    ToggleSummary,
    ToggleContent,
    NativeMention,
    TaskView,
    TableOfContents,
    UniqueID.configure({
      attributeName: 'id',
      types: [...BLOCK_ID_TYPES],
      generateID: () => crypto.randomUUID(),
    }),
  ];
}

let cachedSchema: Schema | null = null;

export function getDocumentSchema(): Schema {
  cachedSchema ??= getSchema(documentSchemaExtensions());
  return cachedSchema;
}
