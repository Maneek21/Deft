import { z } from 'zod';
import { hasNativeLinkDestination, hasUnsupportedApprovalRoles } from './agent-source-grounding.js';

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

/**
 * Parse a model draft against the supplied evidence. Checks run on the decoded
 * item text: an item that cites no evidence is dropped; an unknown source, a
 * native link, or an approval role the cited evidence does not state rejects
 * the whole draft. `evidence` maps source ids to their text (a Set of ids
 * supplies no text, so no approval claim can be supported).
 */
export function parseGroundedDraft<T>(
  text: string,
  schema: z.ZodType<T>,
  evidence: ReadonlySet<string> | ReadonlyMap<string, string>,
  options?: { sectionLimits?: Record<string, number>; minItems?: number },
): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const raw = JSON.parse(cleaned) as Record<string, unknown>;
  for (const [section, limit] of Object.entries(options?.sectionLimits ?? {})) {
    if (Array.isArray(raw[section])) raw[section] = raw[section].slice(0, limit);
  }
  const parsed = schema.parse(raw) as Record<string, unknown>;
  let kept = 0;
  let dropped = 0;
  for (const [key, section] of Object.entries(parsed)) {
    if (!Array.isArray(section)) continue;
    const items = section as Array<{ text: string; source_ids?: string[] }>;
    for (const item of items) {
      for (const sourceId of item.source_ids ?? []) {
        if (!evidence.has(sourceId)) {
          throw new Error(`Draft cited unknown source: ${sourceId}`);
        }
      }
      if (hasNativeLinkDestination(item.text)) throw new Error('Draft contains an unverified native link');
      const cited = evidence instanceof Map
        ? (item.source_ids ?? []).map((sourceId) => evidence.get(sourceId) ?? '').join('\n')
        : '';
      if (hasUnsupportedApprovalRoles(item.text, cited)) {
        throw new Error('Draft states an approval requirement the cited evidence does not');
      }
    }
    const citedItems = items.filter((item) => (item.source_ids ?? []).length > 0);
    dropped += items.length - citedItems.length;
    kept += citedItems.length;
    parsed[key] = citedItems;
  }
  if ((kept === 0 && dropped > 0) || kept < (options?.minItems ?? 0)) {
    throw new Error('Draft has no item that cites the supplied evidence');
  }
  return parsed as T;
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
