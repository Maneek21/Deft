'use client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { NativeMentionKindSchema, ResourceOpaqueIdSchema } from '@deft/shared';
import { NativeReferenceChip } from './native-reference-chip';
type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };
function nativeReferences() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (['code', 'inlineCode', 'blockquote', 'link', 'html'].includes(node.type) || !node.children) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text' || !child.value) { walk(child); return [child]; }
        const result: MdNode[] = [];
        let offset = 0;
        for (const match of child.value.matchAll(/\[\[deft:(person|task|wiki_page):([^\]\s]+)\]\]/g)) {
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
