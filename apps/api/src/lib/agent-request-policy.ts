/** Applies to the current user's request, never to retrieved workspace content. */
export function isReadOnlyAgentRequest(content: string): boolean {
  return /\bread[ -]only\b/i.test(content)
    || /\b(?:do not|don't|never)\s+(?:create|modify|change|update|propose)(?:\s*(?:,|or|and)\s*(?:create|modify|change|update|propose))*\s+(?:any\s+)?(?:records|tasks|actions|changes|anything)\b/i.test(content);
}
