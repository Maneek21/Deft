import { setFatalErrorReporter } from './lib/content-free-process-errors.js';
import { logNumber, logSignal } from './lib/log-metadata.js';
import 'dotenv/config';
import { workerStartup } from './lib/worker-startup.js';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { app } from './index.js';
import { getIO, setupSocket } from './socket.js';
import { getCollabServer } from './collab/server.js';
import { startDocumentVersioning } from './lib/document-versions.js';
import { moveNotesBeforeListen } from './lib/drives-move/startup.js';
import { assertPausedStartSettingValid, logPausedStart, serverStartupPlan } from './lib/paused-start.js';
import { captureProcessError, flushErrorTelemetryBeforeExit, isErrorTelemetryEnabled } from './lib/telemetry/error-reporter.js';

// Hosted cells that send error events: an uncaught error is recorded and one
// last batch sent before the process exits (it waits at most 2.5 seconds).
// Everywhere else the exit is immediate, as before.
setFatalErrorReporter(async (error) => {
  if (!isErrorTelemetryEnabled()) return;
  captureProcessError(error);
  await flushErrorTelemetryBeforeExit(2_000);
});

// Prefer Railway/Fly's PORT env, then API_PORT, then local default.
const port = parseInt(process.env.PORT || process.env.API_PORT || '3001');
let shuttingDown = false;

// index.ts only defines and exports the Hono app so tests can import it
// without binding a port. This file is the actual entry point —
// `pnpm dev`/`pnpm start` run it. The previous main-entry guard inside
// index.ts (process.argv[1] string-endsWith check) silently disabled the
// listen() under `tsx watch` because argv[1] became the tsx CLI script,
// not our source file. Splitting removes the guard entirely.
// A malformed DEFT_PAUSED_START ("TRUE", "1", "true\r") must not start a
// restored copy live: refuse to start at all.
assertPausedStartSettingValid();
const startupPlan = serverStartupPlan();
workerStartup.require();
// Notes and canvases move into drives before the API listens, so it never
// serves a half-moved workspace; skipped while paused (lib/drives-move/startup.ts).
await moveNotesBeforeListen();
const server = serve({ fetch: app.fetch, port }, async (info) => {
  console.log(`Deft API running on http://localhost:${logNumber(info.port)}`);
  logPausedStart();
  if (!process.env.DEFT_INVITE_TRUSTED_PROXIES?.trim()) {
    console.warn('[startup] DEFT_INVITE_TRUSTED_PROXIES is unset: IP rate limits use socket peers. Behind a custom proxy, visitors share its bucket; configure trusted proxy peers for per-visitor limits.');
  }

  // Hosted cells fetch their signed seat statement now and on a timer.
  // A no-op unless hosted mode is on and this process is not paused.
  const { startSeatStatementRefresher } = await import('./lib/seat-limit.js');
  startSeatStatementRefresher();
  // Hosted cells tell the control plane they are up, with their seats in use
  // (lib/telemetry/heartbeat.ts). A no-op everywhere else.
  const { startCellHeartbeat } = await import('./lib/telemetry/heartbeat.js');
  startCellHeartbeat();

  // Historical MCP connection forms wrote credentials into a JSONB column in
  // plaintext. Encrypt those rows before any worker can construct a runtime
  // transport. This migration is idempotent and never logs credential data.
  // A paused start writes nothing at startup, so this waits for release.
  if (startupPlan.migrateLegacyMcpCredentials) try {
    const { migrateLegacyMcpConnectionCredentials } = await import('./lib/mcp-credential-migration.js');
    const result = await migrateLegacyMcpConnectionCredentials();
    if (result.migrated > 0) {
      console.log(`[startup] Encrypted ${logNumber(result.migrated)} legacy MCP credential row(s)`);
    }
    if (result.disabledUnsupportedAuth > 0) {
      console.warn(`[startup] Disabled ${logNumber(result.disabledUnsupportedAuth)} MCP connection(s) using unsupported external OAuth`
      );
    }
    if (result.disabledUnsafeTarget > 0) {
      console.warn(`[startup] Disabled ${logNumber(result.disabledUnsafeTarget)} MCP connection(s) blocked by host transport policy`);
    }
  } catch (err) {
    console.warn('[startup] MCP credential migration failed:');
  }

  // Startup maintenance is idempotent. A transient database outage must not
  // leave an otherwise reachable server with a permanently unclaimed queue.
  const workersReady = await workerStartup.start(async () => {
    const { startWorkers, stopWorkers } = await import('./workers/index.js');
    const { initScheduler } = await import('./lib/job-scheduler.js');
    if (shuttingDown) throw Error('Server stopping');
    // Paused: workers start with dispatch and startup work off (startWorkers
    // reads the same setting) and no cron job is registered.
    await startWorkers();
    if (shuttingDown) { await stopWorkers({ timeoutMs: 10_000 }); throw Error('Server stopping'); }
    if (startupPlan.initScheduler) await initScheduler();
    if (shuttingDown) { await stopWorkers({ timeoutMs: 10_000 }); throw Error('Server stopping'); }
  }, { keepRetrying: true, onFailure: (attempt) => console.warn(`[startup] Job workers attempt ${logNumber(attempt)} failed`) });
  if (shuttingDown) return;
  if (workersReady && !startupPlan.initScheduler) console.log('[startup] Paused: job workers idle, scheduler not started');
  else if (workersReady) console.log('[startup] Job workers and scheduler started');
  else console.warn('[startup] Job workers unavailable after bounded startup retries');

  // Self-hosted v1 — single-org hard-block. Warn the operator if the DB
  // already holds more than one workspace; signup is blocked server-side
  // but a legacy DB carried over from a pre-hard-block build can slip
  // through. See apps/api/src/lib/single-org-guard.ts.
  try {
    const { countOrgs } = await import('./lib/single-org-guard.js');
    const count = await countOrgs();
    if (count > 1) {
      console.warn('[startup] This Deft instance has multiple workspaces. The ' +
        'self-hosted v1 product supports one workspace per deployment. ' +
        'Consolidate before opening signup to external users, or use a ' +
        'deployment architecture that explicitly supports multiple workspaces.'
      );
    }
  } catch (err) {
    console.warn('[startup] single-org check skipped:');
  }
});

setupSocket(server as unknown as Server);
// Live editing at /collab (collab/server.ts). Its upgrade listener runs next
// to engine.io's and ends upgrades for any other path.
getCollabServer().attach(server as unknown as Server);
// Automatic document versions and document_attachments.in_current follow
// every derived store (lib/document-versions.ts).
startDocumentVersioning();

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  workerStartup.stop();
  void import('./lib/seat-limit.js').then(({ stopSeatStatementRefresher }) => stopSeatStatementRefresher());
  void import('./lib/telemetry/heartbeat.js').then(({ stopCellHeartbeat }) => stopCellHeartbeat());
  console.log(`[shutdown] ${logSignal(signal)} received; draining HTTP and job workers`);

  const httpServer = server as unknown as Server;
  // Live editing stops admitting connections, frames and writes, finishes what
  // it took, and stores every changed document, retrying until 12 s from now
  // (inside the 15 s hard deadline); then it closes its connections. A
  // document it couldn't store makes this reject, so the exit is non-zero.
  // The database closes only after that.
  const collabStopped = getCollabServer().destroy({ retryUntil: Date.now() + 12_000 });
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
      collabStopped,
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
    console.error('[shutdown] Graceful shutdown failed:');
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
