#!/usr/bin/env tsx
/**
 * Usage:
 *   DEFT_TEST_EMAIL=you@example.com DEFT_TEST_PASSWORD=yourpass \
 *     pnpm audit:setup
 */
import 'dotenv/config';
import { loginAndSaveState } from './lib/auth.js';

async function main() {
  try {
    await loginAndSaveState();
    console.log('✅ Auth state saved. Ready to run audit scripts.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Auth setup failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
