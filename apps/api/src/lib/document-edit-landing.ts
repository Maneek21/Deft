// Where an agent's edit to a document lands (spec 5.7; plan Task M5, with
// the 25 Nov consult's changes and the owner's answers that day): straight
// in (`direct`), as a suggestion that only the asker reviews (`suggest`), or
// not at all (`refuse`). This module only decides. The edit engine
// (document-edit.ts, applyDocumentEditDirect) applies a direct edit, M6's
// suggestions hold the rest, and M7's runner wiring gathers the inputs and
// calls decideEditLanding.
//
// The rules, in order; the first that applies decides:
//  1. Nobody asked (`askerId` null: heartbeats, triggers, background work):
//     refuse, `unprompted`.
//  2. The asker's role on the document is below edit, or they have none:
//     refuse, `asker_cannot_edit`.
//  3. The workspace trust level is Conservative: suggest. A level that is
//     neither Standard nor Autonomous counts as Conservative.
//  4. The drive requires suggestions (`agent_suggest_only`): suggest.
//  5. The request (owner, 25 Nov; controller ruling on M5, 27 Nov). The
//     model's `mode` argument (`requestOverride`) can only lower a landing:
//     - the model asks 'suggest': a suggestion (`request_suggest`), even when
//       the asker said "just do it";
//     - otherwise, the asker's own triggering message holds one of
//       DIRECT_EDIT_PHRASES (askerRequestedDirect): straight in
//       (`request_direct`). The asker's words are the request; the model
//       needn't ask as well;
//     - the model asks 'direct' without the phrase: a suggestion
//       (`request_suggest`: a direct request nobody confirmed counts as a
//       request to suggest), whatever the setting;
//     - neither: rule 6 decides.
//     The message is the asker's own words, passed by the caller: never
//     document text, a tool result or the model's arguments, so nothing the
//     agent read can make an edit direct.
//     The M5–M7 consult (27 Nov): any model mode other than exactly
//     'direct' lowers (O-F7); the asker's own words asking for a suggestion
//     or a review, or a direct phrase a negating word cancels anywhere
//     earlier in its sentence or clause, lower too (O-F1); and only the
//     asker's own plain text is read, never what they quoted, pasted,
//     forwarded or put in code (askerOwnText, O-F11).
//  6. The asker's setting (agentEditModeFor; `suggest_when_open` when they
//     have saved none): `direct` goes straight in; `suggest` suggests;
//     `suggest_when_open` suggests while another person has the document open
//     (otherHumansOpen) and goes straight in otherwise. The same in every
//     drive, the asker's own My drive included: the personal-drive rule was
//     removed (owner, 25 Nov). A setting that isn't one suggests.
//
// otherHumansOpen asks the live-editing server who is connected to the
// document (getCollabServer().connectedUserIds) and counts only active
// human members of the workspace other than the asker: never Defty, an
// employee's agent user, any `kind = 'agent'` or system user, or someone
// who has left.
//
// The setting is one row per person and workspace in
// document_user_settings (upgrade 0.3.0-preview.156), read and saved
// through GET and PATCH /api/document-settings (routes/documents.ts).
// Saving needs an active membership, held FOR SHARE while the row is
// written, so a member being deactivated can't save after they've left.
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { orgMembers, users } from '@deft/db/schema';
import { AGENT_EDIT_MODES, documentUserSettings, type AgentEditMode, type DriveKind } from '@deft/db/documents';
import { getCollabServer } from '../collab/server.js';
import type { TrustLevel } from './agent-approval.js';
import { db } from './db.js';
import { DEFTY_EMAIL } from './defty-identity.js';
import { roleAtLeast, type DocRole } from './document-access.js';

export { AGENT_EDIT_MODES, type AgentEditMode };

/** What a person gets when they have saved no setting. */
export const DEFAULT_AGENT_EDIT_MODE: AgentEditMode = 'suggest_when_open';

export type EditLanding =
  | { landing: 'direct'; reason: 'request_direct' | 'mode_direct' | 'nobody_else_open' }
  | { landing: 'suggest'; reason: 'conservative_trust' | 'drive_suggest_only' | 'request_suggest' | 'mode_suggest' | 'others_open' }
  | { landing: 'refuse'; reason: 'unprompted' | 'asker_cannot_edit' };

export type EditLandingInput = {
  /** The workspace trust level (orgs.trust_level); for an employee, the lower of that and its own (M7). */
  trustLevel: TrustLevel;
  /** The person who asked for the edit, or null when nobody did. */
  askerId: string | null;
  /** The asker's role on the document now (documentRoleFor), or null. */
  askerRole: DocRole | null;
  /** The document's drive. Its kind and owner don't change the landing (owner, 25 Nov). */
  drive: { kind: DriveKind; ownerUserId: string | null; agentSuggestOnly: boolean };
  /** The asker's setting (agentEditModeFor). */
  mode: AgentEditMode;
  /** The model's `mode` argument: 'suggest' lowers the landing; 'direct' without the asker's phrase is a suggestion (rule 5). */
  requestOverride: 'direct' | 'suggest' | null;
  /**
   * The asker's own triggering message, as they wrote it, and nothing else:
   * never document text, a tool result or the model's arguments. Null when
   * there is none.
   */
  askerMessageText: string | null;
  /** Another active human has the document open (otherHumansOpen). */
  otherHumansOpen: boolean;
};

/** The words in the asker's own message that put an edit straight in (owner, 25 Nov), unless the model lowers it. */
export const DIRECT_EDIT_PHRASES = ['just do it', 'go ahead and edit', 'apply it', 'apply directly', 'make the change', 'edit it directly', "don't suggest"];

/**
 * A letter, combining mark, digit or underscore in any script. The patterns
 * below carry the `u` flag, so this is matched against whole characters
 * (code points), never one half of a UTF-16 surrogate pair (review M5).
 */
const WORD_CHAR = String.raw`[\p{L}\p{M}\p{N}_]`;
/** The negating words (consult O-F1: "no" and the other contractions too). */
const NEGATING_WORDS = String.raw`not|no|nor|never|don't|dont|doesn't|didn't|cannot|can't|cant|won't|wont|shouldn't|wouldn't|mustn't`;
/**
 * A negating word whole, then nothing but spaces, punctuation and symbols up
 * to the phrase ("don't just do it", "never, apply it", "don't \u2014 just do
 * it"): the asker said the opposite (tester M5). Tested on the text before the
 * phrase.
 */
const NEGATED = new RegExp(String.raw`(?<![\p{L}\p{M}\p{N}_'])(?:${NEGATING_WORDS})[^\p{L}\p{M}\p{N}_]*$`, 'u');
/**
 * A negating word anywhere in the same sentence or clause before the phrase
 * (consult O-F1): "I don't want you to apply it", "Do not, under any
 * circumstances, make the change", "Not yet, apply it after I review". The
 * clause is the text after the last `.`, `!`, `?`, `;` or line break before
 * the phrase, so "I don't mind. Just do it" still asks. Fails closed: such a
 * phrase never puts an edit straight in.
 */
const NEGATING_WORD = new RegExp(String.raw`(?<![\p{L}\p{M}\p{N}_'])(?:${NEGATING_WORDS})(?![\p{L}\p{M}\p{N}_'])`, 'u');
const CLAUSE_END = /[.!?;\n]/gu;

/** The text before `index` back to the start of its sentence or clause. */
function clauseBefore(text: string, index: number): string {
  const before = text.slice(0, index);
  let start = 0;
  for (const match of before.matchAll(CLAUSE_END)) start = match.index + 1;
  return before.slice(start);
}

/**
 * The words in the asker's own message that ask for a suggestion or a review
 * (consult O-F1): any of them lowers the landing to a suggestion, whatever
 * else the message says. "suggest" right after a negating word ("don't
 * suggest", one of DIRECT_EDIT_PHRASES) doesn't count.
 */
export const SUGGEST_EDIT_PHRASES = [
  'suggest', 'suggestion', 'suggestions', 'as a suggestion', 'let me review', 'for review', 'for me to review',
  'review it first', 'review first', 'after i review', "don't apply", 'do not apply',
];

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
}

/** Every place `phrase` appears whole: no WORD_CHAR right before or after it, a space or a line break between its words. */
function wholePhrase(phrase: string): RegExp {
  return new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(phrase).replace(/ /gu, '[ \\n]')}(?!${WORD_CHAR})`, 'gu');
}

/**
 * Lower case, typographic apostrophes as ', each run of whitespace as one
 * space (a run holding a line break as one line break, so it still ends a
 * clause), so a phrase matches however it was typed.
 */
function normalizedMessage(text: string): string {
  return text.normalize('NFKC').replace(/[\u2018\u2019\u02BC]/gu, "'")
    .replace(/\s+/gu, (run) => (/[\n\r\u2028\u2029]/u.test(run) ? '\n' : ' ')).toLowerCase();
}

const HTML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

/**
 * The asker's own plain text of a stored message (consult O-F11): what they
 * quoted, pasted or forwarded is left out, so someone else's "just do it"
 * never asks. Removed: HTML blockquotes, preformatted and code elements,
 * Markdown fenced code blocks and inline code, Markdown quote lines (`>`),
 * and everything from a forwarded or quoted-reply marker on ("---------
 * Forwarded message ---------", "Begin forwarded message:", "On \u2026 wrote:").
 * The remaining tags become spaces (a block or line break tag a line break).
 */
export function askerOwnText(messageText: string): string {
  if (typeof messageText !== 'string') return '';
  let text = messageText;
  // Innermost blockquote first, until none is left.
  const innermostQuote = /<blockquote\b[^>]*>(?:(?!<blockquote\b)[\s\S])*?<\/blockquote\s*>/giu;
  for (let previous = ''; previous !== text;) { previous = text; text = text.replace(innermostQuote, '\n'); }
  text = text.replace(/<blockquote\b[^>]*>[\s\S]*$/giu, '\n'); // an unclosed one runs to the end
  text = text.replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ').replace(/<(pre|code)\b[^>]*>[\s\S]*$/giu, ' ');
  text = text.replace(/<(?:br|\/?(?:p|div|li|ul|ol|h[1-6]|tr|table))\b[^>]*>/giu, '\n').replace(/<[^>]*>/gu, ' ');
  text = text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/gu, (entity) => HTML_ENTITIES[entity] ?? ' ');
  // Markdown: fenced blocks (an unclosed fence runs to the end), inline code, quote lines.
  text = text.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gmu, ' ').replace(/^[ \t]*(```|~~~)[\s\S]*$/mu, ' ');
  text = text.replace(/`[^`\n]*`/gu, ' ');
  text = text.replace(/^[ \t]*>.*$/gmu, '');
  // A forwarded or quoted reply: the asker's own words are what comes before it.
  const marker = /^[ \t]*(?:-{2,}[ \t]*(?:forwarded|original) message[ \t]*-{2,}|begin forwarded message:|on\b.{0,200}\bwrote:)[ \t]*$/imu.exec(text);
  if (marker) text = text.slice(0, marker.index);
  return text;
}

/**
 * True when `messageText`, the asker's own message (askerOwnText: never what
 * they quoted, pasted or forwarded), holds one of DIRECT_EDIT_PHRASES as a
 * whole phrase in any letter case ("applying it", "make the changes" and a
 * letter of any script against it don't match), other than after a negating
 * word: right before it (only spaces, punctuation or symbols between), or
 * anywhere earlier in the same sentence or clause (consult O-F1).
 */
export function askerRequestedDirect(messageText: string): boolean {
  if (typeof messageText !== 'string' || messageText.length === 0) return false;
  const text = normalizedMessage(askerOwnText(messageText));
  return directPhraseMatches(text).some((match) => !match.negated);
}

/** Each DIRECT_EDIT_PHRASES match in normalized `text`, and whether a negating word cancels it (consult O-F1). */
function directPhraseMatches(text: string): Array<{ negated: boolean }> {
  const found: Array<{ negated: boolean }> = [];
  for (const phrase of DIRECT_EDIT_PHRASES) {
    for (const match of text.matchAll(wholePhrase(phrase))) {
      found.push({ negated: NEGATED.test(text.slice(0, match.index)) || NEGATING_WORD.test(clauseBefore(text, match.index)) });
    }
  }
  return found;
}

/**
 * True when the asker's own message asks for a suggestion or a review
 * (consult O-F1): one of SUGGEST_EDIT_PHRASES ("suggest it", "let me
 * review", "don't apply", "as a suggestion"; a "suggest" right after a
 * negating word, as in "don't suggest", isn't one), or a direct phrase a
 * negating word cancels ("I don't want you to apply it"): either fails
 * closed to a suggestion.
 */
export function askerRequestedSuggest(messageText: string): boolean {
  if (typeof messageText !== 'string' || messageText.length === 0) return false;
  const text = normalizedMessage(askerOwnText(messageText));
  for (const phrase of SUGGEST_EDIT_PHRASES) {
    for (const match of text.matchAll(wholePhrase(phrase))) {
      if (phrase.startsWith('suggest') && NEGATED.test(text.slice(0, match.index))) continue;
      return true;
    }
  }
  return directPhraseMatches(text).some((match) => match.negated);
}

/** Where the edit lands, by the rules in the header. */
export function decideEditLanding(i: EditLandingInput): EditLanding {
  if (!i.askerId) return { landing: 'refuse', reason: 'unprompted' };
  if (!roleAtLeast(i.askerRole, 'edit')) return { landing: 'refuse', reason: 'asker_cannot_edit' };
  if (i.trustLevel !== 'standard' && i.trustLevel !== 'autonomous') return { landing: 'suggest', reason: 'conservative_trust' };
  if (i.drive.agentSuggestOnly !== false) return { landing: 'suggest', reason: 'drive_suggest_only' };
  // Consult O-F7: any request other than exactly 'direct' lowers, before the asker's phrase is read.
  if (i.requestOverride !== null && i.requestOverride !== undefined && i.requestOverride !== 'direct') return { landing: 'suggest', reason: 'request_suggest' };
  // Consult O-F1: the asker's own words asking for a suggestion or a review lower it too.
  if (askerRequestedSuggest(i.askerMessageText ?? '')) return { landing: 'suggest', reason: 'request_suggest' };
  if (askerRequestedDirect(i.askerMessageText ?? '')) return { landing: 'direct', reason: 'request_direct' };
  if (i.requestOverride !== null && i.requestOverride !== undefined) return { landing: 'suggest', reason: 'request_suggest' };
  switch (i.mode) {
    case 'direct':
      return { landing: 'direct', reason: 'mode_direct' };
    case 'suggest_when_open':
      return i.otherHumansOpen === false ? { landing: 'direct', reason: 'nobody_else_open' } : { landing: 'suggest', reason: 'others_open' };
    default:
      return { landing: 'suggest', reason: 'mode_suggest' };
  }
}

function storedMode(mode: unknown): AgentEditMode {
  return typeof mode === 'string' && (AGENT_EDIT_MODES as readonly string[]).includes(mode) ? mode as AgentEditMode : DEFAULT_AGENT_EDIT_MODE;
}

type Reader = Pick<typeof db, 'select'>;

/** `userId`'s setting in `orgId`: their saved row, or suggest_when_open. */
export async function agentEditModeFor(orgId: string, userId: string, reader: Reader = db): Promise<AgentEditMode> {
  const [row] = await reader.select({ mode: documentUserSettings.agent_edit_mode }).from(documentUserSettings)
    .where(and(eq(documentUserSettings.org_id, orgId), eq(documentUserSettings.user_id, userId))).limit(1);
  return storedMode(row?.mode);
}

/**
 * Saves `userId`'s setting in `orgId` and answers it, or null when they
 * aren't an active member there (nothing is written). The membership row is
 * held FOR SHARE until the save commits.
 */
export async function setAgentEditMode(orgId: string, userId: string, mode: AgentEditMode): Promise<AgentEditMode | null> {
  return db.transaction(async (tx) => {
    const [member] = await tx.select({ id: orgMembers.id }).from(orgMembers)
      .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, userId), eq(orgMembers.is_active, true)))
      .limit(1).for('share');
    if (!member) return null;
    const [row] = await tx.insert(documentUserSettings)
      .values({ id: randomUUID(), org_id: orgId, user_id: userId, agent_edit_mode: mode })
      .onConflictDoUpdate({
        target: [documentUserSettings.org_id, documentUserSettings.user_id],
        set: { agent_edit_mode: mode, updated_at: sql`now()` },
      })
      .returning({ mode: documentUserSettings.agent_edit_mode });
    return storedMode(row?.mode);
  });
}

/**
 * True when `userIds` holds someone other than `askerId` who is an active
 * human member of `orgId`: not Defty, an employee's agent user, any agent or
 * system user, a member who has left, or a person of another workspace.
 */
export async function otherHumansAmong(orgId: string, askerId: string, userIds: readonly string[], reader: Reader = db): Promise<boolean> {
  const others = [...new Set(userIds)].filter((id) => id !== askerId);
  if (others.length === 0) return false;
  const [row] = await reader.select({ id: users.id }).from(users)
    .innerJoin(orgMembers, and(eq(orgMembers.user_id, users.id), eq(orgMembers.org_id, orgId), eq(orgMembers.is_active, true)))
    .where(and(
      inArray(users.id, others),
      eq(users.kind, 'human'),
      eq(users.is_agent, false),
      isNull(users.agent_employee_id),
      sql`${users.email} IS DISTINCT FROM ${DEFTY_EMAIL}`,
    ))
    .limit(1);
  return row !== undefined;
}

/** True when another active human has `documentId` open over live editing in this process (the header). */
export async function otherHumansOpen(i: { orgId: string; documentId: string; askerId: string }, reader: Reader = db): Promise<boolean> {
  return otherHumansAmong(i.orgId, i.askerId, getCollabServer().connectedUserIds(i.documentId), reader);
}
