// Server-side HTTP fetch for URLs that members supply (calendar feeds, link
// previews). Closed rule: http/https only, no userinfo, ports 80/443 only;
// the hostname is resolved once and EVERY answer must be a public unicast
// address; the connection is pinned to the validated address (Host header
// and TLS server name keep the original hostname); at most three redirects,
// each re-checked, never https -> http; entity bodies are capped while
// streaming (encoded and decoded); one deadline covers DNS, every hop and
// the body. Failures before a response surface as one neutral error.
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { isNeverAllowedMetadataAddress, isPublicNetworkAddress, normalizeMappedIPv4 } from '@deft/mcp';

export const PUBLIC_FETCH_MAX_REDIRECTS = 3;
const ALLOWED_PORTS = new Set([80, 443]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_PENDING_LOOKUPS = 32;
const CALENDAR_FEED_MAX_BYTES = 5 * 1024 * 1024;
const CALENDAR_FEED_TIMEOUT_MS = 20_000;

// IPv6 must sit inside global unicast 2000::/3 and outside the non-global
// special-purpose blocks below; the shared classifier then removes the rest.
const IPV6_GLOBAL_UNICAST = new BlockList();
IPV6_GLOBAL_UNICAST.addSubnet('2000::', 3, 'ipv6');
const IPV6_SPECIAL_PURPOSE = new BlockList();
IPV6_SPECIAL_PURPOSE.addSubnet('2001::', 23, 'ipv6');
IPV6_SPECIAL_PURPOSE.addSubnet('3fff::', 20, 'ipv6');

export type PublicFetchErrorKind = 'unreachable' | 'too_large' | 'timeout' | 'http_status' | 'bad_encoding';

const ERROR_MESSAGES: Record<Exclude<PublicFetchErrorKind, 'http_status'>, string> = {
  unreachable: 'Could not reach the URL',
  too_large: 'Response body too large',
  timeout: 'Request timed out',
  bad_encoding: 'Unsupported response encoding',
};

export class PublicFetchError extends Error {
  constructor(readonly kind: PublicFetchErrorKind, readonly status?: number) {
    super(kind === 'http_status' ? `HTTP ${status}` : ERROR_MESSAGES[kind]);
    this.name = 'PublicFetchError';
  }
}

export type PublicFetchDeps = {
  lookup: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request: (protocol: 'http:' | 'https:', options: RequestOptions & { servername?: string }) => ClientRequest;
};

/** Network seams; tests replace these fields. */
export const publicFetchDeps: PublicFetchDeps = {
  lookup: (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
  request: (protocol, options) => (protocol === 'https:' ? httpsRequest(options) : httpRequest(options)),
};

export type PublicFetchOptions = { maxBytes: number; timeoutMs: number; accept: string; userAgent: string };

export function isPublicFetchAddress(rawAddress: string): boolean {
  const address = normalizeMappedIPv4(rawAddress);
  const family = isIP(address);
  if (family === 0 || address.includes('%')) return false;
  if (isNeverAllowedMetadataAddress(address)) return false;
  if (family === 6 && (!IPV6_GLOBAL_UNICAST.check(address, 'ipv6') || IPV6_SPECIAL_PURPOSE.check(address, 'ipv6'))) {
    return false;
  }
  return isPublicNetworkAddress(address);
}

const unreachable = () => new PublicFetchError('unreachable');

function parseTarget(input: string, base?: URL): URL {
  let url: URL;
  try {
    url = base ? new URL(input, base) : new URL(input);
  } catch {
    throw unreachable();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw unreachable();
  if (url.username || url.password) throw unreachable();
  if (!ALLOWED_PORTS.has(targetPort(url))) throw unreachable();
  url.hash = '';
  return url;
}

function targetPort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
}

function bareHostname(url: URL): string {
  const host = url.hostname;
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

let pendingLookups = 0;

function untilDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new PublicFetchError('timeout'));
    const onAbort = () => reject(new PublicFetchError('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

type Pinned = { address: string; family: 4 | 6; literal: boolean };

/** Every validated address, in resolver order (at most four are tried). */
async function resolvePinned(url: URL, signal: AbortSignal): Promise<Pinned[]> {
  const hostname = bareHostname(url);
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!isPublicFetchAddress(hostname)) throw unreachable();
    return [{ address: hostname, family: literalFamily as 4 | 6, literal: true }];
  }
  if (pendingLookups >= MAX_PENDING_LOOKUPS) throw unreachable();
  pendingLookups += 1;
  const lookup = Promise.resolve()
    .then(() => publicFetchDeps.lookup(hostname))
    .finally(() => { pendingLookups -= 1; });
  lookup.catch(() => {});
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await untilDeadline(lookup, signal);
  } catch (err) {
    throw err instanceof PublicFetchError ? err : unreachable();
  }
  if (!answers.length || !answers.every((entry) => isPublicFetchAddress(entry.address))) throw unreachable();
  return answers.slice(0, 4).map((entry) => ({ address: entry.address, family: isIP(entry.address) as 4 | 6, literal: false }));
}

function requestOnce(
  url: URL,
  pinned: Pinned,
  options: PublicFetchOptions,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new PublicFetchError('timeout'));
    const protocol = url.protocol as 'http:' | 'https:';
    const req = publicFetchDeps.request(protocol, {
      method: 'GET',
      hostname: pinned.address,
      family: pinned.family,
      port: targetPort(url),
      path: `${url.pathname}${url.search}`,
      agent: false,
      headers: {
        host: url.host,
        accept: options.accept,
        'accept-encoding': 'identity',
        'user-agent': options.userAgent,
      },
      ...(protocol === 'https:' && !pinned.literal ? { servername: bareHostname(url).replace(/\.$/, '') } : {}),
    });
    const onAbort = () => {
      req.destroy();
      reject(new PublicFetchError('timeout'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    req.once('response', (res) => {
      signal.removeEventListener('abort', onAbort);
      resolve(res);
    });
    req.on('error', () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.aborted ? new PublicFetchError('timeout') : unreachable());
    });
    req.end();
  });
}

function decoderFor(encoding: string): Transform | null | undefined {
  switch (encoding) {
    case '':
    case 'identity': return null;
    case 'gzip':
    case 'x-gzip': return createGunzip();
    case 'deflate': return createInflate();
    case 'br': return createBrotliDecompress();
    default: return undefined;
  }
}

function readBody(res: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declared = Number(res.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.destroy();
    return Promise.reject(new PublicFetchError('too_large'));
  }
  const decoder = decoderFor(String(res.headers['content-encoding'] ?? '').trim().toLowerCase());
  if (decoder === undefined) {
    res.destroy();
    return Promise.reject(new PublicFetchError('bad_encoding'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let encodedBytes = 0;
    let decodedBytes = 0;
    let settled = false;
    const settle = (err: PublicFetchError | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      // Close the connection in every case: a decoder can end before the
      // HTTP body does, and nothing after this point is read or counted.
      res.destroy();
      decoder?.destroy();
      if (err) {
        reject(err);
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    };
    const onAbort = () => settle(new PublicFetchError('timeout'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    const onDecoded = (chunk: Buffer) => {
      if (settled) return;
      decodedBytes += chunk.length;
      if (decodedBytes > maxBytes) return settle(new PublicFetchError('too_large'));
      chunks.push(chunk);
    };
    res.on('data', (chunk: Buffer) => {
      if (settled) return;
      encodedBytes += chunk.length;
      if (encodedBytes > maxBytes) return settle(new PublicFetchError('too_large'));
      if (decoder) decoder.write(chunk);
      else onDecoded(chunk);
    });
    res.on('error', () => settle(unreachable()));
    res.once('close', () => {
      if (!res.complete) settle(signal.aborted ? new PublicFetchError('timeout') : unreachable());
    });
    if (decoder) {
      decoder.on('data', onDecoded);
      decoder.on('error', () => settle(new PublicFetchError('bad_encoding')));
      decoder.once('end', () => settle(null));
      res.once('end', () => decoder.end());
    } else {
      res.once('end', () => settle(null));
    }
  });
}

/** Fetch a member-supplied URL under the closed public-only rule above. */
export async function fetchPublicHttpText(
  rawUrl: string,
  options: PublicFetchOptions,
): Promise<{ text: string; contentType: string; url: string }> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  let url = parseTarget(rawUrl);
  for (let hop = 0; ; hop += 1) {
    let res: IncomingMessage | undefined;
    for (const pinned of await resolvePinned(url, signal)) {
      try {
        res = await requestOnce(url, pinned, options, signal);
        break;
      } catch (err) {
        if (!(err instanceof PublicFetchError) || err.kind !== 'unreachable') throw err;
      }
    }
    if (!res) throw unreachable();
    const status = res.statusCode ?? 0;
    if (REDIRECT_STATUSES.has(status)) {
      const location = res.headers.location;
      res.destroy();
      if (!location || hop >= PUBLIC_FETCH_MAX_REDIRECTS) throw unreachable();
      const next = parseTarget(location, url);
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw unreachable();
      url = next;
      continue;
    }
    if (status < 200 || status >= 300) {
      res.destroy();
      throw new PublicFetchError('http_status', status);
    }
    const text = await readBody(res, options.maxBytes, signal);
    return { text, contentType: String(res.headers['content-type'] ?? ''), url: url.href };
  }
}

/** Calendar feeds: `webcal://` is fetched as `https://`. */
export async function fetchCalendarFeedText(rawUrl: string): Promise<string> {
  const url = rawUrl.trim().replace(/^webcal:\/\//i, 'https://');
  const { text } = await fetchPublicHttpText(url, {
    maxBytes: CALENDAR_FEED_MAX_BYTES,
    timeoutMs: CALENDAR_FEED_TIMEOUT_MS,
    accept: 'text/calendar, text/plain, application/octet-stream, */*',
    userAgent: 'Deft-Calendar/1.0',
  });
  return text;
}
