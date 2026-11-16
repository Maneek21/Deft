import { NextResponse, type NextRequest } from 'next/server';

// Normalize old credential URLs before AppRouter can serialize their path or
// query token into its history tree. The destination uses the same fragment
// format as newly issued links; the page then captures it only in memory.
export function proxy(request: NextRequest) {
  const url = request.nextUrl;
  const invite = /^\/invite(?:\/([^/]+))?\/?$/.exec(url.pathname);
  const reset = /^\/reset-password\/?$/.test(url.pathname);
  if (!invite && !reset) return NextResponse.next();
  let token = url.searchParams.get('token');
  if (!token && invite?.[1]) {
    try { token = decodeURIComponent(invite[1]); }
    catch { return NextResponse.next(); }
  }
  if (!token) return NextResponse.next();
  const destination = url.clone();
  destination.pathname = invite ? '/invite' : '/reset-password';
  destination.search = '';
  destination.hash = new URLSearchParams({ token }).toString();
  const response = NextResponse.redirect(destination, 307);
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

export const config = { matcher: ['/invite', '/invite/:token', '/reset-password'] };
