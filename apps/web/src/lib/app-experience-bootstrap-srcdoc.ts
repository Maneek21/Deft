import { EXPERIENCE_BOOTSTRAP_SCRIPT } from './app-experience-bootstrap-script';

/** Host-supplied origin only; never author HTML or a message-learned origin. */
export async function buildExperienceBootstrapSrcdoc(parentOrigin: string): Promise<string> {
  const origin = new URL(parentOrigin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== parentOrigin) throw new Error('Invalid Experience parent origin');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(EXPERIENCE_BOOTSTRAP_SCRIPT)));
  const hash = btoa(String.fromCharCode(...digest));
  // srcdoc inherits the parent policy. This additional policy confines the child
  // and its Blob Worker; frame-ancestors is enforced by the parent header, not meta.
  const csp = `default-src 'none'; script-src 'sha256-${hash}'; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const escapedOrigin = parentOrigin.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="deft-experience-parent-origin" content="${escapedOrigin}"><script>${EXPERIENCE_BOOTSTRAP_SCRIPT}</script>`;
}
