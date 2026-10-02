'use client';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, ReactRenderer, type NodeViewProps } from '@tiptap/react';
import Suggestion, { exitSuggestion, type SuggestionProps } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import tippy, { type Instance } from 'tippy.js';
import { NativeMentionKindSchema, ResourceOpaqueIdSchema, nativeMentionPlaceholder, nativeMentionRef, nativeMentionToken } from '@deft/shared';
import { nativeMentionsAvailable, searchNativeReferences, type NativeProjection } from '@/lib/native-mentions';
import { NativeReferenceChip } from '@/components/native-reference-chip';
import { NativeMentionPopup, type NativeMentionPopupRef, type NativeMentionPopupProps } from '@/components/editor/native-mention-popup';
import type { EditorSurface } from './commands';

function View({ node }: NodeViewProps) {
  return <NodeViewWrapper as="span" contentEditable={false}>
    <NativeReferenceChip kind={node.attrs.kind} id={node.attrs.id} />
  </NodeViewWrapper>;
}
export const NativeMention = Node.create<{ onMenuStateChange?: (open: boolean) => void; surface?: EditorSurface }>({
  name: 'nativeMention', group: 'inline', inline: true, atom: true, selectable: false,
  addOptions: () => ({}),
  addAttributes: () => ({
    kind: { default: 'person', parseHTML: el => el.getAttribute('data-deft-ref-kind'), rendered: false },
    id: { default: '', parseHTML: el => el.getAttribute('data-deft-ref-id'), rendered: false },
  }),
  parseHTML: () => [{ tag: 'span[data-deft-ref-kind][data-deft-ref-id]', getAttrs: el =>
    NativeMentionKindSchema.safeParse(el.getAttribute('data-deft-ref-kind')).success
      && ResourceOpaqueIdSchema.safeParse(el.getAttribute('data-deft-ref-id')).success ? null : false }],
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-deft-ref-kind': node.attrs.kind,
      'data-deft-ref-id': node.attrs.id }), nativeMentionPlaceholder(node.attrs.kind)];
  },
  renderText: ({ node }) => nativeMentionToken(nativeMentionRef(node.attrs.kind, node.attrs.id)),
  addNodeView: () => ReactNodeViewRenderer(View),
  addProseMirrorPlugins() {
    nativeMentionsAvailable(); // Warm the session-scoped capability before the first @ keystroke.
    const onMenuStateChange = this.options.onMenuStateChange;
    const pluginKey = new PluginKey('nativeMentionSuggestion');
    let searchError: string | undefined;
    return [Suggestion<NativeProjection, NativeProjection>({
      editor: this.editor, pluginKey, char: '@',
      allowedPrefixes: [' ', '\n'], allowSpaces: false,
      allow: ({ state }) => nativeMentionsAvailable() && this.editor.isEditable
        && !this.editor.isActive('code') && !this.editor.isActive('codeBlock')
        && !this.editor.isActive('blockquote') && state.selection.empty,
      items: async ({ query }) => {
        searchError = undefined;
        try {
          const items = await searchNativeReferences(query);
          if (this.options.surface === 'chat') for (const broadcast of ['here', 'all'] as const) {
            if (broadcast.includes(query.toLowerCase())) items.push({ ref: nativeMentionRef('person', broadcast), state: 'available',
              label: '@' + broadcast, group: 'Channel', broadcast });
          }
          return items;
        } catch (error) { searchError = error instanceof Error ? error.message : 'Could not load references'; return []; }
      },
      command: ({ editor, range, props }) => {
        if (props.broadcast) { editor.chain().focus().insertContentAt(range, '@' + props.broadcast + ' ').run(); return; }
        editor.chain().focus().insertContentAt(range, [
          { type: 'nativeMention', attrs: { kind: props.ref.resource_type, id: props.ref.resource_id } }, { type: 'text', text: ' ' },
        ]).run();
      },
      render: () => {
        let renderer: ReactRenderer<NativeMentionPopupRef, NativeMentionPopupProps> | null = null;
        let popup: Instance[] = [];
        const update = (props: SuggestionProps<NativeProjection, NativeProjection>, loading: boolean) => {
          renderer?.updateProps({ items: props.items, command: props.command, loading, error: loading ? undefined : searchError });
          if (props.clientRect) popup[0]?.setProps({ getReferenceClientRect: props.clientRect as () => DOMRect });
        };
        return {
          onBeforeStart: () => onMenuStateChange?.(true),
          onStart: props => {
            onMenuStateChange?.(true);
            renderer = new ReactRenderer(NativeMentionPopup, { editor: props.editor,
              props: { items: props.items, command: props.command, loading: false, error: searchError } });
            if (props.clientRect) popup = tippy('body', { getReferenceClientRect: props.clientRect as () => DOMRect,
              appendTo: () => document.body, content: renderer.element, interactive: true,
              showOnCreate: true, trigger: 'manual', placement: 'bottom-start', animation: false, arrow: false,
              popperOptions: { strategy: 'fixed' } });
          },
          onBeforeUpdate: props => update(props, true),
          onUpdate: props => update(props, false),
          onKeyDown: ({ event }) => {
            if (event.key === 'Escape') { exitSuggestion(this.editor.view, pluginKey); return true; }
            return renderer?.ref?.onKeyDown(event) ?? event.key === 'Enter';
          },
          onExit: () => { onMenuStateChange?.(false); popup[0]?.destroy(); renderer?.destroy(); },
        };
      },
    })];
  },
});
