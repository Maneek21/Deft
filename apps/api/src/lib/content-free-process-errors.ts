import { logStartupHint } from './log-metadata.js';
// These dependency namespaces include websocket payloads. Keep unrelated
// operator debug namespaces while excluding customer-bearing packet traces.
// Set even when absent so a later dotenv load cannot enable packet traces.
process.env.DEBUG = `${process.env.DEBUG ?? ''},-socket.io*,-engine*`;

/**
 * Set by server.ts on a hosted cell that sends error events
 * (lib/telemetry): records the error and sends one last batch. The exit
 * waits for it at most FATAL_REPORT_WAIT_MS.
 */
type FatalReporter = (error: unknown) => Promise<void>;
let fatalReporter: FatalReporter | null = null;
let exiting = false;
const FATAL_REPORT_WAIT_MS = 2_500;

export function setFatalErrorReporter(reporter: FatalReporter | null): void {
  fatalReporter = reporter;
}

function exitAfterFatal(error: unknown): void {
  if (exiting) return;
  exiting = true;
  const reporter = fatalReporter;
  if (!reporter) process.exit(1);
  setTimeout(() => process.exit(1), FATAL_REPORT_WAIT_MS).unref?.();
  void reporter(error).catch(() => undefined).finally(() => process.exit(1));
}

// Install before application imports. Node otherwise prints full exceptions
// (including query parameters and provider responses) on these fatal paths.
// Preserve the default fatal exit rather than running with corrupted state.
process.on('uncaughtException', (error) => {
  console.error('[process] Uncaught exception; exiting', logStartupHint(error));
  exitAfterFatal(error);
});
process.on('unhandledRejection', (error) => {
  console.error('[process] Unhandled rejection; exiting', logStartupHint(error));
  exitAfterFatal(error);
});
