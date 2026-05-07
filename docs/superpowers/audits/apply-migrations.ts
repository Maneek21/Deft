#!/usr/bin/env tsx
import 'dotenv/config';
import { db } from './lib/db.js';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrations = ['0061_org_ai_config.sql', '0062_ics_calendar_sync.sql'];

(async () => {
  for (const m of migrations) {
    const path = resolve(import.meta.dirname ?? '.', '..', '..', '..', 'packages', 'db', 'drizzle', m);
    const ddl = readFileSync(path, 'utf8');
    console.log(`\n=== applying ${m} ===`);
    // Split on Drizzle's --> statement-breakpoint marker AND on bare ;
    // boundaries within a sub-block, since not every migration uses the marker.
    const blocks = ddl.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean);
    for (const block of blocks) {
      // Strip pure comments and split into individual statements by ;
      const cleaned = block.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
      const stmts = cleaned.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
      for (const stmt of stmts) {
        try {
          await db.execute(sql.raw(stmt));
          console.log(`  ✓ ${stmt.slice(0, 80).replace(/\s+/g, ' ')}...`);
        } catch (err: any) {
          const msg = err?.cause?.message ?? err?.message ?? '';
          if (/already exists|duplicate column/i.test(msg)) {
            console.log(`  - already applied: ${stmt.slice(0, 60).replace(/\s+/g, ' ')}...`);
          } else {
            console.error(`  ✗ ERROR: ${msg.slice(0, 200)}`);
            console.error(`    stmt: ${stmt.slice(0, 200)}`);
          }
        }
      }
    }
  }
  console.log('\ndone');
  process.exit(0);
})();
