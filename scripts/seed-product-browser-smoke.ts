import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const email = process.env.DEFT_TEST_EMAIL || 'diego@testers-tomatoes.com';
const marker = process.env.DEFT_APPROVAL_SMOKE_MARKER || `CI approval smoke ${Date.now()}`;

const client = new Client({ connectionString: databaseUrl });

async function main() {
  await client.connect();
  try {
    const result = await client.query<{
      user_id: string;
      org_id: string;
      space_id: string;
    }>(`
      select u.id as user_id, om.org_id, s.id as space_id
      from users u
      join org_members om on om.user_id = u.id
      join spaces s on s.org_id = om.org_id and s.name = 'general' and s.is_archived = false
      where u.email = $1
      limit 1
    `, [email]);

    const fixture = result.rows[0];
    if (!fixture) throw new Error(`Could not resolve ${email}, its org, and #general`);

    await client.query(`delete from agent_actions where source = 'product_browser_smoke'`);

    const actionId = randomUUID();
    await client.query(`
      insert into agent_actions (
        id, org_id, user_id, conversation_id, source, action, params,
        approval_tier, approval_status, created_at, updated_at
      ) values ($1, $2, $3, $4, 'product_browser_smoke', 'post_message', $5::jsonb,
        'quick', 'pending', now(), now())
    `, [
      actionId,
      fixture.org_id,
      fixture.user_id,
      fixture.space_id,
      JSON.stringify({ space_id: fixture.space_id, content: marker }),
    ]);

    console.log(JSON.stringify({ actionId, marker, ...fixture }));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
