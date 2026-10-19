'use client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { NativeMentionKindSchema, ResourceOpaqueIdSchema } from '@deft/shared';
import { isSafeChatHref } from '@/lib/chat-links';
import { NativeReferenceChip } from './native-reference-chip';
type MdNode = { type: string; value?: string; url?: string; children?: MdNode[]; position?: { start: { offset?: number }; end: { offset?: number } } };
function nativeReferences() {
  return (tree: MdNode, file: { value?: unknown }) => {
    const walk = (node: MdNode) => {
      if (['code', 'inlineCode', 'blockquote', 'link', 'html'].includes(node.type) || !node.children) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text' || !child.value) { walk(child); return [child]; }
        // Markdown escapes/entities can change literal text during parsing.
        // Do not reinterpret that changed text as a newly typed identity.
        const start = child.position?.start.offset, end = child.position?.end.offset;
        if (typeof file.value === 'string' && start !== undefined && end !== undefined
          && file.value.slice(start, end) !== child.value) return [child];
        const result: MdNode[] = [];
        let offset = 0;
        for (const match of child.value.matchAll(/@?\[\[deft:(person|task|wiki_page):([A-Za-z0-9][A-Za-z0-9._:-]{0,255})\]\]/g)) {
          if (!ResourceOpaqueIdSchema.safeParse(match[2]).success) continue;
          result.push({ type: 'text', value: child.value.slice(offset, match.index) },
            { type: 'link', url: '/deft-reference/' + match[1] + '/' + match[2],
              children: [{ type: 'text', value: '@Reference' }] });
          offset = match.index! + match[0].length;
        }
        result.push({ type: 'text', value: child.value.slice(offset) });
        return result;
      });
    };
    walk(tree);
  };
}
// Only exact line-break HTML is interpreted; all other HTML remains inert.
function messageFormatting(options: { chat: boolean; linkifyTasks: boolean }) {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (['code', 'inlineCode', 'link'].includes(node.type) || !node.children) return;
      node.children = node.children.flatMap(child => {
        if (child.type === 'html' && /^<br(?: ?\/)?>$/i.test(child.value ?? '')) return [{ type: 'break' }];
        if (options.chat && child.type === 'text' && child.value) {
          const parts: MdNode[] = []; let offset = 0;
          for (const match of child.value.matchAll(/<@[^|>]+\|([^>]+)>|@(here|all|channel)\b|\b([A-Z]{2,6}-\d+)\b/g)) {
            if (match[3] && !options.linkifyTasks) continue;
            parts.push({ type: 'text', value: child.value.slice(offset, match.index) });
            const label = match[1] ? '@' + match[1] : match[2] ? '@' + match[2] : match[3]!;
            const url = match[3] ? '/tasks?task=' + match[3]
              : '/deft-display/' + (match[1] ? 'mention/' : 'broadcast/') + encodeURIComponent(label);
            parts.push({ type: 'link', url, children: [{ type: 'text', value: label }] });
            offset = match.index! + match[0].length;
          }
          parts.push({ type: 'text', value: child.value.slice(offset) });
          return parts.flatMap(part => part.type !== 'text' ? [part] : (part.value ?? '').split('\n').flatMap((line, index) =>
            index ? [{ type: 'break' }, { type: 'text', value: line }] : [{ type: 'text', value: line }]));
        }
        walk(child); return [child];
      });
    }; walk(tree);
  };
}
export function NativeMentionMarkdown({ content, chat = false, linkifyTasks = false, resolveHref }: {
  content: string; chat?: boolean; linkifyTasks?: boolean; resolveHref?: (href: string) => string | null;
}) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, nativeReferences, [messageFormatting, { chat, linkifyTasks }]]}
    rehypePlugins={[[rehypeSanitize, defaultSchema]]}
    components={{
      table: ({ children }) => <div className="overflow-x-auto"><table>{children}</table></div>,
      a: ({ href, children }) => {
      if (chat && href?.startsWith('/deft-display/')) return <span
        className="rounded px-1 font-medium" style={{ background: 'var(--accent-muted)', color: 'var(--primary)' }}>{children}</span>;
      const match = href?.match(/^\/deft-reference\/(person|task|wiki_page)\/([^/]+)$/);
      const kind = NativeMentionKindSchema.safeParse(match?.[1]);
      const id = ResourceOpaqueIdSchema.safeParse(match?.[2]);
      if (kind.success && id.success) return <NativeReferenceChip kind={kind.data} id={id.data} />;
      const target = href && (resolveHref ? resolveHref(href) : href);
      const safe = target && (isSafeChatHref(target) || (!chat && !resolveHref && /^#[^\\\u0000-\u0020]*$/.test(target)));
      return safe ? <a href={target} target={chat && !target.startsWith('/') ? '_blank' : undefined}
        rel={chat && !target.startsWith('/') ? 'noopener noreferrer' : undefined}>{children}</a> : <>{children}</>;
    } }}>{content}</ReactMarkdown>;
}
