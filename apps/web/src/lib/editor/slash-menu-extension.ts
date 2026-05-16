import { Extension } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import Suggestion, { type SuggestionProps, type SuggestionKeyDownProps } from '@tiptap/suggestion';
import { ReactRenderer } from '@tiptap/react';
import tippy, { type Instance as TippyInstance } from 'tippy.js';
import { SlashMenuPopup, type SlashMenuRef } from '@/components/editor/slash-menu-popup';
import {
  filterCommands,
  slashRegistry,
  type ChatCommandHandler,
  type EditorSurface,
  type SlashCommand,
  type SlashCommandContext,
} from './commands';

export type SlashMenuOptions = {
  surface: EditorSurface;
  /**
   * Host hook for chat-level action commands (mute, remind, task, etc.).
   * Items with `requireStartOfMessage: true` invoke this in their `run`.
   */
  onChatCommand?: ChatCommandHandler;
  /**
   * Fired when the popup opens / closes. The chat composer uses this to know
   * when to *not* swallow Enter in its own `editorProps.handleKeyDown` — so
   * the Suggestion plugin gets a chance to dispatch the selected command.
   */
  onMenuStateChange?: (open: boolean) => void;
};

/** True when the slash is at the very first character of the document. */
function isAtStartOfDoc(state: EditorState, slashFrom: number) {
  const before = state.doc.textBetween(0, slashFrom, '\n');
  return before.length === 0;
}

export const SlashMenu = Extension.create<SlashMenuOptions>({
  name: 'slashMenu',

  addOptions() {
    return { surface: 'note' };
  },

  addProseMirrorPlugins() {
    const surface = this.options.surface;
    const onChatCommand = this.options.onChatCommand;
    const onMenuStateChange = this.options.onMenuStateChange;

    return [
      Suggestion<SlashCommand, SlashCommand>({
        editor: this.editor,
        char: '/',
        startOfLine: false,
        // Allow trigger after start, space, or newline.
        allowedPrefixes: [' ', '\n'],
        items: ({ query, editor: ed }) => {
          const all = slashRegistry.all();
          // The Suggestion plugin doesn't pass `range` into `items`, so derive
          // start-of-message from the current selection — the slash is one
          // char back from selection.from while the user is typing the query.
          const selFrom = ed.state.selection.from;
          const slashFrom = Math.max(0, selFrom - 1 - query.length);
          const isStart = isAtStartOfDoc(ed.state, slashFrom);
          return filterCommands(all, query, surface, { isStartOfMessage: isStart }).slice(0, 12);
        },
        command: ({ editor, range, props }) => {
          const ctx: SlashCommandContext = {
            editor,
            range,
            surface,
            chatCommand: onChatCommand,
          };
          props.run(ctx);
        },
        render: () => {
          // ReactRenderer's second generic is the *component* props shape, not the
          // raw SuggestionProps from the plugin. We pick the subset the popup uses.
          type PopupProps = {
            items: SlashCommand[];
            command: (cmd: SlashCommand) => void;
          };
          let component: ReactRenderer<SlashMenuRef, PopupProps> | null = null;
          let popup: TippyInstance[] = [];

          return {
            onStart: (props: SuggestionProps<SlashCommand, SlashCommand>) => {
              onMenuStateChange?.(true);
              const renderer = new ReactRenderer<SlashMenuRef, PopupProps>(SlashMenuPopup, {
                props: { items: props.items, command: props.command },
                editor: props.editor,
              });
              component = renderer;
              if (!props.clientRect) return;
              popup = tippy('body', {
                getReferenceClientRect: props.clientRect as () => DOMRect,
                appendTo: () => document.body,
                content: renderer.element,
                showOnCreate: true,
                interactive: true,
                trigger: 'manual',
                placement: 'bottom-start',
                offset: [0, 6],
                animation: false,
                arrow: false,
              });
            },
            onUpdate: (props: SuggestionProps<SlashCommand, SlashCommand>) => {
              component?.updateProps({ items: props.items, command: props.command });
              if (!props.clientRect) return;
              popup[0]?.setProps({
                getReferenceClientRect: props.clientRect as () => DOMRect,
              });
            },
            onKeyDown: (props: SuggestionKeyDownProps) => {
              if (props.event.key === 'Escape') {
                popup[0]?.hide();
                return true;
              }
              return component?.ref?.onKeyDown(props.event) ?? false;
            },
            onExit: () => {
              onMenuStateChange?.(false);
              popup[0]?.destroy();
              component?.destroy();
            },
          };
        },
      }),
    ];
  },
});
