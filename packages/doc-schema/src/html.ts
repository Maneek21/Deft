import type { JSONContent } from '@tiptap/core';
import { generateJSON } from '@tiptap/html/server';
import { DOMSerializer } from '@tiptap/pm/model';
import { Window } from 'happy-dom';
import { documentSchemaExtensions, getDocumentSchema } from './extensions';

/** Elements removed (with everything inside them) before HTML is read, and counted. */
const UNSAFE_ELEMENTS = 'script, style, iframe, object, embed, form, input, link, meta';
/**
 * The one exception to counting an `input`: the checkbox TipTap writes in
 * every task item it renders. It is removed (the task item's
 * `data-checked` carries the state) but is not counted as dropped, or every
 * saved task list would read as unsafe content. A handler on it still counts.
 */
const TASK_ITEM_CHECKBOX = 'li[data-type="taskItem"] > label > input[type="checkbox"]';

/** A happy-dom window that runs no script and loads nothing, closed after `use`. Same settings as `@tiptap/html/server`. */
function withWindow<T>(use: (window: Window) => T): T {
  const window = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      disableComputedStyleRendering: true,
    },
  });
  try {
    return use(window);
  } finally {
    // Nothing was loaded, so there is nothing to wait for; a failure here must not become an unhandled rejection.
    window.happyDOM.abort().catch(() => undefined);
    window.happyDOM.close().catch(() => undefined);
  }
}

/**
 * Removes unsafe elements and `on*` attributes; returns the HTML left and how
 * many were removed. Everything is counted over the whole input before
 * anything is removed, so a handler inside a removed element still counts.
 */
function stripUnsafe(html: string): { html: string; dropped: number } {
  return withWindow(window => {
    const body = new window.DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, 'text/html').body;
    let dropped = 0;
    for (const element of Array.from(body.querySelectorAll('*'))) {
      for (const name of element.getAttributeNames()) {
        if (!name.toLowerCase().startsWith('on')) continue;
        element.removeAttribute(name);
        dropped += 1;
      }
    }
    const unsafe = Array.from(body.querySelectorAll(UNSAFE_ELEMENTS));
    for (const element of unsafe) {
      if (!element.matches(TASK_ITEM_CHECKBOX)) dropped += 1;
    }
    for (const element of unsafe) element.remove();
    return { html: body.innerHTML, dropped };
  });
}

/**
 * Reads HTML (a note, a paste, an HTML block in Markdown) into a document.
 * Scripts, styles, frames, embeds, forms and inline event handlers are
 * dropped first and counted in `dropped`; anything else the schema has no
 * place for is left out by the parser.
 */
export function htmlToJson(html: string): { json: JSONContent; dropped: number } {
  const clean = stripUnsafe(html);
  // Through JSON so the result is plain objects, not ProseMirror's null-prototype attrs.
  const json = JSON.parse(JSON.stringify(generateJSON(clean.html, documentSchemaExtensions()))) as JSONContent;
  return { json, dropped: clean.dropped };
}

/** The HTML of a node: a whole node's outer HTML, or a `doc`'s content. Used for Markdown HTML blocks. */
export function jsonToHtml(json: JSONContent): string {
  const schema = getDocumentSchema();
  const node = schema.nodeFromJSON(json);
  return withWindow(window => {
    const document = window.document as unknown as Document;
    const serializer = DOMSerializer.fromSchema(schema);
    if (node.type === schema.topNodeType) {
      const wrap = document.createElement('div');
      serializer.serializeFragment(node.content, { document }, wrap);
      return wrap.innerHTML;
    }
    return (serializer.serializeNode(node, { document }) as HTMLElement).outerHTML;
  });
}
