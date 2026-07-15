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

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasesForAgent(agent: AgentMentionIdentity) {
  const fullName = agent.name.trim().toLowerCase();
  const firstName = fullName.split(/\s+/)[0] ?? '';
  return Array.from(new Set([
    fullName,
    firstName,
    agent.slug.trim().toLowerCase(),
  ].filter(Boolean)));
}

/**
 * Turn exact, unambiguous plain-text agent handles into the canonical mention
 * marker used by chat. This keeps pasted/typed `@Rita` messages on the same
 * dispatch path as autocomplete selections without introducing fuzzy routing.
 */
export function normalizePlainAgentMentions(
  content: string,
  agents: AgentMentionIdentity[],
): PlainAgentMentionResolution {
  const ownersByAlias = new Map<string, AgentMentionIdentity[]>();
  for (const agent of agents) {
    for (const alias of aliasesForAgent(agent)) {
      const owners = ownersByAlias.get(alias) ?? [];
      if (!owners.some((owner) => owner.userId === agent.userId)) owners.push(agent);
      ownersByAlias.set(alias, owners);
    }
  }

  let normalized = content;
  const resolvedUserIds = new Set<string>();
  const ambiguousAliases = new Set<string>();
  const aliases = Array.from(ownersByAlias.keys()).sort((a, b) => b.length - a.length);

  for (const alias of aliases) {
    const aliasPattern = escapeRegex(alias).replace(/\\ /g, '\\s+');
    const pattern = new RegExp(`(^|[^a-z0-9_])@(${aliasPattern})(?=$|[^a-z0-9_-])`, 'gi');
    if (!pattern.test(normalized)) continue;
    pattern.lastIndex = 0;

    const owners = ownersByAlias.get(alias) ?? [];
    if (owners.length !== 1) {
      ambiguousAliases.add(alias);
      continue;
    }

    const agent = owners[0]!;
    normalized = normalized.replace(
      pattern,
      (_match, prefix) => `${prefix}<@${agent.userId}|${agent.name}>`,
    );
    resolvedUserIds.add(agent.userId);
  }

  return {
    content: normalized,
    resolvedUserIds: Array.from(resolvedUserIds),
    ambiguousAliases: Array.from(ambiguousAliases),
  };
}
