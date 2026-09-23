import { decodeHtmlEntitiesOnce } from '@deft/shared/rich-text';

/** Link only supported schemes and local paths; never protocol-relative URLs. */
export function isSafeChatHref(href: string): boolean {
  return !/[\\\u0000-\u0020]/.test(href) && (/^\/(?!\/)/.test(href) || /^(https?:\/\/|mailto:)/i.test(href));
}

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function formatChatInline(text: string, resolveHref?: (href: string) => string | null): string {
  const protectedParts: string[] = [];
  const protect = (html: string) => { protectedParts.push(html); return `\u0000${protectedParts.length - 1}\u0000`; };
  const escaped = escapeHtml(text).replace(/`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g, (match, code, label, escapedHref) => {
    if (code !== undefined) return protect(`<code>${code}</code>`);
    const originalHref = decodeHtmlEntitiesOnce(escapedHref);
    const href = resolveHref ? resolveHref(originalHref) : originalHref;
    if (href === null) return protect(label);
    if (!isSafeChatHref(href)) return protect(match);
    return protect(`<a href="${escapeHtml(href)}"${href.startsWith('/') ? '' : ' target="_blank" rel="noopener noreferrer"'} class="underline" style="color:var(--accent)">${label}</a>`);
  });
  return escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\u0000(\d+)\u0000/g, (_match, index) => protectedParts[Number(index)]!);
}

/** Avoid rewriting identifiers inside an existing link, URL attribute or code. */
export function linkifyChatTaskReferences(html: string): string {
  return html.split(/(<a\b[^>]*>[\s\S]*?<\/a>|<pre\b[^>]*>[\s\S]*?<\/pre>|<code\b[^>]*>[\s\S]*?<\/code>|<[^>]+>)/gi)
    .map((part) => part.startsWith('<') ? part : part.replace(/\b([A-Z]{2,6})-(\d+)\b/g, '<a href="/tasks?task=$1-$2" style="color:var(--primary);font-family:var(--font-mono)">$1-$2</a>')).join('');
}
