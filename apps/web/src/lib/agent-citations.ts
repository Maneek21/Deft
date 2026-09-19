export type AgentCitation = {
  type: string;
  id: string;
  title: string;
  url?: string;
};

export type AgentCitationSource = {
  id: string;
  title: string;
  href: string | null;
};

function validatedCitationHref(candidate: string): string | null {
  return candidate.length <= 2_048
    && /^\/(?![\/\\])/u.test(candidate)
    && !/[\\\u0000-\u0020]/u.test(candidate)
    ? candidate
    : null;
}

/** Correct model-invented hosts only when the exact local destination is a returned source. */
export function resolveAgentCitationLink(href: string, citations: readonly AgentCitation[] | null | undefined): string | null {
  if (/[\\\u0000-\u0020]/u.test(href) || href.startsWith('//')) return null;
  let local: string;
  try {
    const url = new URL(href, 'https://deft.invalid/');
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    local = `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
  const source = normalizeAgentCitations(citations).find(citation => citation.href === local);
  if (source) return source.href;
  // Native-record destinations are not evidence unless the tool returned them.
  if (/^\/(modules|tasks|knowledge|calendar|chat|notes)(\/|\?|#|$)/u.test(local)) return null;
  return /^(https?:\/\/)/iu.test(href) ? href : null;
}

/** Render only the authority-filtered citation projection; model-authored links are never consulted. */
export function normalizeAgentCitations(citations: readonly AgentCitation[] | null | undefined): AgentCitationSource[] {
  const seen = new Set<string>();
  const sources: AgentCitationSource[] = [];
  for (const citation of citations ?? []) {
    if (!citation || citation.type === 'mcp' || typeof citation.id !== 'string' || typeof citation.title !== 'string') continue;
    if (!citation.id || citation.id.length > 512 || !citation.title || citation.title.length > 500) continue;
    if (citation.type === 'message' && citation.title.includes(',')) continue;
    const candidate = typeof citation.url === 'string'
      ? citation.url
      : citation.type === 'task'
        ? `/tasks?task=${encodeURIComponent(citation.id)}`
        : null;
    const href = candidate ? validatedCitationHref(candidate) : null;
    const key = href ?? `${citation.type}:${citation.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ id: citation.id, title: citation.title, href });
  }
  return sources;
}
