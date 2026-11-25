/**
 * The web app's pages (apps/web/src/app), for telemetry: what a page path or
 * a bundle path may say when it leaves the cell.
 *
 * WEB_PAGE_PATTERNS lists every page, route groups dropped and dynamic
 * folders written ":name". A page path is matched against the whole list and
 * the matching pattern is sent, never the path: "/modules/billing",
 * "/modules/:orchid" and "/modules/chat" all become "/modules/:slug". A path
 * that matches no page (a page added since this list, or anything made up)
 * is sent as no route at all.
 */
export const WEB_PAGE_PATTERNS: readonly string[] = [
  '/', '/app-attachments/:bindingId', '/app-attachments/:bindingId/:projectionId',
  '/app-resources/:registrationId/:resourceType/:projectionId',
  '/app-resources/mcp/:registrationId/:resourceType/:projectionId', '/app-resources/search/:bindingId',
  '/app-resources/share/:registrationId/:resourceType/:projectionId', '/approvals',
  '/apps/:installationId/:experienceKey', '/apps/action-batches/:batchId', '/apps/connections/callback',
  '/apps/integration-preparations/:invocationId', '/apps/recovery/native-email/:accountId', '/apps/source/:sourceId',
  '/apps/source/attention/:sourceId', '/apps/source/native-email/:sourceId', '/apps/source/transfer/:sourceId',
  '/calendar', '/chat', '/dashboard', '/email', '/email/connections/callback', '/forgot-password', '/inbox', '/invite',
  '/invite/:token', '/knowledge', '/library', '/license', '/login', '/modules', '/modules/:slug',
  '/modules/:slug/:collectionKey', '/modules/:slug/:collectionKey/:recordId', '/notes', '/oauth/authorize',
  '/private-app-resources/mcp/:appId', '/private-app-resources/shared', '/private-app-resources/shared/:grantId',
  '/private-app-resources/sharing/:appId', '/reminders', '/reset-password', '/settings', '/settings/agent',
  '/settings/agent-employees', '/settings/agent-employees/:id', '/settings/agent-employees/:id/developer',
  '/settings/agent-employees/:id/heartbeats', '/settings/agent-employees/:id/webhooks',
  '/settings/agent-employees/create', '/settings/ai', '/settings/api-access', '/settings/apps', '/settings/apps/:id',
  '/settings/apps/private-resources', '/settings/apps/private-resources/attachment-operator/:bindingId',
  '/settings/apps/private-resources/operator/:bindingId', '/settings/calendar', '/settings/groups',
  '/settings/integrations', '/settings/library', '/settings/mcp-access', '/settings/members', '/settings/modules',
  '/settings/profile', '/settings/projects', '/settings/tags', '/settings/teams', '/settings/workflows', '/setup',
  '/setup-ai', '/signup', '/skills', '/skills/:slug', '/tasks', '/two-step-setup', '/welcome',
];

const PATTERN_SEGMENTS = WEB_PAGE_PATTERNS.map((pattern) => pattern.split('/').slice(1).filter(Boolean));

/** The fixed folder names of the pages. */
export const WEB_PATH_WORDS: ReadonlySet<string> = new Set(
  PATTERN_SEGMENTS.flat().filter((segment) => !segment.startsWith(':')),
);
/** The pages' dynamic folder names ("id", "slug", ...). */
const WEB_PARAM_NAMES: ReadonlySet<string> = new Set(
  PATTERN_SEGMENTS.flat().filter((segment) => segment.startsWith(':')).map((segment) => segment.slice(1)),
);
/** The app's route groups. */
const ROUTE_GROUPS: ReadonlySet<string> = new Set(['(app)']);

/**
 * The page a path (or a template the browser made) is on, as its pattern, or
 * null when it matches no page. Fixed folders must match exactly; anything
 * may stand in a dynamic one. The most specific page wins.
 */
export function matchWebPage(rawPath: string): string | null {
  const path = rawPath.split(/[?#]/, 1)[0] ?? '';
  const parts = path.split('/').slice(1).filter(Boolean);
  let best: { pattern: string; fixed: number } | null = null;
  PATTERN_SEGMENTS.forEach((segments, index) => {
    if (segments.length !== parts.length) return;
    let fixed = 0;
    for (let i = 0; i < segments.length; i += 1) {
      if (segments[i]!.startsWith(':')) continue;
      if (segments[i] !== parts[i]) return;
      fixed += 1;
    }
    if (!best || fixed > best.fixed) best = { pattern: WEB_PAGE_PATTERNS[index]!, fixed };
  });
  return (best as { pattern: string } | null)?.pattern ?? null;
}

/** Next.js bundle folders that are not page folders. */
const BUNDLE_FOLDERS = new Set(['chunks', 'app', 'pages', 'css', 'media']);
/** Next.js bundle file names, before their content hash. */
const BUNDLE_FILES = new Set([
  'page', 'layout', 'template', 'loading', 'error', 'not-found', 'global-error', 'default', 'route',
  'main', 'main-app', 'webpack', 'framework', 'polyfills', 'app-pages-internals',
]);

/** A bundle folder: a known folder, a page's fixed folder, the app's route group, or one of its dynamic folders. */
function isBundleFolder(segment: string): boolean {
  if (BUNDLE_FOLDERS.has(segment) || WEB_PATH_WORDS.has(segment) || ROUTE_GROUPS.has(segment)) return true;
  const dynamic = /^\[(.{1,40})\]$/.exec(segment);
  return Boolean(dynamic && WEB_PARAM_NAMES.has(dynamic[1]!));
}

/**
 * A browser frame's file, if it is one of the web app's own bundles:
 * `_next/static/` then known folders, then a known file name or a numbered or
 * hex-named chunk, with any content hash. Returned with hashes and chunk names
 * replaced; else null.
 */
export function webBundlePath(pathname: string): string | null {
  let path: string;
  try { path = decodeURIComponent(pathname); } catch { return null; }
  path = path.replace(/^\/+/, '');
  if (!path.startsWith('_next/static/') || path.length > 300) return null;
  const segments = path.slice('_next/static/'.length).split('/');
  const fileName = segments.pop() ?? '';
  if (!segments.every(isBundleFolder)) return null;
  const match = /^(.+?)(?:-([0-9a-f]{6,}))?\.js$/.exec(fileName);
  if (!match) return null;
  const base = match[1]!;
  const hash = match[2] ? '-<hash>' : '';
  if (BUNDLE_FILES.has(base)) return `_next/static/${[...segments, `${base}${hash}.js`].join('/')}`;
  if (/^(?:\d{1,8}|[0-9a-f]{6,16})$/.test(base)) return `_next/static/${[...segments, `<chunk>${hash}.js`].join('/')}`;
  return null;
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
