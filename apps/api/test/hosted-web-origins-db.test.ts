import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import test, { after } from 'node:test';
import { corsAllowedWebOrigins, socketAllowedWebOrigins } from '../src/lib/web-origins.js';
import { setupSocket } from '../src/socket.js';
import { closeDb } from '../src/lib/db.js';

type App = typeof import('../src/index.js')['app'];
let app: App | undefined;
const loadApp = async () => (app ??= (await import('../src/index.js')).app);
after(closeDb);

function setEnv(t: test.TestContext, values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    const old = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
}

const LOCALS = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const WEB = 'https://acme.deft.example';

async function corsOrigin(origin: string): Promise<string | null> {
  const res = await (await loadApp()).request('/api/tasks/t1', {
    method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' },
  });
  return res.headers.get('access-control-allow-origin');
}

/** Socket.IO polling handshake: the CORS answer the live-connection server gives a browser origin. */
async function socketCorsOrigin(origin: string): Promise<string | null> {
  const server = createServer();
  const io = setupSocket(server, {
    verifyAccess: async () => { throw new Error('no auth in this test'); },
    requireMembership: async () => ({ role: 'member' }) as any,
    getSpaceAccess: async () => undefined,
    recordLastSeen: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as { port: number };
    return await new Promise<string | null>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/socket.io/?EIO=4&transport=polling', method: 'OPTIONS', agent: false,
        headers: { origin, 'access-control-request-method': 'GET', connection: 'close' } }, (res) => {
        res.resume();
        res.on('end', () => resolve((res.headers['access-control-allow-origin'] as string | undefined) ?? null));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
}

test('self-hosted: CORS and live connections allow the web address and both local addresses as before', async (t) => {
  setEnv(t, { DEFT_HOSTED: undefined, NEXT_PUBLIC_APP_URL: WEB });
  assert.deepEqual(corsAllowedWebOrigins(), [WEB, ...LOCALS]);
  assert.equal(socketAllowedWebOrigins(), WEB);
  for (const origin of [WEB, ...LOCALS]) assert.equal(await corsOrigin(origin), origin);
  assert.equal(await corsOrigin('https://evil.example'), null);
  assert.equal(await socketCorsOrigin(WEB), WEB);
});

test('self-hosted without a web address keeps the local default', async (t) => {
  setEnv(t, { DEFT_HOSTED: undefined, NEXT_PUBLIC_APP_URL: undefined });
  assert.deepEqual(corsAllowedWebOrigins(), ['http://localhost:3000', ...LOCALS]);
  assert.equal(socketAllowedWebOrigins(), 'http://localhost:3000');
  assert.equal(await corsOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
});

test('hosted: only the configured web address is allowed; local addresses are not', async (t) => {
  setEnv(t, { DEFT_HOSTED: 'true', NEXT_PUBLIC_APP_URL: `${WEB}/` });
  assert.deepEqual(corsAllowedWebOrigins(), [WEB]);
  assert.deepEqual(socketAllowedWebOrigins(), [WEB]);
  assert.equal(await corsOrigin(WEB), WEB);
  for (const origin of LOCALS) assert.equal(await corsOrigin(origin), null, origin);
  assert.equal(await socketCorsOrigin(WEB), WEB);
  for (const origin of LOCALS) assert.equal(await socketCorsOrigin(origin), null, origin);
});

test('hosted without a usable web address fails closed', async (t) => {
  for (const value of [undefined, '', 'not a url']) {
    setEnv(t, { DEFT_HOSTED: 'true', NEXT_PUBLIC_APP_URL: value });
    assert.deepEqual(corsAllowedWebOrigins(), []);
    assert.deepEqual(socketAllowedWebOrigins(), []);
    assert.equal(await corsOrigin('http://localhost:3000'), null);
  }
});
