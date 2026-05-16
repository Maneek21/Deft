import { Extension } from '@tiptap/core';
import Suggestion, { type SuggestionProps, type SuggestionKeyDownProps } from '@tiptap/suggestion';
import { ReactRenderer } from '@tiptap/react';
import tippy, { type Instance as TippyInstance } from 'tippy.js';
import { SlashMenuPopup, type SlashMenuRef } from '@/components/editor/slash-menu-popup';
import {
  filterCommands,
  slashRegistry,
  type EditorSurface,
  type SlashCommand,
  type SlashCommandContext,
} from './commands';

export type SlashMenuOptions = {
  surface: EditorSurface;
};

export const SlashMenu = Extension.create<SlashMenuOptions>({
  name: 'slashMenu',

  addOptions() {
    return { surface: 'note' };
  },

  addProseMirrorPlugins() {
    const surface = this.options.surface;

    return [
      Suggestion<SlashCommand, SlashCommand>({
        editor: this.editor,
        char: '/',
        startOfLine: false,
        // Allow trigger after start, space, or newline.
        allowedPrefixes: [' ', '\n'],
        // In the chat surface, suppress when the slash is at the very start
        // of the message — the legacy chat-level slash autocomplete (/remind,
        // /task, etc.) owns that case and we'd otherwise show two popups.
        allow: ({ state, range }) => {
          if (surface !== 'chat') return true;
          const before = state.doc.textBetween(0, range.from, '\n').trim();
          return before.length > 0;
        },
        items: ({ query }) => {
          const all = slashRegistry.all();
          return filterCommands(all, query, surface).slice(0, 12);
        },
        command: ({ editor, range, props }) => {
          // `props` is the selected SlashCommand
          const ctx: SlashCommandContext = {
            editor,
            range,
            surface,
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
              popup[0]?.destroy();
              component?.destroy();
            },
          };
        },
      }),
    ];
  },
});
