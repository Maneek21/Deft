import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'span', 'div', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'hr', 'sub', 'sup', 'mark',
];

const ALLOWED_ATTR = [
  'href', 'target', 'rel', 'class', 'style', 'src', 'alt', 'title',
  'data-mention-id', 'data-mention-name', 'data-type',
  'colspan', 'rowspan',
];

export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}
