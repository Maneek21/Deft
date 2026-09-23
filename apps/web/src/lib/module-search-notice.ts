/** Only render known host states; never surface raw service error text. */
export function moduleSearchNotice(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const diagnostics = (response as { search_diagnostics?: unknown }).search_diagnostics;
  if (!diagnostics || typeof diagnostics !== 'object') return null;
  const modules = (diagnostics as { modules?: unknown }).modules;
  if (!modules || typeof modules !== 'object') return null;
  const status = (modules as { status?: unknown }).status;
  if (status === 'forbidden') return 'App records are not included because you do not have access.';
  if (status === 'unavailable') return 'App records could not be searched. Try again; other results may still be available.';
  return null;
}
