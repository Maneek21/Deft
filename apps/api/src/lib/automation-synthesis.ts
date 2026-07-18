import { z } from 'zod';

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

export function parseGroundedDraft<T>(
  text: string,
  schema: z.ZodType<T>,
  allowedSourceIds: ReadonlySet<string>,
  options?: { sectionLimits?: Record<string, number> },
): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const raw = JSON.parse(cleaned) as Record<string, unknown>;
  for (const [section, limit] of Object.entries(options?.sectionLimits ?? {})) {
    if (Array.isArray(raw[section])) raw[section] = raw[section].slice(0, limit);
  }
  const parsed = schema.parse(raw);
  for (const section of Object.values(parsed as Record<string, unknown>)) {
    if (!Array.isArray(section)) continue;
    for (const item of section as Array<{ source_ids?: string[] }>) {
      for (const sourceId of item.source_ids ?? []) {
        if (!allowedSourceIds.has(sourceId)) {
          throw new Error(`Draft cited unknown source: ${sourceId}`);
        }
      }
    }
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
