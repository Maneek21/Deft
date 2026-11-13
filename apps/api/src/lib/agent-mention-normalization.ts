export type AgentMentionIdentity = {
  userId: string;
  name: string;
  slug: string;
};
import { stripNativeMentionAtoms } from '@deft/shared';

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

/**
 * Turn exact, unambiguous plain-text agent handles into the canonical mention
 * marker used by chat. A token resolves only when, case-insensitively, it
 * equals one agent's slug or one-token display name and no other participant
 * (another agent, or a `competingTokens` entry) owns the same token; anything
 * else stays plain text. Native identity atoms are left as-is.
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

  // Odd segments are native identity atoms and are never rewritten.
  const segments = content.split(/(<span\b[^>]*data-deft-ref-kind[^>]*>[\s\S]*?<\/span>|\[\[deft:(?:person|task|wiki_page):[^\]]+\]\])/gi);
  const resolvedUserIds = new Set<string>();
  const ambiguousAliases = new Set<string>();
  const normalized = segments.map((segment, index) => {
    if (index % 2 === 1 || stripNativeMentionAtoms(segment) === '') return segment;
    return segment.replace(/(?<![a-z0-9_])@([a-z0-9_-]+)/gi, (match, token: string) => {
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
  }).join('');

  return {
    content: normalized,
    resolvedUserIds: Array.from(resolvedUserIds),
    ambiguousAliases: Array.from(ambiguousAliases),
  };
}
