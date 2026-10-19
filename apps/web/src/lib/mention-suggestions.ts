export type MentionSelection =
  | { type: 'person'; id: string; name: string }
  | { type: 'group'; id: string; name: string; handle: string };

export type MentionGroup = { id: string; name: string; handle: string; member_count?: number };

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
