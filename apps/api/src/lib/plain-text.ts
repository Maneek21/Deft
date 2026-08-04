import { htmlToText } from '@deft/shared/rich-text';

/**
 * Convert TipTap/HTML-ish user text into a plain preview string.
 * Entity decoding is intentionally one-layer only: nested entity-shaped text
 * remains text instead of being reinterpreted as markup after tags are removed.
 */
export function toPlainText(value: string | null | undefined): string {
  if (!value) return '';
  return htmlToText(value)
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncatePlainText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
