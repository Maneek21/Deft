import { z } from 'zod';
import { containsLinkConstruct, decodeHtmlEntities, mentionsApproval } from './agent-source-grounding.js';

const evidenceItemSchema = z.object({
  text: z.string().trim().min(1).max(500),
  source_ids: z.array(z.string().trim().min(1)).max(8).default([]),
});

export const standupDraftSchema = z.object({
  done: z.array(evidenceItemSchema).max(5).default([]),
  in_progress: z.array(evidenceItemSchema).max(5).default([]),
  blocked: z.array(evidenceItemSchema).max(5).default([]),
});

export const meetingPrepDraftSchema = z.object({
  agenda: z.array(evidenceItemSchema).max(4).default([]),
  decisions: z.array(evidenceItemSchema).max(4).default([]),
  updates: z.array(evidenceItemSchema).max(4).default([]),
});

export type StandupDraft = z.infer<typeof standupDraftSchema>;
export type MeetingPrepDraft = z.infer<typeof meetingPrepDraftSchema>;

// The forms the chat renderer turns into task links and reference chips.
const TASK_KEY = /\b[A-Z]{2,6}-\d+\b/g;
const DEFT_REFERENCE = /\[\[deft:((?:person|task|wiki_page):[A-Za-z0-9][A-Za-z0-9._:-]{0,255})\]\]/g;

/**
 * Parse a model draft against the supplied evidence ids. On the decoded item
 * text, any link construct or any mention of approval or sign-off in any item
 * rejects the whole draft, so the caller uses its evidence-only form. Items
 * that cite no evidence are dropped before the section caps apply; an unknown
 * source id rejects the draft. A task key or `[[deft:...]]` reference must
 * name something in the supplied evidence (`evidenceText` and the `task:`
 * source ids); without `evidenceText`, every task key is unknown.
 */
export function parseGroundedDraft<T>(
  text: string,
  schema: z.ZodType<T>,
  allowedSourceIds: ReadonlySet<string>,
  options?: { sectionLimits?: Record<string, number>; minItems?: number; evidenceText?: string },
): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const raw = JSON.parse(cleaned) as Record<string, unknown>;
  const evidenceText = options?.evidenceText ?? '';
  const knownKeys = new Set([...evidenceText.matchAll(TASK_KEY)].map((match) => match[0]));
  const knownRefs = new Set([
    ...[...evidenceText.matchAll(DEFT_REFERENCE)].map((match) => match[1]!),
    ...[...allowedSourceIds].filter((id) => id.startsWith('task:')),
  ]);
  let dropped = 0;
  for (const [section, value] of Object.entries(raw ?? {})) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const itemText = (item as { text?: unknown } | null)?.text;
      if (typeof itemText !== 'string') continue;
      // As rendered: entities decoded and Markdown backslash escapes removed.
      const shown = decodeHtmlEntities(itemText).replace(/\\([!-/:-@[-`{-~])/g, '$1');
      if (containsLinkConstruct(shown)) throw new Error('Draft contains a link');
      if (mentionsApproval(shown)) throw new Error('Draft mentions an approval');
      if ([...shown.matchAll(TASK_KEY)].some((match) => !knownKeys.has(match[0]))
        || [...shown.matchAll(DEFT_REFERENCE)].some((match) => !knownRefs.has(match[1]!))) {
        throw new Error('Draft references a record outside the supplied evidence');
      }
    }
    const cited = value.filter((item) => {
      const ids = (item as { source_ids?: unknown } | null)?.source_ids;
      return Array.isArray(ids) && ids.length > 0;
    });
    dropped += value.length - cited.length;
    raw[section] = cited;
  }
  for (const [section, limit] of Object.entries(options?.sectionLimits ?? {})) {
    if (Array.isArray(raw[section])) raw[section] = raw[section].slice(0, limit);
  }
  const parsed = schema.parse(raw);
  let kept = 0;
  for (const section of Object.values(parsed as Record<string, unknown>)) {
    if (!Array.isArray(section)) continue;
    for (const item of section as Array<{ source_ids?: string[] }>) {
      kept++;
      for (const sourceId of item.source_ids ?? []) {
        if (!allowedSourceIds.has(sourceId)) {
          throw new Error(`Draft cited unknown source: ${sourceId}`);
        }
      }
    }
  }
  if ((kept === 0 && dropped > 0) || kept < (options?.minItems ?? 0)) {
    throw new Error('Draft has no item that cites the supplied evidence');
  }
  return parsed;
}

function renderSection(title: string, items: Array<{ text: string }>): string[] {
  if (items.length === 0) return [];
  return [`**${title}**`, ...items.map((item) => `- ${item.text}`), ''];
}

export function renderStandupDraft(draft: StandupDraft): string {
  return [
    ...renderSection('Done', draft.done),
    ...renderSection('In progress', draft.in_progress),
    ...renderSection('Blocked / overdue', draft.blocked),
  ].join('\n').trim() || '- No significant work activity was recorded in the last 24 hours.';
}

export function renderMeetingPrepDraft(title: string, draft: MeetingPrepDraft): string {
  return [
    `**Meeting prep: ${title}**`,
    '',
    ...renderSection('Discuss', draft.agenda),
    ...renderSection('Decide', draft.decisions),
    ...renderSection('Share', draft.updates),
  ].join('\n').trim();
}
