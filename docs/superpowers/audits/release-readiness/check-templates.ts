import pg from 'pg';
async function main() {
  const c = new pg.Client({connectionString:'postgres://postgres:postgres@localhost:5432/cairn'});
  await c.connect();
  const r = await c.query('SELECT id, slug, name, role FROM agent_employee_templates LIMIT 20');
  console.log(JSON.stringify(r.rows));
  await c.end();
}
main();
