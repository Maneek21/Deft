/**
 * The fixed folder names of the web app's pages (apps/web/src/app), for
 * telemetry. A path segment outside this list is never sent as written: it
 * becomes ":param" (a page path) or drops the frame (a bundle path).
 *
 * The web app sends page paths already as templates (its dynamic segments
 * replaced by their names, lib/error-telemetry.ts); this list is the server's
 * own check on whatever arrives. A page added without updating the list is
 * reported with ":param" in place of its new folder name, never with text.
 */
export const WEB_PATH_WORDS: ReadonlySet<string> = new Set([
  'action-batches', 'agent', 'agent-employees', 'ai', 'api-access', 'app-attachments', 'app-experience-bootstrap',
  'app-resources', 'approvals', 'apps', 'attachment-operator', 'attention', 'authorize', 'calendar', 'callback', 'chat',
  'connections', 'create', 'dashboard', 'developer', 'email', 'forgot-password', 'groups', 'heartbeats', 'inbox',
  'integration-preparations', 'integrations', 'invite', 'knowledge', 'library', 'license', 'login', 'mcp', 'mcp-access',
  'members', 'modules', 'native-email', 'notes', 'oauth', 'operator', 'private-app-resources', 'private-resources',
  'profile', 'projects', 'recovery', 'reminders', 'reset-password', 'search', 'settings', 'setup', 'setup-ai', 'share',
  'shared', 'sharing', 'signup', 'skills', 'source', 'tags', 'tasks', 'teams', 'transfer', 'two-step-setup', 'webhooks',
  'welcome', 'workflows',
]);

/** Next.js bundle folders that are not page folders. */
const BUNDLE_FOLDERS = new Set(['chunks', 'app', 'pages', 'css', 'media']);
/** Next.js bundle file names, before their content hash. */
const BUNDLE_FILES = new Set([
  'page', 'layout', 'template', 'loading', 'error', 'not-found', 'global-error', 'default', 'route',
  'main', 'main-app', 'webpack', 'framework', 'polyfills', 'app-pages-internals',
]);

/** A route-group folder "(app)", or a dynamic folder "[id]", "[...slug]", "[[...slug]]". */
function isPatternFolder(segment: string): boolean {
  return /^\([a-z][a-z0-9-]{0,30}\)$/.test(segment) || /^\[{1,2}(?:\.\.\.)?[A-Za-z_][A-Za-z0-9_]{0,30}\]{1,2}$/.test(segment);
}

/**
 * A browser frame's file, if it is one of the web app's own bundles:
 * `_next/static/` then known folders, then a known file name or a numbered
 * chunk, with any content hash. Returned with hashes replaced; else null.
 */
export function webBundlePath(pathname: string): string | null {
  const path = pathname.replace(/^\/+/, '');
  if (!path.startsWith('_next/static/') || path.length > 300) return null;
  const segments = path.slice('_next/static/'.length).split('/');
  const fileName = segments.pop() ?? '';
  for (const segment of segments) {
    if (!BUNDLE_FOLDERS.has(segment) && !WEB_PATH_WORDS.has(segment) && !isPatternFolder(segment)) return null;
  }
  const match = /^(.+?)(?:-([0-9a-f]{6,}))?\.js$/.exec(fileName);
  if (!match) return null;
  const base = match[1]!;
  if (!BUNDLE_FILES.has(base) && !/^\d{1,8}$/.test(base)) return null;
  return `_next/static/${[...segments, `${base}${match[2] ? '-<hash>' : ''}.js`].join('/')}`;
}

/** Fixed words of the API's own route paths, registered once the routes are mounted. */
const apiRouteWords = new Set<string>();

export function addApiRouteWords(paths: Iterable<string>): void {
  for (const path of paths) {
    for (const segment of path.split('/')) {
      if (segment && !segment.startsWith(':') && segment !== '*' && /^[A-Za-z0-9_.-]{1,60}$/.test(segment)) apiRouteWords.add(segment);
    }
  }
}

/** True for a fixed word of an API route or a web page folder: code, never data. */
export function isRouteWord(segment: string): boolean {
  return apiRouteWords.has(segment) || WEB_PATH_WORDS.has(segment);
}
