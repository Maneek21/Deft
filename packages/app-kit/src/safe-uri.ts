/** Inert URI safety validation. Never resolves DNS or fetches a destination. */
const invalid = (): never => { throw Error('SAFE_RICH_TEXT_INVALID'); };
const unsafe = /[\u0000-\u0020\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ud800-\udfff\\]/u;
export function canonicalSafeUri(raw: string): string {
  if (typeof raw !== 'string' || !raw || unsafe.test(raw) || /\s/u.test(raw) || /%(?![a-f0-9]{2})/iu.test(raw)
    || new TextEncoder().encode(raw).byteLength > 4096) return invalid();
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return invalid(); }
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(decoded)) return invalid();
  let canonical: string;
  if (/^mailto:/iu.test(raw)) {
    // This is a URI target, never a list/header parser. No query, display name,
    // fragment, recipient expansion or header synthesis is admitted.
    if (/[?#]/u.test(raw.slice(7))) return invalid();
    const target = decoded.slice(7), at = target.lastIndexOf('@');
    if (target.length > 200 || at < 1 || at > 64
      || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/u.test(target)) return invalid();
    const local = target.slice(0, at), domain = target.slice(at + 1).toLowerCase();
    if (local.startsWith('.') || local.endsWith('.') || local.includes('..') || !domain.includes('.')
      || domain.split('.').some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))) return invalid();
    canonical = 'mailto:' + encodeURIComponent(`${local}@${domain}`).replaceAll('%40', '@');
  } else {
    let url: URL;
    try { url = new URL(raw); } catch { return invalid(); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || /^https?:\/\/[^/?#]*@/iu.test(raw)) return invalid();
    canonical = url.href;
  }
  if (new TextEncoder().encode(canonical).byteLength > 4096) return invalid();
  return canonical;
}
