import { Node, mergeAttributes } from '@tiptap/core';

function parseConfig(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const config: unknown = JSON.parse(value);
    return config && typeof config === 'object' && !Array.isArray(config) ? config as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * A live view of tasks inside a document. `config` is the view's JSON
 * settings (null means the defaults); the web app draws the view.
 */
export const TaskView = Node.create({
  name: 'taskView',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      config: {
        default: null,
        parseHTML: el => parseConfig(el.getAttribute('data-config')),
        renderHTML: attrs => attrs.config ? { 'data-config': JSON.stringify(attrs.config) } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-task-view]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-task-view': '' })];
  },
});
