import type { Node as PmNode } from '@tiptap/pm/model';

export type MentionSelection =
  | { type: 'person'; id: string; name: string }
  | { type: 'group'; id: string; name: string; handle: string };

export type MentionGroup = { id: string; name: string; handle: string; member_count?: number };

/**
 * Text before the cursor for the @ and # popups. A hard break or a block
 * boundary reads as a newline, so a query never spans a line break.
 */
export function suggestionTextBefore(doc: PmNode, to: number, from = 0): string {
  return doc.textBetween(from, to, '\n', (leaf) => leaf.type.name === 'hardBreak' ? '\n' : '');
}

export function taskQueryAtCursor(text: string) {
  const match = text.match(/#(\w*)$/);
  return match ? { query: match[1]!, length: match[0].length } : null;
}

export function mentionQueryAtCursor(text: string) {
  const match = text.match(/(?:^|[\s(>])(@+([\w-]*))$/);
  return match ? { query: match[2], length: match[1].length } : null;
}

export function matchingMentionGroups(groups: MentionGroup[], query: string): MentionGroup[] {
  const value = query.toLowerCase();
  return groups.filter((group) => typeof group?.id === 'string' && !!group.id
    && typeof group.name === 'string' && typeof group.handle === 'string'
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(group.handle)
    && (group.handle.includes(value) || group.name.toLowerCase().includes(value)));
}

export function mentionSelectionContent(selected: MentionSelection) {
  if (selected.type === 'group') return [{ type: 'text', text: `@${selected.handle} ` }];
  return [
    { type: 'mention', attrs: { uuid: selected.id, name: selected.name } },
    { type: 'text', text: ' ' },
  ];
}
