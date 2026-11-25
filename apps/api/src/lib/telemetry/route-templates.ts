/**
 * Route templates for telemetry: "/api/spaces/:id", never "/api/spaces/abc123".
 *
 * - A request the API answered: the template of the route that matched.
 * - A path the browser reports (a failed API call, or the page it was on):
 *   matched against the API's own route list, or reduced to the web app's
 *   known path words. Anything else in a path becomes ":param".
 */
import type { Context } from 'hono';
import { matchedRoutes } from 'hono/route';
import { scrubMethod, scrubRouteTemplate } from './scrub.js';
import { WEB_PATH_WORDS, addApiRouteWords } from './web-paths.js';

type RouteEntry = { method: string; path: string };

function isMiddlewarePath(path: string): boolean {
  return path === '*' || path === '/*' || path.endsWith('/*');
}

/** The template of the route that answered (not a middleware), or null. */
export function answeringRouteTemplate(c: Context): string | null {
  try {
    const routes = matchedRoutes(c);
    for (let i = routes.length - 1; i >= 0; i -= 1) {
      const route = routes[i]!;
      if (route.method === 'ALL' && isMiddlewarePath(route.path)) continue;
      // The matched route's own path is code, not request data: its words are route words.
      addApiRouteWords([route.path]);
      return scrubRouteTemplate(route.path);
    }
  } catch {
    // No match information (a response produced before routing).
  }
  return null;
}

let apiRoutes: RouteEntry[] = [];

/** index.ts hands over the mounted routes once they are all registered. */
export function setApiRouteTemplates(routes: ReadonlyArray<RouteEntry>): void {
  addApiRouteWords(routes.map((route) => route.path));
  apiRoutes = routes
    .filter((route) => route.method !== 'ALL' && !isMiddlewarePath(route.path) && route.path.startsWith('/api/'))
    .map((route) => ({ method: route.method, path: route.path }));
}

function segmentMatches(template: string, value: string): boolean {
  if (template.startsWith(':')) {
    if (value === '') return false;
    const regex = /\{(.+)\}\??$/.exec(template)?.[1];
    if (!regex) return true;
    try { return new RegExp(`^(?:${regex})$`).test(value); } catch { return false; }
  }
  return template === value;
}

/** Match a reported API path (no query) to one of the API's route templates. */
export function apiRouteTemplateFor(method: unknown, rawPath: unknown): string | null {
  const verb = scrubMethod(method);
  if (!verb || typeof rawPath !== 'string') return null;
  const path = rawPath.split(/[?#]/, 1)[0] ?? '';
  if (!path.startsWith('/api/') || path.length > 2048) return null;
  const parts = path.split('/').slice(1);
  let best: { path: string; statics: number } | null = null;
  for (const route of apiRoutes) {
    if (route.method !== verb) continue;
    const t = route.path.split('/').slice(1);
    if (t.length !== parts.length) continue;
    let statics = 0;
    let ok = true;
    for (let i = 0; i < t.length; i += 1) {
      if (!segmentMatches(t[i]!, parts[i]!)) { ok = false; break; }
      if (!t[i]!.startsWith(':')) statics += 1;
    }
    if (ok && (!best || statics > best.statics)) best = { path: route.path, statics };
  }
  return best ? scrubRouteTemplate(best.path) : null;
}

/**
 * The page a browser was on, as a template. The web app sends it with its
 * dynamic segments already named ("/modules/:slug", lib/error-telemetry.ts);
 * here a segment stays only if it is such a name or one of the app's fixed
 * folder names (web-paths.ts), and anything else becomes ":param".
 */
export function webPageTemplate(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/') || rawPath.length > 2048) return null;
  const path = rawPath.split(/[?#]/, 1)[0] ?? '';
  const segments = path.split('/').slice(1).map((segment) => (
    segment === '' || WEB_PATH_WORDS.has(segment) || /^:[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(segment) ? segment : ':param'
  ));
  return `/${segments.join('/')}`.slice(0, 200);
}
