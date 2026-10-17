import { EXPERIENCE_BOOTSTRAP_SCRIPT } from '@/lib/app-experience-bootstrap-script';

/** Network control for the same canonical trusted script used by srcdoc. */
export function GET() {
  return new Response(EXPERIENCE_BOOTSTRAP_SCRIPT, { headers: {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  } });
}
