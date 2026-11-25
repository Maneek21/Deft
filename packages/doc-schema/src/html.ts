import type { JSONContent } from '@tiptap/core';
import { DOMParser, DOMSerializer } from '@tiptap/pm/model';
import {
  Window,
  type DocumentFragment as HappyDocumentFragment,
  type Element as HappyElement,
  type HTMLTemplateElement as HappyTemplateElement,
} from 'happy-dom';
import { plainJson } from './convert';
import { getDocumentSchema } from './extensions';

/** Elements removed (with everything inside them) before HTML is read, and counted. */
const UNSAFE_ELEMENTS = 'script, style, iframe, object, embed, form, input, link, meta';
/**
 * The one exception to counting an `input`: the checkbox TipTap writes in
 * every task item it renders. It is removed (the task item's
 * `data-checked` carries the state) but is not counted as dropped, or every
 * saved task list would read as unsafe content. A handler on it still counts.
 */
const TASK_ITEM_CHECKBOX = 'li[data-type="taskItem"] > label > input[type="checkbox"]';

/**
 * A happy-dom window for untrusted HTML, closed after `use`: it runs no
 * script, loads no script, stylesheet, image or frame, cannot navigate, and
 * refuses every request it would make anyway. These are happy-dom 21's
 * setting names; JavaScript evaluation and CSS, image and iframe loading are
 * off by default there, and are set off here so a default can't change it.
 */
function withWindow<T>(use: (window: Window) => T): T {
  const window = new Window({
    settings: {
      enableJavaScriptEvaluation: false,
      disableJavaScriptFileLoading: true,
      enableCSSFileLoading: false,
      enableImageFileLoading: false,
      enableIframePageLoading: false,
      disableComputedStyleRendering: true,
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
        disableFallbackToSetURL: true,
      },
      fetch: {
        interceptor: {
          beforeAsyncRequest: async ({ window: requester }) => new requester.Response(null, { status: 403 }),
          beforeSyncRequest: ({ request, window: requester }) => ({
            status: 403,
            statusText: 'Forbidden',
            ok: false,
            url: request.url,
            redirected: false,
            headers: new requester.Headers(),
            body: null,
          }),
        },
      },
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
 * Every element under `root`, including (at any depth) the ones inside a
 * `<template>`'s content fragment, which `querySelectorAll` does not reach.
 */
function allElements(root: HappyElement | HappyDocumentFragment): HappyElement[] {
  return Array.from(root.querySelectorAll('*')).flatMap(element => element.tagName === 'TEMPLATE'
    ? [element, ...allElements((element as HappyTemplateElement).content)]
    : [element]);
}

/**
 * Removes unsafe elements and `on*` attributes from `body`; returns how many
 * were removed. Everything is counted over the whole input (template
 * contents included) before anything is removed, so a handler inside a
 * removed element still counts.
 */
function stripUnsafe(body: HappyElement): number {
  const elements = allElements(body);
  let dropped = 0;
  for (const element of elements) {
    for (const name of element.getAttributeNames()) {
      if (!name.toLowerCase().startsWith('on')) continue;
      element.removeAttribute(name);
      dropped += 1;
    }
  }
  const unsafe = elements.filter(element => element.matches(UNSAFE_ELEMENTS));
  for (const element of unsafe) {
    if (!element.matches(TASK_ITEM_CHECKBOX)) dropped += 1;
  }
  for (const element of unsafe) element.remove();
  return dropped;
}

/**
 * Reads untrusted HTML (a note, a paste, an import, an HTML block in
 * Markdown) into a document. The HTML is parsed once, in the locked-down
 * window above; scripts, styles, frames, embeds, forms and inline event
 * handlers are dropped and counted in `dropped`; then ProseMirror's own
 * parser reads what is left against the document schema, leaving out
 * anything the schema has no place for.
 */
export function htmlToJson(html: string): { json: JSONContent; dropped: number } {
  return withWindow(window => {
    const page = new window.DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, 'text/html');
    const dropped = stripUnsafe(page.body);
    const doc = DOMParser.fromSchema(getDocumentSchema()).parse(page.body as unknown as globalThis.Node);
    return { json: plainJson(doc), dropped };
  });
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
