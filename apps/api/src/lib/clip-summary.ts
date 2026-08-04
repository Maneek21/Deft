import { z } from 'zod';

const clipSummaryItemSchema = z.string().trim().min(1).max(500);

export const clipSummarySchema = z.object({
  tldr: z.string().trim().max(1200),
  decisions: z.array(clipSummaryItemSchema).max(20),
  actions: z.array(clipSummaryItemSchema).max(20),
  blockers: z.array(clipSummaryItemSchema).max(20),
}).strict();

export type ClipSummary = z.infer<typeof clipSummarySchema>;

export function parseClipSummaryJson(value: string): ClipSummary | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return null;
  }

  const parsed = clipSummarySchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}
