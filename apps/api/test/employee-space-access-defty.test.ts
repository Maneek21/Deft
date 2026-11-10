import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { employeeCanAccessSpace } from '../src/lib/mcp-tools/employee-space-access.js';
import { ensureDeftyEmployee } from '../src/lib/ensure-defty-membership.js';

test('D06: invited Defty system identity may use a private space; uninvited and forged identities may not', async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const org = randomUUID(), owner = randomUUID(), forgedUser = randomUUID();
  const invited = randomUUID(), uninvited = randomUUID(), dm = randomUUID(), forged = randomUUID();
  try {
    await c.query('INSERT INTO orgs(id,name,slug) VALUES($1,$1,$1)', [org]);
    await c.query(`INSERT INTO users(id,email,name) VALUES($1,$1||'@test.local','Owner')`, [owner]);
    await c.query(`INSERT INTO users(id,email,name,is_agent,kind) VALUES($1,$1||'@test.local','Forged','true','agent')`, [forgedUser]);
    await c.query(`INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'admin')`, [randomUUID(), org, owner]);
    const defty = await ensureDeftyEmployee(org);
    const [row] = (await c.query('SELECT is_deleted FROM agent_employees WHERE id=$1', [defty.employeeId])).rows;
    assert.equal(row?.is_deleted, true, 'precondition: the Defty system employee is soft-hidden');

    for (const [id, type] of [[invited, 'private'], [uninvited, 'private'], [dm, 'dm']] as const) {
      await c.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$1,$3,$4)', [id, org, type, owner]);
      await c.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), id, owner]);
    }
    await c.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), invited, defty.userId]);

    assert.equal(await employeeCanAccessSpace(defty.employeeId, org, invited), true, 'invited Defty is allowed');
    assert.equal(await employeeCanAccessSpace(defty.employeeId, org, uninvited), false, 'uninvited private space stays denied');
    assert.equal(await employeeCanAccessSpace(defty.employeeId, org, dm), false, 'a DM Defty is not in stays denied');

    // A deleted external employee that only copies Defty's runtime kind must
    // not inherit the exemption, even when its shadow user is a member.
    await c.query(`INSERT INTO agent_employees(id,org_id,user_id,name,slug,role,system_prompt,trust_level,is_byoa,is_active,is_deleted,runtime_kind,created_by)
      VALUES($1,$2,$3,'Forged',$4,'project_manager','x','conservative',true,true,true,'defty_system',$5)`,
      [forged, org, forgedUser, `forged-${forged.slice(0, 8)}`, owner]);
    await c.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), invited, forgedUser]);
    assert.equal(await employeeCanAccessSpace(forged, org, invited), false, 'deleted non-canonical employee stays denied');

    await c.query('UPDATE agent_employees SET is_active=false WHERE id=$1', [defty.employeeId]);
    assert.equal(await employeeCanAccessSpace(defty.employeeId, org, invited), false, 'inactive Defty stays denied');
  } finally {
    for (const sql of [
      'DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)',
      'DELETE FROM spaces WHERE org_id=$1',
      'DELETE FROM agent_employees WHERE org_id=$1',
      'DELETE FROM org_members WHERE org_id=$1',
      'DELETE FROM orgs WHERE id=$1',
    ]) await c.query(sql, [org]).catch(() => undefined);
    await c.query('DELETE FROM users WHERE id IN ($1,$2)', [owner, forgedUser]).catch(() => undefined);
    await c.end();
  }
});
