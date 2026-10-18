import {validateNativeComposeRaster} from '@deft/app-kit/experience';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const denied = () => Object.assign(new Error('APP_IMAGE_UNAVAILABLE'), { code: 'APP_IMAGE_UNAVAILABLE' });

export function publicImageAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 192 && b === 0 && c === 2) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  // Accept native global unicast only. Mapped/compatible IPv4, scoped/link-local,
  // multicast, ULA, translation/tunnelling and documentation ranges stay denied.
  const prefix = normalized.split(':');
  const second = Number.parseInt(prefix[1] || '0', 16);
  return /^[23][0-9a-f]{3}:/u.test(normalized)
    && !(prefix[0] === '2001' && (second < 0x200 || second === 0xdb8))
    && prefix[0] !== '2002' && prefix[0] !== '3fff';
}

export function publicImageUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\u0000-\u0020\u007f\\]/u.test(raw)) throw denied();
  let url;
  try { url = new URL(raw); } catch { throw denied(); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !url.hostname || url.hostname.endsWith('.') || url.hostname.includes('%')) throw denied();
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  if (isIP(hostname) && !publicImageAddress(hostname)) throw denied();
  url.hash = '';
  return url;
}

export function validMessageImage(bytes,type){return validateNativeComposeRaster(bytes,type,'received');}
/** Native outgoing validation has no URL or received-budget widening. */
export function validNativeOutgoingImage(bytes,type){return validateNativeComposeRaster(bytes,type,'outgoing');}

function pinnedRequest(url, address, signal) {
  return new Promise((resolve, reject) => {
    const pending = request(url, {
      method: 'GET', signal, agent: false, maxHeaderSize: 16384,
      // Do not copy caller, provider or application headers, cookies or credentials.
      headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp', 'User-Agent': 'Deft-Message-Image/1' },
      lookup: (_host, options, callback) => options.all
        ? callback(null, [{ address: address.address, family: address.family }])
        : callback(null, address.address, address.family),
      rejectUnauthorized: true,
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        response.destroy(); resolve({ redirect: location }); return;
      }
      const type = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const length = response.headers['content-length'];
      if (response.statusCode !== 200 || !TYPES.has(type)
        || (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > MAX_BYTES))
        || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        response.destroy(); reject(denied()); return;
      }
      const chunks = []; let total = 0;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_BYTES) { response.destroy(denied()); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const bytes = Buffer.concat(chunks, total);
        if (!validMessageImage(bytes, type)) reject(denied());
        else resolve({ media_type: type, bytes });
      });
    });
    pending.on('error', reject); pending.end();
  });
}

// The integration caller resolves a source-digest-bound nomination after current
// owner/account/exposure checks. This is intentionally not a raw-URL API route.
export async function fetchPublicMessageImage(authoritativeUrl, { signal, recheck } = {}, dependencies = {}) {
  const resolve = dependencies.lookup ?? lookup;
  const fetch = dependencies.request ?? pinnedRequest;
  const deadline = AbortSignal.timeout(8000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    if (typeof recheck !== 'function') throw denied();
    const current = async () => { combined.throwIfAborted(); if (await recheck() !== true) throw denied(); combined.throwIfAborted(); };
    let url = publicImageUrl(authoritativeUrl);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      await current();
      const host = url.hostname.replace(/^\[|\]$/gu, '');
      const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await new Promise((accept, reject) => {
        const abort = () => reject(denied());
        combined.addEventListener('abort', abort, { once: true });
        Promise.resolve(resolve(host, { all: true, verbatim: true })).then(accept, reject)
          .finally(() => combined.removeEventListener('abort', abort));
      });
      combined.throwIfAborted();
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(row => !publicImageAddress(row.address) || row.family !== isIP(row.address))) throw denied();
      await current();
      const result = await fetch(url, addresses[0], combined);
      try {
        await current();
        if (result.redirect !== undefined) {
          if (redirects === 3 || typeof result.redirect !== 'string') throw denied();
          url = publicImageUrl(new URL(result.redirect, url).href); continue;
        }
        if (!validMessageImage(result.bytes, result.media_type)) throw denied();
        return { media_type: result.media_type, bytes: result.bytes };
      } catch (error) { result.bytes?.fill(0); throw error; }
    }
    throw denied();
  } catch { throw denied(); }
}
