import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import type { AnyExtension, Extensions } from '@tiptap/core';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { documentSchemaExtensions } from '@deft/doc-schema/extensions';
import { SlashMenu } from './slash-menu-extension';
import { NativeMention } from './native-mention-extension';
import { DocumentImageWithView } from './blocks/document-image';
import type { ChatCommandHandler, EditorSurface } from './commands';

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type EditorConfigOptions = {
  surface: EditorSurface;
  placeholder?: string;
  /** Override heading levels — default [1, 2, 3] */
  headingLevels?: HeadingLevel[];
  /** Disable specific StarterKit features. */
  disable?: Array<'link' | 'underline' | 'codeBlock' | 'heading'>;
  /** Chat-surface side-effect dispatcher (mute, remind, task, etc.). */
  onChatCommand?: ChatCommandHandler;
  /** Notified when the slash menu opens / closes (for host Enter-key gating). */
  onMenuStateChange?: (open: boolean) => void;
};

/**
 * Build the base extension list shared by all Deft editor surfaces.
 *
 * Callers pass surface-specific extras (Mention, Image, etc.) by concatenating
 * to the result.
 */
export function createBaseExtensions(opts: EditorConfigOptions): Extensions {
  const disable = new Set(opts.disable ?? []);
  const headingLevels: HeadingLevel[] = opts.headingLevels ?? [1, 2, 3];

  return [
    StarterKit.configure({
      heading: disable.has('heading') ? false : { levels: headingLevels },
      codeBlock: disable.has('codeBlock')
        ? false
        : { HTMLAttributes: { class: 'deft-code-block' } },
      code: { HTMLAttributes: { class: 'deft-inline-code' } },
      ...(disable.has('link') ? { link: false as const } : {}),
      ...(disable.has('underline') ? { underline: false as const } : {}),
    }),
    Placeholder.configure({ placeholder: opts.placeholder ?? 'Type / for commands…' }),
    ...(['chat', 'task', 'task-comment'].includes(opts.surface)
      ? [NativeMention.configure({ onMenuStateChange: opts.onMenuStateChange, surface: opts.surface })] : []),
    SlashMenu.configure({
      surface: opts.surface,
      onChatCommand: opts.onChatCommand,
      onMenuStateChange: opts.onMenuStateChange,
    }),
  ];
}

/** Someone's caret and name in a shared document: what goes into awareness, and nothing else. */
export type DocumentUser = { name: string; color: string };

/**
 * The document schema (@deft/doc-schema: StarterKit with undo off, tables,
 * task lists, callouts, toggles, images, block ids …) with the editor's own
 * views: images draw through the protected-image view. A live editor's block
 * ids leave remote changes alone (TipTap's advice for Collaboration); a
 * read-only copy never writes ids into what it shows.
 */
function documentViewExtensions(mode: 'live' | 'read-only'): Extensions {
  return documentSchemaExtensions().map((extension): AnyExtension => {
    if (extension.name === 'image') return DocumentImageWithView;
    if (extension.name === 'uniqueID') {
      return mode === 'live'
        ? extension.configure({ filterTransaction: (tr: Parameters<typeof isChangeOrigin>[0]) => !isChangeOrigin(tr) })
        : extension.configure({ updateDocument: false });
    }
    return extension;
  });
}

/** A caret drawn with inline styles (Tailwind only, no stylesheet); the name is text, never HTML. */
function renderCaret(user: Record<string, unknown>): HTMLElement {
  const color = typeof user.color === 'string' ? user.color : 'transparent';
  const caret = document.createElement('span');
  caret.setAttribute('data-document-caret', '');
  caret.style.cssText = `position:relative;margin:0 -1px;border-left:2px solid ${color};word-break:normal;pointer-events:none;`;
  const label = document.createElement('span');
  label.style.cssText = `position:absolute;top:-1.35em;left:-1px;padding:0 4px;border-radius:3px 3px 3px 0;background:${color};color:#fff;font-size:11px;font-weight:600;line-height:1.35;white-space:nowrap;user-select:none;`;
  label.textContent = typeof user.name === 'string' ? user.name : '';
  caret.append(label);
  return caret;
}

/**
 * The live document editor (plan Task F12): the document schema, the
 * Yjs document as the content (Collaboration; the schema's StarterKit already
 * has undo/redo off, as Collaboration brings its own), other people's carets
 * from the provider's awareness (CollaborationCaret, which publishes `user`:
 * name and colour only), a placeholder and the slash menu for the 'document'
 * surface.
 */
export function createDocumentExtensions(i: { ydoc: Y.Doc; provider: HocuspocusProvider; user: DocumentUser }): Extensions {
  return [
    ...documentViewExtensions('live'),
    Placeholder.configure({ placeholder: 'Type / for commands…' }),
    // The fragment the API stores and reads (@deft/doc-schema's DOCUMENT_FRAGMENT).
    Collaboration.configure({ document: i.ydoc, field: 'default' }),
    CollaborationCaret.configure({ provider: i.provider, user: { name: i.user.name, color: i.user.color }, render: renderCaret }),
    SlashMenu.configure({ surface: 'document' }),
  ];
}

/** A document shown from its stored JSON (content_json): the same schema and views, nothing that edits. */
export function createDocumentReadOnlyExtensions(): Extensions {
  return documentViewExtensions('read-only');
}
