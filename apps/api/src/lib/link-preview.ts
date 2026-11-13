import { fetchPublicHttpText } from './public-http-fetch.js';

export type LinkPreview = {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  favicon: string | null;
  siteName: string | null;
};

const LINK_PREVIEW_MAX_BYTES = 512 * 1024;

type Tag = { tag: string; attrs: Record<string, string> };

const isSpace = (code: number) => code === 32 || (code >= 9 && code <= 13);

// Single-pass tokenizer for <meta> and <link> tags: quoted values may contain
// '<' or '>', every character is visited a bounded number of times, and
// parsing time stays linear in the (capped) document size.
function scanTags(html: string, lower: string): Tag[] {
  const tags: Tag[] = [];
  const len = html.length;
  let i = lower.indexOf('<');
  while (i !== -1) {
    const name = lower.startsWith('meta', i + 1) ? 'meta' : lower.startsWith('link', i + 1) ? 'link' : null;
    const after = i + 1 + (name?.length ?? 0);
    if (!name || !(after >= len || isSpace(html.charCodeAt(after)) || html[after] === '/' || html[after] === '>')) {
      i = lower.indexOf('<', i + 1);
      continue;
    }
    const attrs: Record<string, string> = {};
    let j = after;
    while (j < len && html[j] !== '>') {
      if (isSpace(html.charCodeAt(j)) || html[j] === '/') { j += 1; continue; }
      let k = j;
      while (k < len && !isSpace(html.charCodeAt(k)) && html[k] !== '/' && html[k] !== '>' && (html[k] !== '=' || k === j)) k += 1;
      const attrName = lower.slice(j, k);
      j = k;
      while (j < len && isSpace(html.charCodeAt(j))) j += 1;
      let value = '';
      if (html[j] === '=') {
        j += 1;
        while (j < len && isSpace(html.charCodeAt(j))) j += 1;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, j + 1);
          const stop = close === -1 ? len : close;
          value = html.slice(j + 1, stop);
          j = stop + 1;
        } else {
          k = j;
          while (k < len && !isSpace(html.charCodeAt(k)) && html[k] !== '>') k += 1;
          value = html.slice(j, k);
          j = k;
        }
      }
      if (attrName && !(attrName in attrs)) attrs[attrName] = value;
    }
    tags.push({ tag: name, attrs });
    i = j >= len ? -1 : lower.indexOf('<', j + 1);
  }
  return tags;
}

function titleText(html: string, lower: string): string | null {
  const open = lower.indexOf('<title');
  if (open === -1) return null;
  const start = html.indexOf('>', open);
  const end = start === -1 ? -1 : lower.indexOf('</title', start);
  return end === -1 ? null : html.slice(start + 1, end).trim() || null;
}

/** Parse preview metadata from an HTML document. */
export function extractLinkMetadata(html: string, url: string): LinkPreview | null {
  const lower = html.toLowerCase();
  const tags = scanTags(html, lower);
  const metaContent = (key: 'property' | 'name', value: string): string | null => {
    const found = tags.find((t) => t.tag === 'meta' && t.attrs[key]?.toLowerCase() === value && t.attrs.content);
    return found?.attrs.content || null;
  };
  const getOg = (property: string) => metaContent('property', `og:${property}`);

  const titleTag = titleText(html, lower);

  const iconTag = tags.find((t) => t.tag === 'link' && /^(?:shortcut )?icon$/i.test(t.attrs.rel ?? '') && t.attrs.href);
  let favicon = iconTag?.attrs.href || null;
  if (favicon && !favicon.startsWith('http')) {
    favicon = new URL(favicon, new URL(url).origin).href;
  }

  const title = getOg('title') || titleTag;
  const description = getOg('description') || metaContent('name', 'description');
  const image = getOg('image');
  const siteName = getOg('site_name');

  if (!title && !description) return null;
  return { url, title, description, image, favicon, siteName };
}

export async function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
  try {
    const res = await fetchPublicHttpText(url, {
      maxBytes: LINK_PREVIEW_MAX_BYTES,
      timeoutMs: 5000,
      accept: 'text/html',
      userAgent: 'DeftBot/1.0 (link preview)',
    });
    if (!res.contentType.includes('text/html')) return null;
    return extractLinkMetadata(res.text, url);
  } catch {
    return null;
  }
}

export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>)"'\]]+/g;
  return [...new Set(text.match(urlRegex) || [])];
}
