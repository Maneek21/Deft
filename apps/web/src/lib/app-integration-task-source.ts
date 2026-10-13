/** Governed app source citations remain relative and resolve access on navigation. */
export function appIntegrationTaskSourceHref(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const transfer = (metadata as Record<string, unknown>).app_integration_transfer;
  if (!transfer || typeof transfer !== 'object' || Array.isArray(transfer)) return null;
  const href = (transfer as Record<string, unknown>).source_citation;
  return typeof href === 'string' && /^\/apps\/source\/transfer\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(href) ? href : null;
}
