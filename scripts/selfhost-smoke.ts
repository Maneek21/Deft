import 'dotenv/config';

const args = new Set(process.argv.slice(2));

type Check = {
  name: string;
  ok: boolean;
  detail: string;
  warn?: boolean;
};

const API_URL = (process.env.DEFT_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const MCP_URL = `${API_URL}/api/mcp/v1`;
const CLIENT_NAME = process.env.DEFT_SMOKE_CLIENT_NAME || `Deft self-host smoke ${new Date().toISOString()}`;
const REDIRECT_URI = process.env.DEFT_SMOKE_REDIRECT_URI || 'http://localhost:3999/callback';
const REQUESTED_SCOPE = process.env.DEFT_SMOKE_SCOPE || 'read:workspace read:wiki read:tasks read:messages read:calendar';
const OPTIONAL_BEARER = process.env.DEFT_MCP_BEARER_TOKEN || process.env.DEFT_SMOKE_MCP_TOKEN || '';
const REQUIRE_AUTH = args.has('--require-auth') || process.env.DEFT_REQUIRE_AUTH_SMOKE === '1';

function mark(check: Check) {
  const icon = check.ok ? (check.warn ? 'WARN' : 'OK') : 'FAIL';
  console.log(`[${icon}] ${check.name}: ${check.detail}`);
}

async function fetchText(url: string, init?: RequestInit): Promise<{ status: number; text: string; headers: Headers | null }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    return { status: res.status, text: await res.text().catch(() => ''), headers: res.headers };
  } catch (err) {
    return { status: 0, text: err instanceof Error ? err.message : String(err), headers: null };
  }
}

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<{ status: number; json: T | null; text: string; headers: Headers | null }> {
  const res = await fetchText(url, init);
  try {
    return { ...res, json: JSON.parse(res.text) as T };
  } catch {
    return { ...res, json: null };
  }
}

async function checkHealth(): Promise<Check> {
  const res = await fetchText(`${API_URL}/health`);
  return {
    name: 'API health',
    ok: res.status === 200,
    detail: res.status === 200 ? `${API_URL}/health returned 200` : `${API_URL}/health returned ${res.status}: ${res.text.slice(0, 160)}`,
  };
}

async function checkProtectedResource(): Promise<Check> {
  const res = await fetchJson(`${API_URL}/.well-known/oauth-protected-resource`);
  const body = res.json as any;
  const ok = res.status === 200
    && body?.resource === MCP_URL
    && Array.isArray(body?.authorization_servers)
    && body.authorization_servers.includes(API_URL);
  return {
    name: 'OAuth protected resource metadata',
    ok,
    detail: ok
      ? `resource=${body.resource}; issuer=${body.authorization_servers[0]}`
      : `expected resource ${MCP_URL} and issuer ${API_URL}; got ${res.status}: ${res.text.slice(0, 180)}`,
  };
}

async function checkAuthorizationServer(): Promise<Check> {
  const res = await fetchJson(`${API_URL}/.well-known/oauth-authorization-server`);
  const body = res.json as any;
  const ok = res.status === 200
    && body?.issuer === API_URL
    && body?.token_endpoint === `${API_URL}/oauth/token`
    && body?.registration_endpoint === `${API_URL}/oauth/register`
    && Array.isArray(body?.code_challenge_methods_supported)
    && body.code_challenge_methods_supported.includes('S256');
  return {
    name: 'OAuth authorization-server metadata',
    ok,
    detail: ok
      ? `issuer=${body.issuer}; registration=${body.registration_endpoint}`
      : `metadata mismatch ${res.status}: ${res.text.slice(0, 180)}`,
  };
}

async function checkDynamicClientRegistration(): Promise<Check> {
  const res = await fetchJson(`${API_URL}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URI],
      scope: REQUESTED_SCOPE,
    }),
  });
  const body = res.json as any;
  const ok = res.status === 201 && typeof body?.client_id === 'string' && body.client_id.startsWith('deft_dcr_');
  return {
    name: 'OAuth dynamic client registration',
    ok,
    detail: ok
      ? `registered ${body.client_id} with scope "${body.scope}"`
      : `registration returned ${res.status}: ${res.text.slice(0, 180)}`,
  };
}

async function checkMcpInitialize(): Promise<Check> {
  const res = await fetchJson(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'smoke-init', method: 'initialize', params: {} }),
  });
  const body = res.json as any;
  const ok = res.status === 200 && body?.result?.serverInfo?.name === 'deft-mcp';
  return {
    name: 'MCP initialize',
    ok,
    detail: ok ? `server=${body.result.serverInfo.name}; protocol=${body.result.protocolVersion}` : `initialize returned ${res.status}: ${res.text.slice(0, 180)}`,
  };
}

async function checkProtectedToolsList(): Promise<Check> {
  const res = await fetchJson(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'smoke-tools-denied', method: 'tools/list', params: {} }),
  });
  const challenge = res.headers?.get('www-authenticate') ?? '';
  const metadataUrl = `${API_URL}/.well-known/oauth-protected-resource`;
  const ok = res.status === 401 && challenge.includes('Bearer') && challenge.includes(metadataUrl);
  return {
    name: 'MCP protected tools/list',
    ok,
    detail: ok
      ? 'unauthenticated tools/list is denied with OAuth resource challenge'
      : `expected 401 with OAuth metadata challenge ${metadataUrl}; got ${res.status}, challenge="${challenge}", body=${res.text.slice(0, 160)}`,
  };
}

async function checkOptionalBearerToolsList(): Promise<Check> {
  if (!OPTIONAL_BEARER) {
    return {
      name: 'Optional bearer MCP flow',
      ok: !REQUIRE_AUTH,
      warn: !REQUIRE_AUTH,
      detail: REQUIRE_AUTH
        ? 'DEFT_MCP_BEARER_TOKEN not set; authenticated tools/list smoke is required'
        : 'DEFT_MCP_BEARER_TOKEN not set; skipped authenticated tools/list smoke. Set DEFT_REQUIRE_AUTH_SMOKE=1 or pass --require-auth to make this a failure.',
    };
  }
  const res = await fetchJson(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPTIONAL_BEARER}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'smoke-tools-auth', method: 'tools/list', params: {} }),
  });
  const body = res.json as any;
  const tools = body?.result?.tools;
  const ok = res.status === 200 && Array.isArray(tools) && tools.length > 0;
  return {
    name: 'Optional bearer MCP flow',
    ok,
    detail: ok ? `authenticated tools/list returned ${tools.length} tool(s)` : `authenticated tools/list returned ${res.status}: ${res.text.slice(0, 180)}`,
  };
}

async function main() {
  console.log('Deft self-host smoke');
  console.log(`  api: ${API_URL}`);
  console.log(`  mcp: ${MCP_URL}`);
  console.log(`  authenticated tools/list: ${REQUIRE_AUTH ? 'required' : 'optional'}`);
  console.log('');

  const checks = [
    await checkHealth(),
    await checkProtectedResource(),
    await checkAuthorizationServer(),
    await checkDynamicClientRegistration(),
    await checkMcpInitialize(),
    await checkProtectedToolsList(),
    await checkOptionalBearerToolsList(),
  ];

  for (const check of checks) mark(check);
  if (!checks.every((check) => check.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
