import { main } from './selfhost-reset.ts';

main(['--backup-only', ...process.argv.slice(2)]).catch((err) => {
  console.error('');
  console.error('[FAIL]', err instanceof Error ? err.message : err);
  process.exit(1);
});
