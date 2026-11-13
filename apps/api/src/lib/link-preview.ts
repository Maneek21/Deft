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

// Tag scanners stop at the next '<' or '>' and attribute values are bounded,
// so parsing work stays linear in the (capped) document size.
const TAG_PATTERN = /<(meta|link)\b([^<>]{0,4096})>/gi;
const ATTR_PATTERN = /([a-z:_-]{1,64})\s*=\s*(?:"([^"]{0,4096})"|'([^']{0,4096})')/gi;

function tagAttributes(html: string): Array<{ tag: string; attrs: Record<string, string> }> {
  const tags: Array<{ tag: string; attrs: Record<string, string> }> = [];
  for (const match of html.matchAll(TAG_PATTERN)) {
    const attrs: Record<string, string> = {};
    for (const attr of match[2]!.matchAll(ATTR_PATTERN)) {
      const name = attr[1]!.toLowerCase();
      if (!(name in attrs)) attrs[name] = attr[2] ?? attr[3] ?? '';
    }
    tags.push({ tag: match[1]!.toLowerCase(), attrs });
  }
  return tags;
}

/** Parse preview metadata from an HTML document. */
export function extractLinkMetadata(html: string, url: string): LinkPreview | null {
  const tags = tagAttributes(html);
  const metaContent = (key: 'property' | 'name', value: string): string | null => {
    const found = tags.find((t) => t.tag === 'meta' && t.attrs[key]?.toLowerCase() === value && t.attrs.content);
    return found?.attrs.content || null;
  };
  const getOg = (property: string) => metaContent('property', `og:${property}`);

  const titleTag = html.match(/<title[^<>]{0,1024}>([^<]{0,4096})<\/title>/i)?.[1] || null;

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
