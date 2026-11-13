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

const APPROVAL_TERM = /\b(?:approve[sd]?|approving|approvals?|approvers?|sign[ -]?offs?|signs?\s+off)\b/iu;
const REQUIREMENT_TERM = /\b(?:require[sd]?|requiring|requirements?|needs?|needed|must|mandatory|necessary|pending|awaiting|waiting)\b/iu;

/** Any sentence that pairs an approval or sign-off word with a requirement word (whole words). */
export function statesApprovalRequirement(text: string): boolean {
  return text.split(/(?<=[.!?])\s+|\n+/u).some(sentence => APPROVAL_TERM.test(sentence) && REQUIREMENT_TERM.test(sentence));
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

const NAMED_URL_ENTITIES: Record<string, string> = {
  amp: '&', sol: '/', bsol: '\\', colon: ':', quest: '?', num: '#', period: '.', percnt: '%', equals: '=',
  commat: '@', lowbar: '_', hyphen: '-', dash: '-', excl: '!', plus: '+', comma: ',', semi: ';',
  lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', lbrack: '[', rbrack: ']', tilde: '~', apos: "'", quot: '"',
};

/** Markdown's reading of a link destination; null when an entity is left that this cannot decode. */
function decodeMarkdownDestination(destination: string): string | null {
  const decoded = destination
    .replace(/&#x([0-9a-f]{1,6});/giu, (_, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
    .replace(/&#(\d{1,7});/gu, (_, dec: string) => String.fromCodePoint(Math.min(Number(dec), 0x10ffff)))
    .replace(/&([a-z][a-z0-9]*);/giu, (entity, name: string) => NAMED_URL_ENTITIES[name.toLowerCase()] ?? entity)
    .replace(/\\([!-/:-@[-`{-~])/gu, '$1');
  return /&[a-z][a-z0-9]*;/iu.test(decoded) ? null : decoded;
}

/** Any Markdown link or reference definition whose decoded destination is (or may be) a native Deft path. */
export function hasNativeLinkDestination(text: string): boolean {
  const destinations = [
    ...[...text.matchAll(/\]\(\s*<([^>\n]*)>/gu)].map(match => match[1]!),
    ...[...text.matchAll(/\]\(\s*([^\s)<]+)/gu)].map(match => match[1]!),
    ...[...text.matchAll(/^\s*\[[^\]\n]+\]:\s*<?([^\s>]+)/gmu)].map(match => match[1]!),
  ];
  return destinations.some((destination) => {
    try {
      const decoded = decodeMarkdownDestination(destination);
      if (decoded === null) return true;
      const url = new URL(decoded.trim(), 'https://deft.invalid');
      return /^\/(modules|tasks|knowledge|calendar|chat|notes)(\/|\?|#|$)/u.test(`${url.pathname}${url.search}${url.hash}`);
    } catch { return false; }
  });
}
