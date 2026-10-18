import {isIP} from 'node:net';
// Same public-address ranges as the message-image proxy; kept in runtime source
// because the production API image does not contain examples/.
export function publicEmailServerAddress(address:string):boolean {
  if (isIP(address) === 4) {
    const [a=0, b=0, c=0] = address.split('.').map(Number);
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
