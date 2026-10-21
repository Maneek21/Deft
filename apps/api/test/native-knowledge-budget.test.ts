import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableName } from 'drizzle-orm';
import { hostRetainedSourceStorage } from '../src/lib/host-source-storage.js';
import { knowledgeCaptureBudgetLimits, reserveKnowledgeCaptureBudget } from '../src/lib/native-knowledge-budget.js';
import type { AppRunTransaction } from '../src/lib/app-run-repository.js';

const prior = hostRetainedSourceStorage.knowledge.budgetConfigKeys;

test('budget aliases retain defaults and enforce the lower configured cap', () => {
  assert.deepEqual(knowledgeCaptureBudgetLimits({}), { org: 500000, account: 128000 });
  assert.deepEqual(knowledgeCaptureBudgetLimits({ [prior.org]: 500, [prior.account]: 200 }), { org: 500, account: 200 });
  assert.deepEqual(knowledgeCaptureBudgetLimits({ knowledge_capture_daily_token_budget: 700,
    knowledge_capture_account_daily_token_budget: 300, [prior.org]: 500, [prior.account]: 200 }), { org: 500, account: 200 });
  assert.deepEqual(knowledgeCaptureBudgetLimits({ knowledge_capture_daily_token_budget: 100,
    knowledge_capture_account_daily_token_budget: 300, [prior.org]: 500, [prior.account]: 200 }), { org: 100, account: 100 });
  assert.deepEqual(knowledgeCaptureBudgetLimits({ [prior.org]: null, knowledge_capture_daily_token_budget: 100 }), { org: 0, account: 0 });
  assert.deepEqual(knowledgeCaptureBudgetLimits({ knowledge_capture_daily_token_budget: 'invalid' }), { org: 500000, account: 128000 });
});

const url = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!url && url === process.env.DATABASE_URL && /^postgres(?:ql)?:\/\/(?:[^@]+@)?(?:127\.0\.0\.1|localhost):\d+\/[^?]*test(?:\?.*)?$/u.test(url);
test('existing reservations, account refusal and org isolation survive alias rollout in PostgreSQL', { skip: !safe }, async () => {
  const client = new pg.Client({ connectionString: url }); await client.connect();
  // Trusted schema name, never caller data. Test the original physical table.
  const table = '"' + getTableName(hostRetainedSourceStorage.knowledge.budgetStorage).replaceAll('"','""') + '"';
  try {
    await drizzle(client).transaction(async outer => {
      await client.query(`CREATE TEMP TABLE orgs (id text, ai_config jsonb);
        CREATE TEMP TABLE ${table} (org_id text, day text, budget_key text, reserved_tokens integer DEFAULT 0,
          created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(), PRIMARY KEY(org_id,day,budget_key));`);
      await client.query('INSERT INTO orgs VALUES ($1,$2)', ['org', JSON.stringify({ [prior.org]: 100, [prior.account]: 60,
        knowledge_capture_daily_token_budget: 200, knowledge_capture_account_daily_token_budget: 80 })]);
      await client.query(`INSERT INTO ${table} (org_id,day,budget_key,reserved_tokens) VALUES
        ('org','2026-10-20','org',50),('org','2026-10-20','app-account:owner:install:account',40),
        ('foreign','2026-10-20','org',17)`);
      const input = { org_id:'org',user_id:'owner',installation_id:'install',account_ref:'account',tokens:10,at:new Date('2026-10-20T23:59:00Z') };
      const reserve = (patch = {}) => outer.transaction(tx => reserveKnowledgeCaptureBudget(tx as AppRunTransaction,{...input,...patch}));
      await reserve();
      const counters = async () => (await client.query(`SELECT org_id,budget_key,reserved_tokens FROM ${table} ORDER BY org_id,budget_key`)).rows;
      const expected = [{org_id:'foreign',budget_key:'org',reserved_tokens:17},
        {org_id:'org',budget_key:'app-account:owner:install:account',reserved_tokens:50}, {org_id:'org',budget_key:'org',reserved_tokens:60}];
      assert.deepEqual(await counters(), expected);
      await assert.rejects(reserve({tokens:11}), /BUDGET_EXCEEDED/u);
      assert.deepEqual(await counters(), expected, 'account refusal rolls back the org increment');
      await assert.rejects(reserve({tokens:0}), /CHANGED_OR_DENIED/u);
      await assert.rejects(reserve({org_id:'unknown'}), /CHANGED_OR_DENIED/u);
      await client.query('UPDATE orgs SET ai_config=$1 WHERE id=$2', [JSON.stringify({knowledge_capture_daily_token_budget:55}), 'org']);
      await assert.rejects(reserve(), /BUDGET_EXCEEDED/u);
      assert.deepEqual(await counters(), expected, 'a lower cap does not erase reservations');
      await reserve({at:new Date('2026-10-21T00:00:00Z')});
      assert.equal((await counters()).filter(row => row.org_id==='org').length,4,'UTC day starts a new bucket');
      await outer.rollback();
    }).catch(error => { if (error?.constructor?.name !== 'TransactionRollbackError') throw error; });
  } finally { await client.end(); }
});
