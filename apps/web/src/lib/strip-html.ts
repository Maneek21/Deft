import {
  decodeHtmlEntitiesOnce,
  htmlToText,
  type HtmlToTextOptions,
} from '@deft/shared/rich-text';

export { decodeHtmlEntitiesOnce, htmlToText, type HtmlToTextOptions };

/**
 * Strip HTML tags + decode common entities from a string.
 * Used for plain-text previews of TipTap-rendered content.
 */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return htmlToText(html)
    .replace(/\s+/g, ' ')
    .trim();
}
