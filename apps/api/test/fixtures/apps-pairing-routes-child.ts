// Runs in its own process so the pairing flag, read once at import, can be set
// per test. Prints one JSON line with what each pairing-related route answered.
import { Hono } from 'hono';
import { appRoutes } from '../../src/routes/apps.js';
import { closeDb } from '../../src/lib/db.js';

const app = new Hono();
app.use('*', async (context, next) => {
  context.set('user', {
    id: 'pairing-route-owner',
    org_id: `pairing-route-org-${process.pid}`,
    email: 'pairing-route@example.test',
    name: 'Pairing route owner',
    role: 'owner',
  });
  await next();
});
app.route('/api/apps', appRoutes);

const create = await app.request('/api/apps/pairings', { method: 'POST' });
const revoke = await app.request('/api/apps/pairings/pairing-1/revoke', { method: 'POST' });
const list = await app.request('/api/apps');
const listBody = await list.json() as { developer_pairing?: unknown };

console.log(JSON.stringify({
  create: { status: create.status, body: await create.json() },
  revoke: { status: revoke.status, body: await revoke.json() },
  list: { status: list.status, developer_pairing: listBody.developer_pairing },
}));
await closeDb();
