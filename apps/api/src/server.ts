import 'dotenv/config';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { app } from './index.js';
import { setupSocket } from './socket.js';

// Prefer Railway/Fly's PORT env, then API_PORT, then local default.
const port = parseInt(process.env.PORT || process.env.API_PORT || '3001');

// index.ts only defines and exports the Hono app so tests can import it
// without binding a port. This file is the actual entry point —
// `pnpm dev`/`pnpm start` run it. The previous main-entry guard inside
// index.ts (process.argv[1] string-endsWith check) silently disabled the
// listen() under `tsx watch` because argv[1] became the tsx CLI script,
// not our source file. Splitting removes the guard entirely.
const server = serve({ fetch: app.fetch, port }, async (info) => {
  console.log(`Deft API running on http://localhost:${info.port}`);

  // Start background job workers — uses Postgres, no Redis needed
  try {
    const { startWorkers } = await import('./workers/index.js');
    const { initScheduler } = await import('./lib/job-scheduler.js');
    startWorkers();
    await initScheduler();
    console.log('[startup] Job workers and scheduler started');
  } catch (err) {
    console.warn('[startup] Job workers failed to start:', (err as Error).message);
  }

  // Self-hosted v1 — single-org hard-block. Warn the operator if the DB
  // already holds more than one workspace; signup is blocked server-side
  // but a legacy DB carried over from a pre-hard-block build can slip
  // through. See apps/api/src/lib/single-org-guard.ts.
  try {
    const { countOrgs } = await import('./lib/single-org-guard.js');
    const count = await countOrgs();
    if (count > 1) {
      console.warn(
        `[startup] This Deft instance has ${count} orgs. Self-hosted ` +
          'Deft is licensed for a single workspace per deployment ' +
          '(BSL 1.1). Check LICENSE and consolidate before opening ' +
          'signup to external users.',
      );
    }
  } catch (err) {
    console.warn('[startup] single-org check skipped:', (err as Error).message);
  }
});

setupSocket(server as unknown as Server);
