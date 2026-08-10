import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home",
  ".lan",
];
const METADATA_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.azure.internal",
  "instance-data.ec2.internal",
  "metadata.packet.net",
]);
const NEVER_ALLOWED_METADATA_ADDRESSES = new Set([
  '100.100.100.200',
  '168.63.129.16',
  '169.254.169.254',
  '169.254.170.2',
  '169.254.170.23',
  '192.80.8.124',
  'fd00:ec2::23',
  'fd00:ec2::254',
]);

function normalizeHostname(hostname: string): string {
  const withoutTrailingDot = hostname.toLowerCase().replace(/\.$/, "");
  return withoutTrailingDot.startsWith("[") && withoutTrailingDot.endsWith("]")
    ? withoutTrailingDot.slice(1, -1)
    : withoutTrailingDot;
}

function ipv4Bytes(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ? bytes
    : null;
}

function ipv6Bytes(address: string): number[] | null {
  const withoutZone = address.toLowerCase().split("%")[0]!;
  const halves = withoutZone.split("::");
  if (halves.length > 2) return null;

  const parseHalf = (value: string): number[] | null => {
    if (!value) return [];
    const words: number[] = [];
    for (const part of value.split(":")) {
      if (part.includes(".")) {
        const v4 = ipv4Bytes(part);
        if (!v4) return null;
        words.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      words.push(Number.parseInt(part, 16));
    }
    return words;
  };

  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(Math.max(0, missing)).fill(0), ...right];
  if (words.length !== 8) return null;
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}

function isNeverAllowedMetadataAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (NEVER_ALLOWED_METADATA_ADDRESSES.has(normalized)) return true;
  const candidate = ipv6Bytes(normalized);
  if (!candidate) return false;
  return ['fd00:ec2::23', 'fd00:ec2::254'].some((target) => {
    const expected = ipv6Bytes(target)!;
    return candidate.every((byte, index) => byte === expected[index]);
  });
}

/** Return true only for globally routable unicast addresses. */
export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const bytes = ipv4Bytes(address)!;
    const [a, b, c] = bytes;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b! >= 64 && b! <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b! >= 16 && b! <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    if (a! >= 224) return false;
    return true;
  }

  if (family === 6) {
    const bytes = ipv6Bytes(address);
    if (!bytes) return false;
    const allZero = bytes.every((byte) => byte === 0);
    const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
    if (allZero || loopback) return false;
    // IPv4-mapped IPv6: apply the IPv4 policy to the embedded address.
    if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
      return isPublicNetworkAddress(bytes.slice(12).join("."));
    }
    if ((bytes[0]! & 0xfe) === 0xfc) return false; // fc00::/7 unique-local
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return false; // fec0::/10 deprecated site-local
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return false; // fe80::/10 link-local
    if (bytes[0] === 0xff) return false; // multicast
    if (bytes[0] === 0x01 && bytes.slice(1, 8).every((byte) => byte === 0)) return false; // 100::/64 discard
    if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return false; // NAT64
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return false; // Teredo
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x02) return false; // benchmarking
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false; // documentation
    if (bytes[0] === 0x20 && bytes[1] === 0x02) return false; // 6to4 can tunnel private IPv4
    return true;
  }

  return false;
}

/** Exact host-operator exceptions may reach ordinary loopback/RFC1918/ULA
 * services, but never link-local, metadata, CGNAT, multicast, or reserved
 * destinations. */
export function isAllowedSelfHostedPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = ipv4Bytes(address)!;
    return a === 127
      || a === 10
      || (a === 172 && b! >= 16 && b! <= 31)
      || (a === 192 && b === 168);
  }
  if (family === 6) {
    const bytes = ipv6Bytes(address);
    if (!bytes) return false;
    const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
    if (loopback || (bytes[0]! & 0xfe) === 0xfc) return true;
    if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
      return isAllowedSelfHostedPrivateAddress(bytes.slice(12).join('.'));
    }
  }
  return false;
}

function privateOriginAllowlist(): Set<string> {
  if (process.env.DEFT_SELF_HOSTED !== "true") return new Set();
  return new Set((process.env.DEFT_MCP_PRIVATE_ORIGIN_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      try {
        return [new URL(entry).origin];
      } catch {
        return [];
      }
    }));
}

function isMetadataTarget(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (METADATA_HOSTNAMES.has(normalized)) return true;
  if (isIP(normalized)) return isNeverAllowedMetadataAddress(normalized);
  return false;
}

export function validateMcpHttpHostname(hostname: string): string | null {
  const normalized = normalizeHostname(hostname);
  if (isMetadataTarget(normalized)) return "Cloud metadata targets are never allowed for MCP connectors";
  if (!normalized || normalized === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return "MCP server host must be a public network destination";
  }
  if (isIP(normalized) && !isPublicNetworkAddress(normalized)) {
    return "MCP server host must not use a loopback, private, link-local, multicast, or reserved address";
  }
  return null;
}

export function validateMcpHttpUrl(url: URL): string | null {
  if (isMetadataTarget(url.hostname)) return "Cloud metadata targets are never allowed for MCP connectors";
  if (privateOriginAllowlist().has(url.origin)) return null;
  if (url.protocol !== "https:") return "MCP HTTP connectors require https unless the host explicitly allowlists an exact self-hosted origin";
  return validateMcpHttpHostname(url.hostname);
}

export function isStdioCommandAllowed(command: string): boolean {
  if (process.env.DEFT_SELF_HOSTED !== "true" || process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO !== "true") {
    return false;
  }
  const allowed = (process.env.MCP_STDIO_ALLOWED_COMMANDS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return allowed.includes(command.trim());
}

async function resolvePinnedAddress(url: URL): Promise<{ address: string; family: 4 | 6 }> {
  const hostname = normalizeHostname(url.hostname);
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("MCP server hostname did not resolve");
  if (addresses.some((entry) => isNeverAllowedMetadataAddress(entry.address))) {
    throw new Error("MCP server hostname resolved to a cloud metadata or credential endpoint");
  }
  const privateOriginAllowed = privateOriginAllowlist().has(url.origin) && !isMetadataTarget(hostname);
  const unsafeAddress = addresses.find((entry) => (
    !isPublicNetworkAddress(entry.address)
    && !(privateOriginAllowed && isAllowedSelfHostedPrivateAddress(entry.address))
  ));
  if (unsafeAddress) {
    throw new Error("MCP server hostname resolved to a disallowed private, link-local, metadata, or reserved address");
  }
  return addresses[0]! as { address: string; family: 4 | 6 };
}

/**
 * Fetch implementation for MCP transports that pins each request to a DNS
 * result validated immediately beforehand. Redirects are deliberately not
 * followed, preventing redirect and DNS-rebinding SSRF into the API host.
 */
async function secureMcpFetchForOrigin(
  allowedOrigin: string,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MCP transport only supports http and https URLs");
  }
  if (url.origin !== allowedOrigin) throw new Error("MCP transport refused a cross-origin endpoint or redirect");
  const targetError = validateMcpHttpUrl(url);
  if (targetError) throw new Error(targetError);
  const pinned = await resolvePinnedAddress(url);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  const unsafeForwardedHeaders = new Set([
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "forwarded",
    "x-http-method-override",
    "x-method-override",
    "x-original-host",
    "x-original-method",
    "x-original-url",
    "x-rewrite-url",
  ]);
  const headers = Object.fromEntries(
    [...request.headers.entries()].filter(([name]) => {
      const normalized = name.toLowerCase();
      return !unsafeForwardedHeaders.has(normalized)
        && !normalized.startsWith("x-forwarded-")
        && !normalized.startsWith("x-original-");
    }),
  );
  headers.host = url.host;

  return new Promise<Response>((resolve, reject) => {
    if (request.signal.aborted) {
      reject(new DOMException("The operation was aborted", "AbortError"));
      return;
    }

    const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = requester({
      protocol: url.protocol,
      hostname: pinned.address,
      family: pinned.family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: request.method,
      headers,
      ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
    }, (incoming) => {
      if ((incoming.statusCode ?? 0) >= 300 && (incoming.statusCode ?? 0) < 400) {
        incoming.resume();
        reject(new Error("MCP transport redirects are disabled; configure the canonical same-origin endpoint"));
        return;
      }
      const responseHeaders = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
      }
      const responseBody = request.method === "HEAD"
        ? null
        : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(responseBody, {
        status: incoming.statusCode ?? 500,
        statusText: incoming.statusMessage,
        headers: responseHeaders,
      }));
    });

    const abort = () => outgoing.destroy(new DOMException("The operation was aborted", "AbortError"));
    request.signal.addEventListener("abort", abort, { once: true });
    outgoing.once("close", () => request.signal.removeEventListener("abort", abort));
    outgoing.once("error", reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

export function createSecureMcpFetch(baseUrl: string | URL) {
  const allowedOrigin = new URL(baseUrl).origin;
  return (input: RequestInfo | URL, init?: RequestInit) => secureMcpFetchForOrigin(allowedOrigin, input, init);
}
