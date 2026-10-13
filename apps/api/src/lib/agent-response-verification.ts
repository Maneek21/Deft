/** A review is not itself an answer. Only an explicit correction may replace one. */
export function selectVerifiedResponse(original: string, review: string): string {
  try {
    const result: unknown = JSON.parse(review.trim());
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const correction = result as Record<string, unknown>;
      if (correction.verdict === 'corrected' && typeof correction.response === 'string' && correction.response.trim()) {
        return correction.response.trim();
      }
    }
  } catch {
    // Free-form feedback, invalid JSON, and legacy VERIFIED replies preserve the answer.
  }
  return original;
}
