// The document editor's extensions (plan Task F12). Kept apart from
// shared-config.ts, which chat, tasks, notes and canvas import, so none of
// them loads the collaboration packages, Yjs or the document image view: only
// the document page reaches this module, through next/dynamic
// (components/documents/document-lazy.tsx).
//
// - The schema is @deft/doc-schema's list (its StarterKit already has undo
//   off, as Collaboration brings its own), with the protected-image view.
// - Awareness carries the person's user id and caret colour, nothing else;
//   the server sets the id again and drops every other field
//   (apps/api/src/collab/awareness.ts). A caret's name is looked up by id
//   through the viewer's members list (the people rule), "A collaborator"
//   when it isn't there.
// - An editor uploads images (paste, drop, the toolbar and the /image
//   command) with POST /api/upload?document_id=<id> (F10), which needs edit;
//   the image goes in by file id. Nothing is offered while the editor is
//   read-only.

import { Extension, type AnyExtension, type Editor, type Extensions } from '@tiptap/core';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import Placeholder from '@tiptap/extension-placeholder';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { yCursorPluginKey } from '@tiptap/y-tiptap';
import { documentSchemaExtensions } from '@deft/doc-schema/extensions';
import { SlashMenu } from './slash-menu-extension';
import { DocumentImageWithView } from './blocks/document-image';

/** What this person publishes in awareness. */
export type DocumentUser = { id: string; color: string };

/** The name a viewer may see for a user id (lib/collab-people.ts). */
export type NameFor = (userId: unknown) => string;

/** Uploads one image into the document: its file id and name, or null when it was refused (the editor says why). */
export type ImageUpload = (file: File) => Promise<{ id: string; name: string } | null>;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    documentImageUpload: {
      /** Opens the file chooser and puts the chosen image at the selection. */
      pickDocumentImage: () => ReturnType;
    };
  }
}

const imageFiles = (files: FileList | null | undefined): File[] => Array.from(files ?? []).filter((file) => file.type.startsWith('image/'));

/**
 * Puts an uploaded image at `at` (a drop), else just after the selection as
 * it is when the upload ends: never over it, since the person may have
 * selected something else (another image) meanwhile.
 */
async function insertUploaded(editor: Editor, upload: ImageUpload, file: File, at: number | null): Promise<void> {
  const uploaded = await upload(file);
  if (!uploaded || editor.isDestroyed || !editor.isEditable) return;
  const node = { type: 'image', attrs: { fileId: uploaded.id, alt: uploaded.name || file.name, title: uploaded.name || file.name } };
  editor.chain().focus().insertContentAt(at ?? editor.state.selection.to, node).run();
}

/** Image upload by paste, drop and pickDocumentImage, only while the editor is editable. */
export const DocumentImageUpload = Extension.create<{ upload: ImageUpload | null }>({
  name: 'documentImageUpload',

  addOptions() {
    return { upload: null };
  },

  addCommands() {
    return {
      pickDocumentImage: () => ({ editor }) => {
        const upload = this.options.upload;
        if (!upload || !editor.isEditable || typeof document === 'undefined') return false;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = () => {
          const [file] = imageFiles(input.files);
          if (file) void insertUploaded(editor, upload, file, null);
        };
        input.click();
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const upload = this.options.upload;
    if (!upload) return [];
    return [new Plugin({
      key: new PluginKey('documentImageUpload'),
      props: {
        handlePaste: (view, event) => {
          if (!view.editable) return false;
          const files = imageFiles(event.clipboardData?.files);
          if (files.length === 0) return false;
          event.preventDefault();
          for (const file of files) void insertUploaded(editor, upload, file, null);
          return true;
        },
        handleDrop: (view, event) => {
          if (!view.editable) return false;
          const files = imageFiles(event.dataTransfer?.files);
          if (files.length === 0) return false;
          event.preventDefault();
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
          for (const file of files) void insertUploaded(editor, upload, file, at);
          return true;
        },
      },
    })];
  },
});

/**
 * The document schema with the editor's own views: images through the
 * protected-image view. A live editor's block ids leave remote changes alone
 * (TipTap's advice for Collaboration); a read-only copy never writes ids.
 */
function documentViewExtensions(mode: 'live' | 'read-only'): Extensions {
  return documentSchemaExtensions().map((extension): AnyExtension => {
    if (extension.name === 'image') return DocumentImageWithView;
    if (extension.name === 'uniqueID') {
      return mode === 'live'
        ? extension.configure({ filterTransaction: (tr: Transaction) => !isChangeOrigin(tr) })
        : extension.configure({ updateDocument: false });
    }
    return extension;
  });
}

/** A caret drawn with inline styles (Tailwind only, no stylesheet); the name is looked up by id and set as text. */
function caretRenderer(nameFor: NameFor) {
  return (user: Record<string, unknown>): HTMLElement => {
    const color = typeof user.color === 'string' ? user.color : 'transparent';
    const caret = document.createElement('span');
    caret.setAttribute('data-document-caret', '');
    caret.style.cssText = `position:relative;margin:0 -1px;border-left:2px solid ${color};word-break:normal;pointer-events:none;`;
    const label = document.createElement('span');
    label.style.cssText = `position:absolute;top:-1.35em;left:-1px;padding:0 4px;border-radius:3px 3px 3px 0;background:${color};color:#fff;font-size:11px;font-weight:600;line-height:1.35;white-space:nowrap;user-select:none;`;
    label.textContent = nameFor(user.id);
    caret.append(label);
    return caret;
  };
}

/** Redraws other people's carets, after the names the viewer may see have loaded or changed. */
export function refreshCarets(editor: Editor | null): void {
  if (!editor || editor.isDestroyed) return;
  try {
    editor.view.dispatch(editor.state.tr.setMeta(yCursorPluginKey, { awarenessUpdated: true }));
  } catch {
    // Not mounted yet: its first render draws the carets with the names as they are then.
  }
}

/**
 * The live document editor: the document schema, the Yjs document as the
 * content (Collaboration, the fragment the API stores), other people's carets
 * from the provider's awareness (CollaborationCaret, publishing `user` as id
 * and colour only), a placeholder, the slash menu for the 'document' surface,
 * and image upload.
 */
export function createDocumentExtensions(i: {
  ydoc: Y.Doc; provider: HocuspocusProvider; user: DocumentUser; nameFor: NameFor; upload: ImageUpload | null;
}): Extensions {
  return [
    ...documentViewExtensions('live'),
    Placeholder.configure({ placeholder: 'Type / for commands…' }),
    // The fragment the API stores and reads (@deft/doc-schema's DOCUMENT_FRAGMENT).
    Collaboration.configure({ document: i.ydoc, field: 'default' }),
    CollaborationCaret.configure({ provider: i.provider, user: { id: i.user.id, color: i.user.color }, render: caretRenderer(i.nameFor) }),
    SlashMenu.configure({ surface: 'document' }),
    DocumentImageUpload.configure({ upload: i.upload }),
  ];
}

/** A document shown from its stored JSON (content_json): the same schema and views, nothing that edits. */
export function createDocumentReadOnlyExtensions(): Extensions {
  return documentViewExtensions('read-only');
}
