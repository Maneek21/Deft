export type HtmlToTextOptions = {
  /**
   * Separator emitted for <br>, <hr>, and closing block tags.
   * Plain previews normally use a space; line-oriented views use "\n".
   */
  blockSeparator?: string;
  /**
   * Separator emitted for inline tags.
   * Inline formatting must not split words, so the default is "".
   */
  inlineSeparator?: string;
};

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

const OMIT_CONTENT_TAGS = new Set(['noscript', 'script', 'style', 'template']);

const NAMED_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

const ENTITY_PATTERN = /&(?:nbsp|amp|lt|gt|quot|apos|#39|#[0-9]+|#x[0-9a-fA-F]+);/g;

type ParsedTag = {
  end: number;
  name: string | null;
  closing: boolean;
  selfClosing: boolean;
};

/**
 * Decode exactly one HTML-entity layer.
 *
 * String#replace scans the original input once, so a replacement such as
 * "&amp;lt;" becomes "&lt;" and is not decoded again into "<".
 */
export function decodeHtmlEntitiesOnce(value: string): string {
  return value.replace(ENTITY_PATTERN, (entity) => {
    const named = NAMED_ENTITIES[entity];
    if (named !== undefined) return named;

    const isHex = entity.startsWith('&#x');
    const digits = entity.slice(isHex ? 3 : 2, -1);
    const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
    if (
      !Number.isInteger(codePoint) ||
      codePoint < 0 ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return entity;
    }
    return String.fromCodePoint(codePoint);
  });
}

function parseTag(value: string, start: number): ParsedTag | null {
  if (value[start] !== '<' || start + 1 >= value.length) return null;

  if (value.startsWith('<!--', start)) {
    const commentEnd = value.indexOf('-->', start + 4);
    return {
      end: commentEnd === -1 ? value.length : commentEnd + 3,
      name: null,
      closing: false,
      selfClosing: false,
    };
  }

  const first = value[start + 1]!;
  const second = value[start + 2] ?? '';
  const looksLikeTag =
    /[A-Za-z!?]/.test(first) ||
    (first === '/' && /[A-Za-z]/.test(second));
  if (!looksLikeTag) return null;

  let quote: '"' | "'" | null = null;
  let end = start + 1;
  for (; end < value.length; end += 1) {
    const char = value[end]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') break;
  }
  if (end >= value.length) return null;

  const raw = value.slice(start + 1, end).trim();
  const closing = raw.startsWith('/');
  const withoutSlash = closing ? raw.slice(1).trimStart() : raw;
  const nameMatch = /^([A-Za-z][A-Za-z0-9:-]*)/.exec(withoutSlash);
  return {
    end: end + 1,
    name: nameMatch?.[1]?.toLowerCase() ?? null,
    closing,
    selfClosing: /\/\s*$/.test(raw),
  };
}

function parseDeftMention(
  value: string,
  start: number,
): { end: number; label: string } | null {
  if (!value.startsWith('<@', start)) return null;

  const end = value.indexOf('>', start + 2);
  if (end === -1) return null;

  const separator = value.indexOf('|', start + 2);
  if (separator === -1 || separator >= end) return null;

  const id = value.slice(start + 2, separator);
  const label = value.slice(separator + 1, end);
  if (!id || !label) return null;

  return { end: end + 1, label };
}

function findClosingTag(
  value: string,
  tagName: string,
  start: number,
): ParsedTag | null {
  let searchFrom = start;

  while (searchFrom < value.length) {
    const closeStart = value.indexOf('<', searchFrom);
    if (closeStart === -1) return null;

    const closeTag = parseTag(value, closeStart);
    if (closeTag?.closing && closeTag.name === tagName) {
      return closeTag;
    }

    // A tag such as </scripture> is text inside a script body, not the closing
    // tag. Scan original-string offsets so Unicode case folding cannot move
    // indices relative to the source value.
    searchFrom = closeStart + 1;
  }

  return null;
}

/**
 * Convert HTML-ish rich text to text without using a tag-deletion regex.
 *
 * The scanner respects quoted ">" characters in attributes, removes comments,
 * and omits script/style/template/noscript bodies. Entity decoding happens once
 * after structural extraction.
 */
export function htmlToText(value: string, options: HtmlToTextOptions = {}): string {
  const blockSeparator = options.blockSeparator ?? ' ';
  const inlineSeparator = options.inlineSeparator ?? '';
  const output: string[] = [];

  const appendSeparator = (separator: string) => {
    if (!separator || output.length === 0) return;
    if (output[output.length - 1]!.endsWith(separator)) return;
    output.push(separator);
  };

  let index = 0;
  while (index < value.length) {
    if (value[index] !== '<') {
      output.push(value[index]!);
      index += 1;
      continue;
    }

    const mention = parseDeftMention(value, index);
    if (mention) {
      output.push(`@${mention.label}`);
      index = mention.end;
      continue;
    }

    const tag = parseTag(value, index);
    if (!tag) {
      output.push('<');
      index += 1;
      continue;
    }

    const tagName = tag.name;
    if (tagName && !tag.closing && OMIT_CONTENT_TAGS.has(tagName)) {
      const closeTag = findClosingTag(value, tagName, tag.end);
      if (!closeTag) {
        index = value.length;
      } else {
        index = closeTag.end;
      }
      appendSeparator(blockSeparator);
      continue;
    }

    const isBlockTag = Boolean(tagName && BLOCK_TAGS.has(tagName));
    const isBlockBoundary =
      tagName === 'br' ||
      tagName === 'hr' ||
      isBlockTag;
    appendSeparator(isBlockBoundary ? blockSeparator : inlineSeparator);
    index = tag.end;
  }

  return decodeHtmlEntitiesOnce(output.join(''));
}
