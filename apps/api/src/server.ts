import 'dotenv/config';
import { workerStartup } from './lib/worker-startup.js';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { app } from './index.js';
import { getIO, setupSocket } from './socket.js';

// Prefer Railway/Fly's PORT env, then API_PORT, then local default.
const port = parseInt(process.env.PORT || process.env.API_PORT || '3001');
let shuttingDown = false;

// index.ts only defines and exports the Hono app so tests can import it
// without binding a port. This file is the actual entry point —
// `pnpm dev`/`pnpm start` run it. The previous main-entry guard inside
// index.ts (process.argv[1] string-endsWith check) silently disabled the
// listen() under `tsx watch` because argv[1] became the tsx CLI script,
// not our source file. Splitting removes the guard entirely.
workerStartup.require();
const server = serve({ fetch: app.fetch, port }, async (info) => {
  console.log(`Deft API running on http://localhost:${info.port}`);

  // Historical MCP connection forms wrote credentials into a JSONB column in
  // plaintext. Encrypt those rows before any worker can construct a runtime
  // transport. This migration is idempotent and never logs credential data.
  try {
    const { migrateLegacyMcpConnectionCredentials } = await import('./lib/mcp-credential-migration.js');
    const result = await migrateLegacyMcpConnectionCredentials();
    if (result.migrated > 0) {
      console.log(`[startup] Encrypted ${result.migrated} legacy MCP credential row(s)`);
    }
    if (result.disabledUnsupportedAuth > 0) {
      console.warn(
        `[startup] Disabled ${result.disabledUnsupportedAuth} MCP connection(s) using unsupported external OAuth`,
      );
    }
    if (result.disabledUnsafeTarget > 0) {
      console.warn(`[startup] Disabled ${result.disabledUnsafeTarget} MCP connection(s) blocked by host transport policy`);
    }
  } catch (err) {
    console.warn('[startup] MCP credential migration failed:', (err as Error).message);
  }

  // Startup maintenance is idempotent. A transient database outage must not
  // leave an otherwise reachable server with a permanently unclaimed queue.
  const workersReady = await workerStartup.start(async () => {
    const { startWorkers, stopWorkers } = await import('./workers/index.js');
    const { initScheduler } = await import('./lib/job-scheduler.js');
    if (shuttingDown) throw Error('Server stopping');
    await startWorkers();
    if (shuttingDown) { await stopWorkers({ timeoutMs: 10_000 }); throw Error('Server stopping'); }
    await initScheduler();
    if (shuttingDown) { await stopWorkers({ timeoutMs: 10_000 }); throw Error('Server stopping'); }
  }, { onFailure: (attempt, error) => console.warn(`[startup] Job workers attempt ${attempt}/5 failed:`, (error as Error).message) });
  if (shuttingDown) return;
  if (workersReady) console.log('[startup] Job workers and scheduler started');
  else console.warn('[startup] Job workers unavailable after bounded startup retries');

  // Self-hosted v1 — single-org hard-block. Warn the operator if the DB
  // already holds more than one workspace; signup is blocked server-side
  // but a legacy DB carried over from a pre-hard-block build can slip
  // through. See apps/api/src/lib/single-org-guard.ts.
  try {
    const { countOrgs } = await import('./lib/single-org-guard.js');
    const count = await countOrgs();
    if (count > 1) {
      console.warn(
        `[startup] This Deft instance has ${count} workspaces. The ` +
          'self-hosted v1 product supports one workspace per deployment. ' +
          'Consolidate before opening signup to external users, or use a ' +
          'deployment architecture that explicitly supports multiple workspaces.',
      );
    }
  } catch (err) {
    console.warn('[startup] single-org check skipped:', (err as Error).message);
  }
});

setupSocket(server as unknown as Server);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  workerStartup.stop();
  console.log(`[shutdown] ${signal} received; draining HTTP and job workers`);

  const httpServer = server as unknown as Server;
  const socketClosed = getIO()?.close() ?? Promise.resolve();
  const httpClosed = new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
  const forceHttpClose = setTimeout(() => {
    httpServer.closeAllConnections?.();
  }, 10_000);
  const forceProcessExit = setTimeout(() => {
    console.error('[shutdown] Hard deadline reached; forcing process exit');
    process.exit(1);
  }, 15_000);

  try {
    const { stopWorkers } = await import('./workers/index.js');
    const results = await Promise.allSettled([
      stopWorkers({ timeoutMs: 10_000 }),
      socketClosed,
      httpClosed,
    ]);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    const { shutdownAppRunRuntime } = await import('./lib/app-run-runtime.js');
    await shutdownAppRunRuntime();
    const { closeDb } = await import('./lib/db.js');
    await closeDb();
  } catch (err) {
    process.exitCode = 1;
    console.error('[shutdown] Graceful shutdown failed:', (err as Error).message);
  } finally {
    clearTimeout(forceHttpClose);
    clearTimeout(forceProcessExit);
    // A signal is a terminal process request. Exit explicitly after bounded
    // drains so an ignored AbortSignal or third-party handle cannot keep the
    // container alive beyond its stop grace period.
    const exitCode = process.exitCode ?? 0;
    setImmediate(() => process.exit(exitCode));
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
