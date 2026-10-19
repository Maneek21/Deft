export type ChatMarkdownBlock = { kind: 'text' | 'code'; text: string };

/** Separate fenced code from prose without inserting user-visible sentinel text. */
export function splitChatMarkdownBlocks(text: string): ChatMarkdownBlock[] {
  const blocks: ChatMarkdownBlock[] = [];
  const fences = /```(\w*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of text.matchAll(fences)) {
    if (match.index > cursor) blocks.push({ kind: 'text', text: text.slice(cursor, match.index) });
    blocks.push({ kind: 'code', text: match[2]!.trim() });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) blocks.push({ kind: 'text', text: text.slice(cursor) });
  return blocks.flatMap(block => block.kind === 'code' ? [block] : block.text.split(/\n\n+/).map(text => ({ kind: 'text' as const, text })));
}

export function escapeChatCode(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
