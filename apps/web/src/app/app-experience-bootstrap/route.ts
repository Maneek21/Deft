/** Trusted shell for the sandboxed opaque Experience Worker. No author code or
 * credentials are in the response; headers are fixed in next.config.ts. */
export function GET() {
  return new Response('<!doctype html><meta charset="utf-8"><script src="/app-experience-bootstrap.js" defer></script>', {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
