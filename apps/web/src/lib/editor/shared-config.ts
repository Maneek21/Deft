import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import type { Extensions } from '@tiptap/core';
import { SlashMenu } from './slash-menu-extension';
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
    SlashMenu.configure({
      surface: opts.surface,
      onChatCommand: opts.onChatCommand,
      onMenuStateChange: opts.onMenuStateChange,
    }),
  ];
}
