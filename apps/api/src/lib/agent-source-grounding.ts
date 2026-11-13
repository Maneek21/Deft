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

const APPROVAL_ROLES = [/\binternal\s+stakeholders?\b/iu, /\bproject[ -]leads?\b/iu, /\baccount\s+managers?\b/iu];
const APPROVAL_TERM = /\b(?:approv\w*|sign[ -]?offs?|signs?\s+off)\b/iu;
const APPROVAL_NEED = /\b(?:require[sd]?|requiring|needs?|needed|must|mandatory|necessary|pending|awaiting|waiting)\b/iu;
const NEGATION = /\b(?:no|not|never|without)\b|n't\b/iu;
const HOLDER_STOPWORDS = new Set(['the', 'a', 'an', 'their', 'his', 'her', 'our', 'your', 'its', 'this', 'that', 'from', 'by', 'of', 'for', 'is', 'are', 'was', 'be', 'and', 'or']);

/** Words naming who approves: the word before the approval term and up to three after "from"/"by". */
function approvalHolders(sentence: string): string[] {
  const before = sentence.match(/([A-Za-z][\w'-]*)\s+(?:approv\w*|sign[ -]?offs?)\b/iu)?.[1];
  const after = sentence.match(/\b(?:approv\w*|sign[ -]?offs?|signs?\s+off)\b[^.!?\n]{0,40}?\b(?:from|by)\s+((?:[A-Za-z][\w'-]*\s*){1,3})/iu)?.[1];
  return [before ?? '', ...(after ?? '').split(/\s+/)]
    .map(word => word.toLowerCase().replace(/'s$/u, ''))
    .filter(word => word && !HOLDER_STOPWORDS.has(word) && !NEGATION.test(word) && !APPROVAL_NEED.test(word));
}

/**
 * An approval or sign-off requirement (or its denial) must be stated by an
 * evidence sentence with the same polarity, the same named roles and the same
 * approver. Text and evidence are plain decoded prose.
 */
export function hasUnsupportedApprovalRoles(text: string, evidence: string): boolean {
  const evidenceSentences = evidence.split(/(?<=[.!?])\s+|\n+/u).filter(sentence => APPROVAL_TERM.test(sentence));
  return text.split(/(?<=[.!?])\s+|\n+/u).some((sentence) => {
    const roles = APPROVAL_ROLES.filter(role => role.test(sentence));
    if (!APPROVAL_TERM.test(sentence) || (roles.length === 0 && !APPROVAL_NEED.test(sentence))) return false;
    const negated = NEGATION.test(sentence);
    const holders = approvalHolders(sentence);
    return !evidenceSentences.some(source => NEGATION.test(source) === negated
      && roles.every(role => role.test(source))
      && holders.every(word => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'iu').test(source)));
  });
}

/** Split serialized JSON into its string values so each one reads as separate prose. */
export function jsonStringsAsLines(text: string): string {
  return text.replace(/"\s*[,:}\]]\s*"?|[{[]\s*"/gu, '\n');
}

function decodeMarkdownDestination(destination: string): string {
  return destination
    .replace(/&#x([0-9a-f]+);?/giu, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/gu, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&(sol|quest|num|amp|period);/giu, (_, name: string) => ({ sol: '/', quest: '?', num: '#', amp: '&', period: '.' })[name.toLowerCase()]!)
    .replace(/\\([!-/:-@[-`{-~])/gu, '$1');
}

/** Any Markdown link or reference definition whose (decoded) destination is a native Deft path. */
export function hasNativeLinkDestination(text: string): boolean {
  const destinations = [
    ...[...text.matchAll(/\]\(\s*<([^>\n]*)>/gu)].map(match => match[1]!),
    ...[...text.matchAll(/\]\(\s*([^\s)<]+)/gu)].map(match => match[1]!),
    ...[...text.matchAll(/^\s*\[[^\]\n]+\]:\s*<?([^\s>]+)/gmu)].map(match => match[1]!),
  ];
  return destinations.some((destination) => {
    try {
      const url = new URL(decodeMarkdownDestination(destination).trim(), 'https://deft.invalid');
      return /^\/(modules|tasks|knowledge|calendar|chat|notes)(\/|\?|#|$)/u.test(`${url.pathname}${url.search}${url.hash}`);
    } catch { return false; }
  });
}
