export type AgentMentionIdentity = {
  userId: string;
  name: string;
  slug: string;
};

export type PlainAgentMentionResolution = {
  content: string;
  resolvedUserIds: string[];
  ambiguousAliases: string[];
};

/** A plain mention token: `@` plus a maximal run of these characters. */
const TOKEN = /^[a-z0-9_-]+$/;

/** The exact handles an agent answers to: its slug, and its display name
 * when the whole name is one token. */
function aliasesForAgent(agent: AgentMentionIdentity) {
  return Array.from(new Set(
    [agent.slug, agent.name].map((value) => value.trim().toLowerCase()).filter((value) => TOKEN.test(value)),
  ));
}

/** Ranges of explicit mentions that are never rewritten: canonical
 * `<@id|label>` markers, `[[deft:...]]` tokens, and whole (nested) spans that
 * carry a native ref kind or a `data-mention-uuid` attribute. */
function explicitMentionRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const stack: boolean[] = [];
  let depth = 0;
  let start = 0;
  for (const tag of content.matchAll(/<(\/?)span\b[^>]*>/gi)) {
    if (!tag[1]) {
      const explicit = /data-deft-ref-kind/i.test(tag[0]) || /\sdata-mention-uuid\s*=/i.test(tag[0]);
      stack.push(explicit);
      if (explicit && depth++ === 0) start = tag.index!;
    } else if (stack.pop() && --depth === 0) {
      ranges.push([start, tag.index! + tag[0].length]);
    }
  }
  if (depth > 0) ranges.push([start, content.length]);
  for (const marker of content.matchAll(/<@[^|>]+\|[^>]+>|\[\[deft:(?:person|task|wiki_page):[^\]]*\]\]/gi)) {
    ranges.push([marker.index!, marker.index! + marker[0].length]);
  }
  return ranges;
}

/**
 * Turn exact, unambiguous plain-text agent handles into the canonical mention
 * marker used by chat. A token resolves only when, case-insensitively, it
 * equals one agent's slug or one-token display name and no other participant
 * (another agent, or a `competingTokens` entry) owns the same token; anything
 * else stays plain text. Explicit mention markers and spans are left as-is.
 */
export function normalizePlainAgentMentions(
  content: string,
  agents: AgentMentionIdentity[],
  competingTokens: string[] = [],
): PlainAgentMentionResolution {
  const ownersByAlias = new Map<string, Set<string>>();
  const agentByUserId = new Map<string, AgentMentionIdentity>();
  const addOwner = (alias: string, owner: string) => {
    const owners = ownersByAlias.get(alias) ?? new Set<string>();
    owners.add(owner);
    ownersByAlias.set(alias, owners);
  };
  for (const agent of agents) {
    agentByUserId.set(agent.userId, agent);
    for (const alias of aliasesForAgent(agent)) addOwner(alias, agent.userId);
  }
  for (const token of competingTokens) {
    const alias = token.trim().toLowerCase();
    if (ownersByAlias.has(alias)) addOwner(alias, `competitor:${alias}`);
  }

  const protectedRanges = explicitMentionRanges(content);
  const resolvedUserIds = new Set<string>();
  const ambiguousAliases = new Set<string>();
  const normalized = content.replace(/(?<![a-z0-9_])@([a-z0-9_-]+)/gi, (match, token: string, offset: number) => {
    if (protectedRanges.some(([start, end]) => offset >= start && offset < end)) return match;
    const owners = ownersByAlias.get(token.toLowerCase());
    if (!owners) return match;
    if (owners.size !== 1) {
      ambiguousAliases.add(token.toLowerCase());
      return match;
    }
    const agent = agentByUserId.get(Array.from(owners)[0]!)!;
    resolvedUserIds.add(agent.userId);
    return `<@${agent.userId}|${agent.name}>`;
  });

  return {
    content: normalized,
    resolvedUserIds: Array.from(resolvedUserIds),
    ambiguousAliases: Array.from(ambiguousAliases),
  };
}
