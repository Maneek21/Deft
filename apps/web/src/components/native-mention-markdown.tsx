'use client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { NativeMentionKindSchema, ResourceOpaqueIdSchema } from '@deft/shared';
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
        for (const match of child.value.matchAll(/\[\[deft:(person|task|wiki_page):([A-Za-z0-9][A-Za-z0-9._:-]{0,255})\]\]/g)) {
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
export function NativeMentionMarkdown({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, nativeReferences]} rehypePlugins={[[rehypeSanitize, defaultSchema]]}
    components={{ a: ({ href, children }) => {
      const match = href?.match(/^\/deft-reference\/(person|task|wiki_page)\/([^/]+)$/);
      const kind = NativeMentionKindSchema.safeParse(match?.[1]);
      const id = ResourceOpaqueIdSchema.safeParse(match?.[2]);
      return kind.success && id.success ? <NativeReferenceChip kind={kind.data} id={id.data} />
        : <a href={href}>{children}</a>;
    } }}>{content}</ReactMarkdown>;
}
