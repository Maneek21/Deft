import { serve } from '@hono/node-server';
import { closeDb } from '../../src/lib/db.js';
import { appRuntimeChannelRoutes } from '../../src/routes/app-runtime-channel.js';

// Isolated test host only. Production API registration remains a separate gate.
if (process.env.DEFT_RUNTIME_HTTP_FIXTURE !== 'true' || !process.send
  || !process.env.DEFT_TEST_DATABASE_URL
  || process.env.DEFT_TEST_DATABASE_URL !== process.env.DATABASE_URL) {
  throw new Error('Runtime HTTP fixture requires explicit disposable test process');
}
const server = serve({ fetch: appRuntimeChannelRoutes.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
  process.send!({ port: info.port });
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
  process.exit(0);
}
process.on('message', (message) => { if (message === 'stop') void stop(); });
process.on('disconnect', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
