'use client';

// The document body (plan Task F12): the live editor over the document's
// Yjs state, and the read-only copy drawn from its stored JSON when live
// editing can't be used (live editing off, busy, crowded, a paused workspace).
// Both use the same schema and views (lib/editor/document-extensions.ts);
// this module is loaded only through next/dynamic (document-lazy.tsx). The
// toolbar shows only to someone who can edit; at phone width it folds behind
// one "Format" button. Images upload into the document (F10) from the
// toolbar, by paste, by drop and with /image.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import {
  Bold, CheckSquare, Code, Heading2, Heading3, Highlighter, ImagePlus, Italic, List, ListOrdered, Minus, Quote, Strikethrough,
  Table as TableIcon, Type, Underline as UnderlineIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { collaboratorName } from '@/lib/collab-people';
import {
  createDocumentExtensions, createDocumentReadOnlyExtensions, refreshCarets, type DocumentUser, type ImageUpload,
} from '@/lib/editor/document-extensions';
import { registerBuiltInCommands } from '@/lib/editor/built-in-commands';

registerBuiltInCommands();

const BODY_CLASS = 'deft-editor deft-document-editor min-h-[40vh] outline-none';

function ToolButton({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md md:h-8 md:w-8"
      style={{ background: active ? 'var(--surface-container-high, var(--surface-container))' : 'transparent', color: active ? 'var(--on-surface)' : 'var(--on-surface-variant)' }}
    >
      {children}
    </button>
  );
}

function DocumentToolbar({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'),
      code: e.isActive('code'), highlight: e.isActive('highlight'), h2: e.isActive('heading', { level: 2 }), h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), task: e.isActive('taskList'), quote: e.isActive('blockquote'),
    }),
  });
  const chain = () => editor.chain().focus();
  const divider = <span aria-hidden className="mx-1 hidden h-4 w-px md:block" style={{ background: 'var(--outline-variant)' }} />;
  return (
    <div
      data-testid="document-toolbar"
      role="toolbar"
      aria-label="Formatting"
      className="sticky top-0 z-10 mb-3 flex min-w-0 flex-wrap items-center gap-0.5 rounded-lg p-1"
      style={{ background: 'var(--surface-container)', border: '1px solid var(--outline-variant)' }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-9 items-center gap-1.5 rounded-md px-2 text-[13px] md:hidden"
        style={{ color: 'var(--on-surface-variant)' }}
      >
        <Type size={15} /> Format
      </button>
      <div className={`${open ? 'flex' : 'hidden'} w-full min-w-0 flex-wrap items-center gap-0.5 md:flex md:w-auto`}>
        <ToolButton label="Bold" active={active.bold} onClick={() => chain().toggleBold().run()}><Bold size={15} /></ToolButton>
        <ToolButton label="Italic" active={active.italic} onClick={() => chain().toggleItalic().run()}><Italic size={15} /></ToolButton>
        <ToolButton label="Underline" active={active.underline} onClick={() => chain().toggleUnderline().run()}><UnderlineIcon size={15} /></ToolButton>
        <ToolButton label="Strikethrough" active={active.strike} onClick={() => chain().toggleStrike().run()}><Strikethrough size={15} /></ToolButton>
        <ToolButton label="Code" active={active.code} onClick={() => chain().toggleCode().run()}><Code size={15} /></ToolButton>
        <ToolButton label="Highlight" active={active.highlight} onClick={() => chain().toggleHighlight().run()}><Highlighter size={15} /></ToolButton>
        {divider}
        <ToolButton label="Heading" active={active.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()}><Heading2 size={15} /></ToolButton>
        <ToolButton label="Subheading" active={active.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()}><Heading3 size={15} /></ToolButton>
        <ToolButton label="Bullet list" active={active.bullet} onClick={() => chain().toggleBulletList().run()}><List size={15} /></ToolButton>
        <ToolButton label="Numbered list" active={active.ordered} onClick={() => chain().toggleOrderedList().run()}><ListOrdered size={15} /></ToolButton>
        <ToolButton label="Checkbox list" active={active.task} onClick={() => chain().toggleTaskList().run()}><CheckSquare size={15} /></ToolButton>
        <ToolButton label="Quote" active={active.quote} onClick={() => chain().toggleBlockquote().run()}><Quote size={15} /></ToolButton>
        {divider}
        <ToolButton label="Divider" active={false} onClick={() => chain().setHorizontalRule().run()}><Minus size={15} /></ToolButton>
        <ToolButton label="Table" active={false} onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><TableIcon size={15} /></ToolButton>
        <ToolButton label="Image" active={false} onClick={() => { editor.commands.pickDocumentImage(); }}><ImagePlus size={15} /></ToolButton>
      </div>
    </div>
  );
}

/** What a refused upload says: the server's message, else a plain one. */
async function uploadRefusal(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  if (res.status === 403) return 'You need edit access to add images to this document.';
  return typeof body?.error === 'string' && body.error.trim() ? body.error : `The image could not be uploaded (${res.status}).`;
}

/**
 * The live editor. `editable` follows the caller's role, the server's scope
 * for this connection and the connection's state; the toolbar and every
 * upload path work only while it is editable. Carets name people through
 * `names` (the viewer's members list), else "A collaborator".
 */
export function DocumentEditor({ documentId, provider, ydoc, user, names, editable, onNotice }: {
  documentId: string;
  provider: HocuspocusProvider;
  ydoc: Y.Doc;
  user: DocumentUser;
  /** People the viewer may see, by id. */
  names: ReadonlyMap<string, string>;
  editable: boolean;
  /** Says something to the person (an upload refused). */
  onNotice: (text: string) => void;
}) {
  const namesRef = useRef(names);
  const noticeRef = useRef(onNotice);
  useEffect(() => {
    namesRef.current = names;
    noticeRef.current = onNotice;
  });
  const nameFor = useCallback((id: unknown) => collaboratorName(namesRef.current, id), []);
  const upload = useCallback<ImageUpload>(async (file) => {
    try {
      const res = await api.upload(`/api/upload?document_id=${encodeURIComponent(documentId)}`, file);
      if (!res.ok) {
        noticeRef.current(await uploadRefusal(res));
        return null;
      }
      const body = await res.json() as { id?: unknown; name?: unknown };
      if (typeof body.id !== 'string') return null;
      return { id: body.id, name: typeof body.name === 'string' ? body.name : file.name };
    } catch {
      noticeRef.current('The image could not be uploaded. Check your connection and try again.');
      return null;
    }
  }, [documentId]);
  const extensions = useMemo(() => createDocumentExtensions({ ydoc, provider, user, nameFor, upload }), [ydoc, provider, user, nameFor, upload]);
  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions,
    editorProps: { attributes: { class: BODY_CLASS, 'aria-label': 'Document body' } },
  }, [extensions]);
  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable, false);
  }, [editor, editable]);
  // Carets drawn before the names arrived (or after they changed) are drawn again, and once
  // more just after mounting, when the Yjs binding has rendered the document.
  useEffect(() => {
    refreshCarets(editor);
    const again = setTimeout(() => refreshCarets(editor), 100);
    return () => clearTimeout(again);
  }, [editor, names]);
  return (
    <div className="min-w-0">
      {editor && editable && <DocumentToolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}

/** The document as stored (content_json), read-only, with no toolbar. */
export function DocumentReadOnly({ content }: { content: JSONContent | null | undefined }) {
  const extensions = useMemo(() => createDocumentReadOnlyExtensions(), []);
  const editor = useEditor({
    immediatelyRender: false,
    editable: false,
    extensions,
    editorProps: { attributes: { class: BODY_CLASS, 'aria-label': 'Document body', 'aria-readonly': 'true' } },
  }, [extensions]);
  useEffect(() => {
    if (!editor || !content) return;
    try {
      editor.commands.setContent(content, { emitUpdate: false });
    } catch {
      editor.commands.clearContent(false);
    }
  }, [editor, content]);
  return <div className="min-w-0"><EditorContent editor={editor} /></div>;
}
