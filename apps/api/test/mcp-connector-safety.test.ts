import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  MCPClientManager,
  clientOptionsForTransport,
  createSecureMcpFetch,
  isAllowedSelfHostedPrivateAddress,
  isPublicNetworkAddress,
  type MCPConnectionConfig,
} from '@deft/mcp';
import {
  mcpCredentialInputSchema,
  migrateLegacyMcpCredential,
  redactMcpConnection,
  resolveMcpRuntimeAuth,
  storeMcpCredential,
} from '../src/lib/mcp-connection-auth.js';
import { validateMcpConnectionTarget } from '../src/lib/mcp-connection-validation.js';
import { resolveEncryptionKey } from '../src/lib/env.js';
import {
  configuredMcpApprovalTier,
  canonicalMcpToolName,
  mergeMcpToolOverrides,
  isMcpToolEnabled,
  mcpResultPayload,
} from '../src/lib/mcp-tools.js';
import { mcpConnectionRoutes } from '../src/routes/mcp-connections.js';
import { isAgentToolDisabled } from '../src/lib/agent-tool-policy.js';

const connectionConfig: MCPConnectionConfig = {
  connectionId: 'conn-test',
  connectionSlug: 'test',
  orgId: 'org-test',
  transport: 'streamable-http',
  url: 'https://mcp.example.test/mcp',
};

test('Streamable HTTP and stdio negotiate MCP versions while deprecated SSE stays legacy', () => {
  assert.deepEqual(
    clientOptionsForTransport('streamable-http').versionNegotiation,
    { mode: 'auto' },
  );
  assert.equal(clientOptionsForTransport('sse').versionNegotiation, undefined);
  assert.deepEqual(
    clientOptionsForTransport('stdio').versionNegotiation,
    { mode: 'auto' },
  );
});

test('tool-level MCP errors retain complete content and use the SDK timeout', async (t) => {
  const manager = new MCPClientManager();
  t.after(() => manager.shutdown());

  const rawResult = {
    content: [{ type: 'text' as const, text: 'upstream validation failed' }],
    structuredContent: { code: 'INVALID_INPUT' },
    isError: true,
    _meta: { trace_id: 'trace-1' },
  };
  let timeout: number | undefined;

  (manager as unknown as { connect: () => Promise<unknown> }).connect = async () => ({
    callTool: async (_params: unknown, options: { timeout?: number }) => {
      timeout = options.timeout;
      return rawResult;
    },
  });

  const result = await manager.executeTool(connectionConfig, 'write_record', { value: 1 });

  assert.equal(timeout, 30_000);
  assert.equal(result.success, false);
  assert.equal(result.error, 'upstream validation failed');
  assert.deepEqual(result.content, rawResult.content);
  assert.deepEqual(result.structuredContent, rawResult.structuredContent);
  assert.deepEqual(result.meta, rawResult._meta);
  assert.equal(result.rawResult, rawResult);
});

test('failed tool calls are not blindly retried', async (t) => {
  const manager = new MCPClientManager();
  t.after(() => manager.shutdown());
  let calls = 0;

  (manager as unknown as { connect: () => Promise<unknown> }).connect = async () => ({
    callTool: async () => {
      calls++;
      throw new Error('upstream unavailable');
    },
  });

  const result = await manager.executeTool(connectionConfig, 'non_idempotent_write', {});
  assert.equal(calls, 1);
  assert.equal(result.success, false);
  assert.equal(result.error, 'upstream unavailable');
});

test('transport failures evict dead clients and preserve backoff across reconnects', async (t) => {
  const manager = new MCPClientManager();
  t.after(() => manager.shutdown());
  let connections = 0;
  let closes = 0;

  (manager as any).connectFreshClient = async () => {
    connections++;
    return {
      callTool: async () => {
        if (connections === 1) throw new Error('transport disconnected');
        return { content: [{ type: 'text', text: 'fresh connection' }] };
      },
      close: async () => { closes++; },
    };
  };

  const first = await manager.executeTool(connectionConfig, 'read_record', {});
  const second = await manager.executeTool(connectionConfig, 'read_record', {});

  assert.equal(first.success, false);
  assert.equal(second.success, true);
  assert.equal(connections, 2);
  assert.equal(closes, 1);
});

test('three consecutive connection failures trigger a persistent backoff', async (t) => {
  const manager = new MCPClientManager();
  t.after(() => manager.shutdown());
  let connectionAttempts = 0;

  (manager as any).connectFreshClient = async () => {
    connectionAttempts++;
    throw new Error('upstream offline');
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await manager.executeTool(connectionConfig, 'read_record', {});
    assert.equal(result.success, false);
  }
  const backedOff = await manager.executeTool(connectionConfig, 'read_record', {});
  assert.equal(backedOff.success, false);
  assert.match(backedOff.error ?? '', /in backoff/);
  assert.equal(connectionAttempts, 3);
});

test('tool discovery explicitly bypasses the SDK response cache', async (t) => {
  const manager = new MCPClientManager();
  t.after(() => manager.shutdown());
  let listOptions: unknown;

  (manager as any).connect = async () => ({
    listTools: async (_params: unknown, options: unknown) => {
      listOptions = options;
      return { tools: [] };
    },
  });

  await manager.discoverTools(connectionConfig);
  assert.deepEqual(listOptions, { cacheMode: 'refresh' });
});

test('credentials are encrypted at rest, redacted in responses, and materialized only at runtime', () => {
  const secret = 'top-secret-api-key';
  const stored = storeMcpCredential({ secret });

  assert.notEqual(stored.secret_encrypted, secret);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(secret));

  const redacted = redactMcpConnection({
    id: 'conn-1',
    auth_type: 'api_key',
    auth_config_encrypted: stored,
  });
  const serialized = JSON.stringify(redacted);
  assert.equal(Object.hasOwn(redacted, 'auth_config_encrypted'), false);
  assert.equal(redacted.has_credentials, true);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, new RegExp(stored.secret_encrypted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  assert.deepEqual(
    resolveMcpRuntimeAuth('api_key', stored, 'streamable-http'),
    { headers: { Authorization: `Bearer ${secret}` } },
  );

  const custom = storeMcpCredential({
    secret,
    header_name: 'X-API-Key',
    scheme: null,
    env_var: 'CUSTOM_MCP_TOKEN',
  });
  assert.deepEqual(
    resolveMcpRuntimeAuth('api_key', custom, 'sse'),
    { headers: { 'X-API-Key': secret } },
  );
  assert.deepEqual(
    resolveMcpRuntimeAuth('api_key', custom, 'stdio'),
    { env: { CUSTOM_MCP_TOKEN: secret } },
  );
});

test('legacy plaintext credentials migrate and unsafe header names are rejected', () => {
  const migrated = migrateLegacyMcpCredential({ api_key: 'legacy-secret' });
  assert.ok(migrated);
  assert.doesNotMatch(JSON.stringify(migrated), /legacy-secret/);
  assert.deepEqual(
    resolveMcpRuntimeAuth('api_key', migrated, 'streamable-http'),
    { headers: { Authorization: 'Bearer legacy-secret' } },
  );

  assert.equal(
    mcpCredentialInputSchema.safeParse({
      secret: 'secret',
      header_name: 'Authorization\r\nX-Injected',
    }).success,
    false,
  );
  for (const headerName of [
    'Host',
    'Content-Length',
    'Transfer-Encoding',
    'Connection',
    'Mcp-Session-Id',
    'Forwarded',
    'X-Forwarded-Host',
    'X-Original-URL',
    'X-Rewrite-URL',
    'X-HTTP-Method-Override',
  ]) {
    assert.equal(
      mcpCredentialInputSchema.safeParse({ secret: 'secret', header_name: headerName }).success,
      false,
      headerName,
    );
  }
});

test('transport validation rejects incoherent or credential-bearing targets', () => {
  assert.equal(validateMcpConnectionTarget({
    transport: 'streamable-http',
    serverUrl: 'https://mcp.example.test/mcp',
    stdioCommand: null,
    stdioArgs: null,
  }), null);

  assert.match(validateMcpConnectionTarget({
    transport: 'streamable-http',
    serverUrl: 'https://user:secret@mcp.example.test/mcp',
    stdioCommand: null,
    stdioArgs: null,
  }) ?? '', /cannot contain credentials/);

  assert.match(validateMcpConnectionTarget({
    transport: 'streamable-http',
    serverUrl: 'https://mcp.example.test/mcp?token=plaintext',
    stdioCommand: null,
    stdioArgs: null,
  }) ?? '', /cannot include query parameters/);

  assert.match(validateMcpConnectionTarget({
    transport: 'stdio',
    serverUrl: null,
    stdioCommand: 'node',
    stdioArgs: ['server.js', '--api-key=plaintext'],
  }) ?? '', /encrypted environment-variable/);

  assert.match(validateMcpConnectionTarget({
    transport: 'stdio',
    serverUrl: null,
    stdioCommand: '',
    stdioArgs: [],
  }) ?? '', /requires a command/);
});

test('connector network policy blocks local, private, metadata, reserved, and insecure targets', () => {
  for (const serverUrl of [
    'https://127.0.0.1/mcp',
    'https://2130706433/mcp',
    'https://10.1.2.3/mcp',
    'https://172.16.0.1/mcp',
    'https://192.168.1.1/mcp',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/mcp',
    'https://[fc00::1]/mcp',
    'https://metadata.google.internal/mcp',
    'http://mcp.example.com/mcp',
  ]) {
    assert.notEqual(validateMcpConnectionTarget({
      transport: 'streamable-http',
      serverUrl,
      stdioCommand: null,
      stdioArgs: null,
    }), null, serverUrl);
  }
  assert.equal(validateMcpConnectionTarget({
    transport: 'streamable-http',
    serverUrl: 'https://mcp.example.com/mcp',
    stdioCommand: null,
    stdioArgs: null,
  }), null);

  for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.1.1', '192.168.1.1', '::1', 'fc00::1', 'fec0::1', 'fe80::1']) {
    assert.equal(isPublicNetworkAddress(address), false, address);
  }
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '::1', 'fc00::1']) {
    assert.equal(isAllowedSelfHostedPrivateAddress(address), true, address);
  }
  for (const address of ['100.64.0.1', '169.254.169.254', '169.254.170.2', 'fe80::1', 'fec0::1']) {
    assert.equal(isAllowedSelfHostedPrivateAddress(address), false, address);
  }
  for (const serverUrl of [
    'https://168.63.129.16/mcp',
    'https://192.80.8.124/mcp',
    'https://[fd00:ec2::23]/mcp',
    'https://[fd00:ec2::254]/mcp',
  ]) {
    assert.notEqual(validateMcpConnectionTarget({
      transport: 'streamable-http',
      serverUrl,
      stdioCommand: null,
      stdioArgs: null,
    }), null, serverUrl);
  }
  assert.equal(isPublicNetworkAddress('8.8.8.8'), true);
  assert.equal(isPublicNetworkAddress('2606:4700:4700::1111'), true);
});

test('stdio requires an explicit self-host unsafe opt-in and exact command allowlist', () => {
  const prior = {
    selfHosted: process.env.DEFT_SELF_HOSTED,
    unsafe: process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO,
    commands: process.env.MCP_STDIO_ALLOWED_COMMANDS,
  };
  try {
    delete process.env.DEFT_SELF_HOSTED;
    delete process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO;
    process.env.MCP_STDIO_ALLOWED_COMMANDS = 'node';
    assert.match(validateMcpConnectionTarget({
      transport: 'stdio', serverUrl: null, stdioCommand: 'node', stdioArgs: ['server.js'],
    }) ?? '', /not allowed/);

    process.env.DEFT_SELF_HOSTED = 'true';
    process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO = 'true';
    assert.equal(validateMcpConnectionTarget({
      transport: 'stdio', serverUrl: null, stdioCommand: 'node', stdioArgs: ['server.js'],
    }), null);
    assert.match(validateMcpConnectionTarget({
      transport: 'stdio', serverUrl: null, stdioCommand: 'powershell', stdioArgs: [],
    }) ?? '', /not allowed/);
  } finally {
    if (prior.selfHosted === undefined) delete process.env.DEFT_SELF_HOSTED;
    else process.env.DEFT_SELF_HOSTED = prior.selfHosted;
    if (prior.unsafe === undefined) delete process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO;
    else process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO = prior.unsafe;
    if (prior.commands === undefined) delete process.env.MCP_STDIO_ALLOWED_COMMANDS;
    else process.env.MCP_STDIO_ALLOWED_COMMANDS = prior.commands;
  }
});

test('guarded MCP fetch pins the configured origin and never follows redirects', async () => {
  let redirectedTargetHits = 0;
  let observedHost = '';
  const server = createServer((request, response) => {
    if (request.url === '/redirected') redirectedTargetHits++;
    if (request.url === '/headers') observedHost = request.headers.host ?? '';
    response.statusCode = request.url === '/start' ? 302 : 200;
    if (request.url === '/start') response.setHeader('Location', '/redirected');
    response.end('ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const prior = {
    selfHosted: process.env.DEFT_SELF_HOSTED,
    allowlist: process.env.DEFT_MCP_PRIVATE_ORIGIN_ALLOWLIST,
  };
  try {
    process.env.DEFT_SELF_HOSTED = 'true';
    process.env.DEFT_MCP_PRIVATE_ORIGIN_ALLOWLIST = origin;
    const guardedFetch = createSecureMcpFetch(`${origin}/mcp`);
    await assert.rejects(guardedFetch(`${origin}/start`), /redirects are disabled/);
    assert.equal(redirectedTargetHits, 0);
    await guardedFetch(`${origin}/headers`, { headers: { Host: 'metadata.google.internal' } });
    assert.equal(observedHost, `127.0.0.1:${address.port}`);
    await assert.rejects(guardedFetch('https://example.com/mcp'), /cross-origin/);
  } finally {
    if (prior.selfHosted === undefined) delete process.env.DEFT_SELF_HOSTED;
    else process.env.DEFT_SELF_HOSTED = prior.selfHosted;
    if (prior.allowlist === undefined) delete process.env.DEFT_MCP_PRIVATE_ORIGIN_ALLOWLIST;
    else process.env.DEFT_MCP_PRIVATE_ORIGIN_ALLOWLIST = prior.allowlist;
    server.close();
    await once(server, 'close');
  }
});

test('employee deny policy canonicalizes outbound MCP names and internal aliases', () => {
  assert.equal(canonicalMcpToolName('mcp__old-slug__delete_contact'), 'delete_contact');
  assert.equal(isAgentToolDisabled(['delete_contact'], 'mcp__crm__delete_contact'), true);
  assert.equal(isAgentToolDisabled(['wiki_search'], 'memory_recall', { wiki_search: 'memory_recall' }), true);
  assert.equal(isAgentToolDisabled(['update_task_status'], 'close_task'), true);
  assert.equal(isAgentToolDisabled(['update_task_status'], 'reopen_task'), true);
  assert.equal(isAgentToolDisabled(['Delete_Contact'], 'mcp__crm__delete_contact'), false);
});

test('production rejects missing, placeholder, short, or public encryption keys', () => {
  for (const value of [undefined, 'CHANGE_ME_WITH_A_SECRET', 'too-short', 'deft-dev-encryption-key-32ch']) {
    assert.throws(() => resolveEncryptionKey(value, 'production'), /ENCRYPTION_KEY/);
  }
  const secure = '0123456789abcdef0123456789abcdef';
  assert.equal(resolveEncryptionKey(secure, 'production'), secure);
});

test('structured MCP results remain intact for the agent runtime', () => {
  const rawResult = {
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: { records: [{ id: 1 }] },
    _meta: { trace_id: 'trace-structured' },
  };
  assert.equal(mcpResultPayload({
    success: true,
    content: rawResult.content,
    structuredContent: rawResult.structuredContent,
    meta: rawResult._meta,
    rawResult,
    durationMs: 1,
  }), rawResult);
});

test('structured MCP error results remain intact with an explicit outer error signal', () => {
  const rawResult = {
    content: [{ type: 'text', text: 'invalid project' }],
    structuredContent: { code: 'INVALID_PROJECT', retryable: false },
    isError: true,
    _meta: { trace_id: 'trace-error' },
  };
  assert.deepEqual(mcpResultPayload({
    success: false,
    content: rawResult.content,
    structuredContent: rawResult.structuredContent,
    meta: rawResult._meta,
    rawResult,
    error: 'invalid project',
    durationMs: 1,
  }), {
    ...rawResult,
    error: 'invalid project',
  });
});

test('connection trust is the default approval boundary and explicit overrides win', () => {
  assert.equal(configuredMcpApprovalTier('full'), 'full-review');
  assert.equal(configuredMcpApprovalTier('quick'), 'quick-approve');
  assert.equal(configuredMcpApprovalTier('auto'), 'auto-execute');
  assert.equal(configuredMcpApprovalTier('full', undefined, 'auto-execute'), 'full-review');
  assert.equal(configuredMcpApprovalTier('auto', undefined, 'full-review'), 'full-review');
  assert.equal(configuredMcpApprovalTier('full', 'auto-execute'), 'auto-execute');
});

test('duplicate legacy/canonical overrides merge to the safest effective policy', () => {
  const merged = mergeMcpToolOverrides(
    { toolName: 'delete_contact', approvalTier: 'auto-execute', disabled: false },
    { toolName: 'delete_contact', approvalTier: 'full-review', disabled: true },
  );
  assert.deepEqual(merged, {
    toolName: 'delete_contact',
    approvalTier: 'full-review',
    disabled: true,
    isWrite: undefined,
  });
});

test('tool allowlists accept canonical and legacy-prefixed names but reject everything else', () => {
  assert.equal(isMcpToolEnabled(null, 'crm', 'read_contact'), true);
  assert.equal(isMcpToolEnabled(['read_contact'], 'crm', 'read_contact'), true);
  assert.equal(isMcpToolEnabled(['mcp__crm__read_contact'], 'crm', 'read_contact'), true);
  assert.equal(isMcpToolEnabled([], 'crm', 'read_contact'), false);
  assert.equal(isMcpToolEnabled(['write_contact'], 'crm', 'read_contact'), false);
});

test('ordinary members cannot read or execute the MCP connector control plane', async () => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'member-1', email: 'member@test.local', org_id: 'org-1', role: 'member' });
    return next();
  });
  app.route('/api/mcp-connections', mcpConnectionRoutes);

  for (const [path, method] of [
    ['/api/mcp-connections', 'GET'],
    ['/api/mcp-connections', 'POST'],
    ['/api/mcp-connections/conn-1/test', 'POST'],
  ] as const) {
    const response = await app.request(path, { method });
    assert.equal(response.status, 403);
    assert.equal((await response.json() as any).code, 'FORBIDDEN');
  }
});
