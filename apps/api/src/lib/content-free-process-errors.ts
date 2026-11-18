import { logStartupHint } from './log-metadata.js';
// These dependency namespaces include websocket payloads. Keep unrelated
// operator debug namespaces while excluding customer-bearing packet traces.
// Set even when absent so a later dotenv load cannot enable packet traces.
process.env.DEBUG = `${process.env.DEBUG ?? ''},-socket.io*,-engine*`;
// Install before application imports. Node otherwise prints full exceptions
// (including query parameters and provider responses) on these fatal paths.
// Preserve the default fatal exit rather than running with corrupted state.
process.on('uncaughtException', (error) => {
  console.error('[process] Uncaught exception; exiting', logStartupHint(error));
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error('[process] Unhandled rejection; exiting', logStartupHint(error));
  process.exit(1);
});
