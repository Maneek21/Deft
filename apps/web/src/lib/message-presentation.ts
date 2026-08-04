export type QuotedMessage = {
  userName: string;
  content: string;
};

function escapeHtmlText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return character;
    }
  });
}

/**
 * Only server-authored metadata may opt a chat row into system presentation.
 * User IDs, display names, glyphs, and message content are all user-controlled.
 */
export function isTrustedSystemMessage(metadata: unknown): boolean {
  return Boolean(
    metadata
    && typeof metadata === 'object'
    && !Array.isArray(metadata)
    && (metadata as Record<string, unknown>).kind === 'system_note',
  );
}

/**
 * Serialize a quote from a fixed structure. Every user-controlled text node is
 * escaped before it is placed in markup.
 */
export function serializeQuotedMessage(quote: QuotedMessage): string {
  return [
    '<blockquote style="border-left:3px solid var(--primary-container);padding-left:12px;margin:0 0 8px 0;color:var(--on-surface-variant)">',
    '<strong>',
    escapeHtmlText(quote.userName),
    '</strong><br/>',
    escapeHtmlText(quote.content),
    '</blockquote>',
  ].join('');
}
