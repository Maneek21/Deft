import 'dotenv/config';
import { db } from './lib/db.js';
import { sql } from 'drizzle-orm';

(async () => {
  const r = await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('ics_publish_token', 'kind')`);
  console.log('users cols:', r.rows);
  const r2 = await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'orgs' AND column_name = 'ai_config'`);
  console.log('orgs cols:', r2.rows);
  process.exit(0);
})();
