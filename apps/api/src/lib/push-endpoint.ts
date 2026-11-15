// Browser push endpoints are URLs a member hands us; the server then sends
// requests to them. So, in every mode: https only, no credentials, port 443,
// and the hostname must resolve only to public addresses (the same rule as
// link previews and calendar feeds, lib/public-http-fetch.ts). The request
// is pinned to the checked address through an https.Agent whose lookup
// returns only that address; the Host header and TLS server name keep the
// original hostname. In hosted mode the endpoint must also belong to one of
// the known browser push services below.
import { Agent } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isHostedMode } from './hosted-mode.js';
import { isPublicFetchAddress, publicFetchDeps } from './public-http-fetch.js';

/** The browser push services a hosted cell will contact. Keep the list here only. */
export const KNOWN_PUSH_SERVICES = {
  // Google FCM (Chrome, Edge on Android), Mozilla autopush (Firefox), Apple (Safari).
  hosts: ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'],
  // Apple documents *.push.apple.com; Microsoft WNS (Edge on Windows) uses *.notify.windows.com.
  suffixes: ['.push.apple.com', '.notify.windows.com'],
} as const;

export const PUSH_ENDPOINT_REFUSED = 'PUSH_ENDPOINT_REFUSED';

export class PushEndpointRefusedError extends Error {
  readonly code = PUSH_ENDPOINT_REFUSED;
  constructor(message = 'This push endpoint is not allowed') {
    super(message);
    this.name = 'PushEndpointRefusedError';
  }
}

export function isKnownPushService(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  return (KNOWN_PUSH_SERVICES.hosts as readonly string[]).includes(host)
    || KNOWN_PUSH_SERVICES.suffixes.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

/** Shape checks that need no network: returns the parsed URL or throws. */
export function checkPushEndpointShape(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PushEndpointRefusedError();
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new PushEndpointRefusedError();
  if (url.port && url.port !== '443') throw new PushEndpointRefusedError();
  if (isHostedMode() && !isKnownPushService(url.hostname)) {
    throw new PushEndpointRefusedError('Only browser push services are allowed');
  }
  return url;
}

export type PinnedPushAddress = { address: string; family: 4 | 6 };

/** Resolves the endpoint's host; every answer must be a public address. */
export async function resolvePushEndpoint(endpoint: string): Promise<PinnedPushAddress> {
  const url = checkPushEndpointShape(endpoint);
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const literal = isIP(host);
  if (literal) {
    if (!isPublicFetchAddress(host)) throw new PushEndpointRefusedError();
    return { address: host, family: literal as 4 | 6 };
  }
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await publicFetchDeps.lookup(host);
  } catch {
    throw new PushEndpointRefusedError('The push endpoint could not be resolved');
  }
  if (answers.length === 0 || !answers.every((answer) => isPublicFetchAddress(answer.address))) {
    throw new PushEndpointRefusedError();
  }
  const first = answers[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/** An https.Agent that can connect only to the checked address. */
export function pinnedPushAgent(pinned: PinnedPushAddress): Agent {
  const lookup = ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  }) as unknown as LookupFunction;
  return new Agent({ lookup, keepAlive: false });
}

/** Check, resolve and pin in one step, for the places that are about to send. */
export async function pushAgentFor(endpoint: string): Promise<Agent> {
  return pinnedPushAgent(await resolvePushEndpoint(endpoint));
}
