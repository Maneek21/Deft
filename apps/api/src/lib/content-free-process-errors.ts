// Install before application imports. Node otherwise prints full exceptions
// (including query parameters and provider responses) on these fatal paths.
// Preserve the default fatal exit rather than running with corrupted state.
process.on('uncaughtException', () => {
  console.error('[process] Uncaught exception; exiting');
  process.exit(1);
});
process.on('unhandledRejection', () => {
  console.error('[process] Unhandled rejection; exiting');
  process.exit(1);
});
