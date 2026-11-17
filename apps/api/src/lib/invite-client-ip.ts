import { lookup } from 'node:dns/promises';
import { isIP, SocketAddress } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import { normalizeMappedIPv4 } from '@deft/mcp';
import type { Context } from 'hono';

type ProxyLookup = (hostname: string) => Promise<readonly { address: string }[]>;

function canonicalIp(value: string): string | null {
  const address = normalizeMappedIPv4(value);
  const family = isIP(address);
  if (!family || address.includes('%')) return null;
  return new SocketAddress({ address, family: family === 4 ? 'ipv4' : 'ipv6' }).address;
}

/** Shared client-address policy. No private/loopback range is implicitly trusted. */
export function createInviteClientKey(
  configured = process.env.DEFT_INVITE_TRUSTED_PROXIES ?? '',
  resolveProxy: ProxyLookup = hostname => lookup(hostname, { all: true }),
): (c: Context) => Promise<string> {
  const proxies = configured.split(',').map(value => value.trim()).filter(Boolean);
  return async c => {
    let peer: string | null;
    try { peer = canonicalIp(getConnInfo(c).remote.address ?? ''); }
    catch { return 'unknown'; }
    if (!peer) return 'unknown';
    // Only the immediate proxy's appended client is authoritative. Earlier
    // entries can be supplied by the caller; X-Real-IP is never consulted.
    const client = canonicalIp(c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() ?? '');
    if (!client) return peer;
    for (const proxy of proxies) {
      const address = canonicalIp(proxy);
      if (address === peer) return client;
      if (address) continue;
      try {
        // Resolve configured names on each request so Compose container IP
        // changes do not leave an old address trusted. DNS failure uses peer.
        if ((await resolveProxy(proxy)).some(answer => canonicalIp(answer.address) === peer)) return client;
      } catch { /* An unavailable proxy name does not grant header trust. */ }
    }
    return peer;
  };
}
