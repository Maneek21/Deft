/** Optional trusted tooling templates. Manifests cannot register callbacks. */
const templates = new Map<string, (cwd: string) => Promise<void>>();
export function registerAuthorToolTemplate(name: string, initialize: (cwd: string) => Promise<void>): void {
  if (templates.has(name)) throw Error('AUTHOR_TEMPLATE_ALREADY_REGISTERED');
  templates.set(name, initialize);
}
export async function initializeAuthorToolTemplate(name: string, cwd: string): Promise<void> {
  const initialize = templates.get(name);
  if (!initialize) throw Error('This template requires its optional example CLI');
  await initialize(cwd);
}
