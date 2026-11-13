/** Availability and authority questions require the runtime inventory, not record bindings. */
export function requiresRuntimeActionEvidence(request: string): boolean {
  const inventory = /\b(?:actions?|capabilit(?:y|ies)|runtime\s+tools?)\b/iu;
  const discovery = /\b(?:discover|which|what|check|list|show|find|whether|can\s+(?:you|I)|are|is)\b/iu;
  const runtime = /\b(?:apps?|sideloaded|runtime)\b/iu;
  const authority = /\b(?:can\s+you|can\s+I|whether|do|does)\b[^.!?\n]{0,160}\b(?:autonomously|autonomous|require\s+approval|requires\s+approval|request\s+approval)\b/iu;
  return request.split(/[.!?\n]+/u).some(sentence => (
    (inventory.test(sentence) && discovery.test(sentence) && /\bdiscoverable\b/iu.test(sentence))
    || (runtime.test(sentence) && ((inventory.test(sentence) && discovery.test(sentence)) || authority.test(sentence)))
  ));
}

/** Require a complete successful pagination chain for the unfiltered inventory. */
export function hasRuntimeActionEvidence(reads: readonly { action: string; success: boolean; params?: unknown; result?: unknown }[]): boolean {
  let expectedCursor: string | null = null;
  let started = false;
  for (const read of reads) {
    if (read.action !== 'app_runtime_action_list' || !read.success) continue;
    const input = read.params && typeof read.params === 'object' ? read.params as Record<string, unknown> : {};
    const result = read.result && typeof read.result === 'object' ? read.result as Record<string, unknown> : {};
    if (input.installation_id !== undefined) continue;
    if (!Array.isArray(result.actions) || result.authority !== 'discovery_only') continue;
    if (!input.after) {
      started = true;
    } else if (!started || input.after !== expectedCursor) {
      continue;
    }
    if (result.has_more === false && result.next_cursor === null) return true;
    if (result.has_more !== true || typeof result.next_cursor !== 'string' || !result.next_cursor) {
      started = false;
      continue;
    }
    expectedCursor = result.next_cursor;
  }
  return false;
}

/** A native link in a reply must come from a read in this turn, not model memory. */
export function hasUnverifiedNativeLinks(text: string, sources: readonly { url?: string; type?: string; id?: string }[]): boolean {
  const destinations = new Set(sources.flatMap(source => source.url ? [source.url]
    : source.type === 'task' && source.id ? [`/tasks?task=${encodeURIComponent(source.id)}`] : []));
  for (const match of text.matchAll(/\]\(([^\s)]+)\)/gu)) {
    try {
      const url = new URL(match[1]!, 'https://deft.invalid');
      const path = `${url.pathname}${url.search}${url.hash}`;
      if (/^\/(modules|tasks|knowledge|calendar|chat|notes)(\/|\?|#|$)/u.test(path)
        && !destinations.has(match[1]!)) return true;
    } catch { /* Invalid links are rejected by the renderer. */ }
  }
  return false;
}

/** A recipient-specific draft must not quietly turn into a placeholder template. */
export function hasUnresolvedRecipient(text: string, request: string): boolean {
  if (/\b(?:template|with placeholders|sample message|example message)\b/iu.test(request)) return false;
  const positiveRequest = request.replace(/\b(?:do not|don't|never)\b[^.!?\n]*/giu, '');
  if (!/\b(?:draft|compose|write|propose|prepare)\b[^.!?\n]{0,80}\b(?:message|email|reply|follow[ -]?up|outreach)\b/iu.test(positiveRequest)) return false;
  const bracketedAddressee = /\[[^\]\n]*(?:contact|recipient|decision\s+maker)[^\]\n]*\]/iu;
  const greetingPlaceholder = /\b(?:dear|hi|hello|hey)\s+(?:\[\s*name\s*\]|_{2,}|<\s*(?:name|recipient|contact|decision\s+maker)\s*>)/iu;
  return bracketedAddressee.test(text) || greetingPlaceholder.test(text);
}

/** Requests that explicitly target workspace records need a successful current-turn read. */
export function requiresWorkspaceEvidence(request: string): boolean {
  const nativeResource = String.raw`(?:workspace\s+)?(?:record|contact|company|deal|task|module|account)s?`;
  if (new RegExp(String.raw`\b(?:existing|canonical|current|workspace)\b[^\n.!?]{0,80}\b${nativeResource}\b`, 'iu').test(request)) return true;
  if (new RegExp(String.raw`\b(?:find|search|look\s*up|lookup)\b[^\n.!?]{0,80}\b${nativeResource}\b`, 'iu').test(request)) return true;
  const summaryTarget = request.match(/\b(?:summarize|summary\s+(?:of|for)|brief\s+(?:on|for))\s+([^\n.!?]+)/iu)?.[1]?.trim();
  return Boolean(summaryTarget && /^(?:the\s+)?[A-Z][A-Za-z0-9&.'’-]*/u.test(summaryTarget));
}

/** Chat proposals are governed by Deft review, not invented organizational approvers. */
export function hasUnverifiedApprovalRoles(text: string): boolean {
  const role = /\b(?:relevant\s+)?internal\s+stakeholders?\b|\bproject[ -]leads?\b|\baccount\s+managers?\b/iu;
  const approvalClaim = /\b(?:approval|sign[ -]?off)\b[^\n]{0,180}\b(?:is\s+)?(?:required|needed|mandatory)\b|\bmust\s+(?:approve|sign[ -]?off)\b/iu;
  const explicitDenial = /\b(?:no|not)\b[^.!?\n]{0,50}\b(?:approval|sign[ -]?off)\b|\b(?:approval|sign[ -]?off)\b[^.!?\n]{0,50}\b(?:is\s+)?not\s+required\b/iu;
  return text.split(/(?<=[.!?])\s+|\n+/u).some(sentence => (
    role.test(sentence) && approvalClaim.test(sentence) && !explicitDenial.test(sentence)
  ));
}

/**
 * A conservative check: drafts that mention approvals or sign-off use the
 * evidence-only form. It matches the listed words only (approv*, sign-off,
 * sign off, signed off); it is not a guarantee against paraphrase.
 */
export function mentionsApproval(text: string): boolean {
  return /\b(?:approv\w*|sign[ -]?offs?|signs?\s+off|signed\s+off|signing\s+off)\b/iu.test(text);
}

/** Any link construct a Markdown or HTML renderer could turn into a link, whatever its target. */
export function containsLinkConstruct(text: string): boolean {
  return /\][([]|\]:|<\s*(?:[a-z][a-z0-9+.-]*:|www\.|a\b|img\b)|<[^\s<>@]+@[^\s<>]+>|[\w.+-]+@[\w-]+\.[\w-]|\b(?:https?|ftp|mailto):|\bwww\./iu.test(text);
}

/** The string values of a (possibly fenced) JSON reply, one per line; the text itself if it is not JSON. */
export function decodedJsonText(text: string): string {
  try {
    const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
    const strings: string[] = [];
    const collect = (node: unknown): void => {
      if (typeof node === 'string') strings.push(node);
      else if (Array.isArray(node)) node.forEach(collect);
      else if (node && typeof node === 'object') Object.values(node).forEach(collect);
    };
    collect(value);
    return strings.join('\n');
  } catch {
    return text;
  }
}

// Every HTML5 name for the characters that form links, plus common URL punctuation.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', lsqb: '[', lbrack: '[', rsqb: ']', rbrack: ']', lpar: '(', rpar: ')',
  colon: ':', sol: '/', bsol: '\\', quest: '?', num: '#', period: '.', percnt: '%', equals: '=',
  commat: '@', excl: '!', apos: "'", quot: '"', nbsp: ' ',
};

/** Decode HTML character references once, as a renderer would; unknown names stay as written. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]*);/giu, (entity, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}
