/**
 * Launch check 6.4(b): an AI address stored before hosted mode was switched
 * on (or restored from a backup, or written by a job) is refused where it is
 * USED, under every key precondition a customer can create:
 *
 *   - no key at all;
 *   - a provider key of the organisation's own, already in storage;
 *   - a key the organisation brings afterwards through the AI settings;
 *   - the platform key in the environment (OPENAI_API_KEY);
 *   - all of them at once.
 *
 * For each stored address (inward ones and a custom public one) and each
 * precondition, every use path is triggered: embeddings (direct, quiet, and
 * the background embed-content job), each model task through llm(), the
 * agent loop, image questions, and the private-model endpoint. No request
 * may leave for the stored address, or for anything but a named provider's
 * standard address.
 *
 * Canaries prove the paths really reach the network: self-hosted, the same
 * stored address IS fetched by the same triggers; hosted, a standard stored
 * address is fetched at its standard place.
 *
 * Run: pnpm --filter @deft/api test test/hosted-stored-ai-address-preconditions-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { closeDb, db } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';
import { encrypt } from '../src/lib/encryption.js';
import { embed, embedQuiet, getEmbedConfigMasked } from '../src/lib/embed.js';
import { llm } from '../src/lib/llm.js';
import { createAgentMessage } from '../src/lib/agent-llm.js';
import { answerImageAttachmentQuestion } from '../src/lib/attachment-vision.js';
import { privateDeftyEndpoint } from '../src/lib/app-private-defty-model.js';
import { getOrgAIConfig, resolveReasonProvider } from '../src/lib/org-ai-config.js';
import { STANDARD_AI_PROVIDER_ADDRESSES } from '../src/lib/ai-provider-address.js';
import { handleEmbedContent } from '../src/workers/handlers/embed-content.js';
import { orgRoutes } from '../src/routes/org.js';

const orgId = `stored-ai-${randomUUID()}`;
const ownerId = randomUUID();
const wikiId = randomUUID();
const TASKS = ['classify', 'summarize', 'reason', 'extract'] as const;
const STANDARD_ORIGINS = new Set(Object.values(STANDARD_AI_PROVIDER_ADDRESSES).map((address) => new URL(address).origin));

/** Addresses stored before hosted mode: inward ones, and a custom public one (hosted allows named providers only). */
const ADDRESSES = [
  'http://10.0.0.5/v1',
  'http://127.0.0.1:11434',
  'http://169.254.169.254/latest',
  'http://[::1]:8080/v1',
  'http://deft-db.internal:5432',
  'https://models.example.test/v1',
];

/** Two shapes of stored configuration: every route pinned to the address, or reasoning through a stored Ollama address. */
const PLANT_EVERY_ROUTE = 'every route and the embedding pinned to the address';
const PLANT_OLLAMA_REASON = 'reasoning through the stored Ollama address, embedding at the address';
const PLANTS: Record<string, (address: string) => Record<string, unknown>> = {
  [PLANT_EVERY_ROUTE]: (address) => ({
    embed: { provider: 'openai', base_url: address },
    ai_models: {
      reason: { provider: 'openai', model: 'gpt-4o', baseUrl: address },
      classify: { provider: 'openrouter', model: 'openai/gpt-4o-mini', baseUrl: address },
      summarize: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', baseUrl: address },
      extract: { provider: 'ollama', model: 'llama3.1' },
    },
    ollama_url: address,
  }),
  [PLANT_OLLAMA_REASON]: (address) => ({
    embed: { provider: 'openai', base_url: address },
    ai_models: { reason: { provider: 'ollama', model: 'llama3.1' } },
    ollama_url: address,
  }),
};

const ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'] as const;
const envTarget = env as unknown as Record<string, unknown>;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, envTarget[key]]));
const savedProcessEnv = Object.fromEntries([...ENV_KEYS, 'DEFT_HOSTED'].map((key) => [key, process.env[key]]));

function setEnvKeys(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    envTarget[key] = values[key] ?? '';
    process.env[key] = values[key] ?? '';
  }
}

function setHosted(on: boolean) {
  if (on) process.env.DEFT_HOSTED = 'true'; else delete process.env.DEFT_HOSTED;
}

const orgKeys = () => ({ openai: 'sk-org-openai-test', anthropic: 'sk-ant-org-test', openrouter: 'sk-or-org-test' });

/** Replace the whole stored AI configuration. */
async function plant(config: Record<string, unknown>) {
  await db.execute(sql`UPDATE orgs SET ai_config = ${JSON.stringify(config)}::jsonb WHERE id = ${orgId}`);
}

/** Replace only the stored addresses and routes, keeping whatever keys are stored. */
async function plantAddresses(config: Record<string, unknown>) {
  await db.execute(sql`UPDATE orgs SET ai_config = (COALESCE(ai_config, '{}'::jsonb) - 'embed' - 'ai_models' - 'ollama_url') || ${JSON.stringify(config)}::jsonb
    WHERE id = ${orgId}`);
}

async function storedConfig(): Promise<Record<string, any>> {
  return (await db.execute(sql`SELECT ai_config FROM orgs WHERE id = ${orgId}`)).rows[0]!.ai_config as Record<string, any>;
}

/** The admin brings their own keys through the AI settings, after the address was stored. */
async function bringOwnKeys() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: ownerId, org_id: orgId, role: 'owner', email: `${ownerId}@example.test` } as never);
    await next();
  });
  app.route('/api/org', orgRoutes);
  const res = await app.request('/api/org/ai-config', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_keys: orgKeys() }),
  });
  assert.equal(res.status, 200, await res.text());
}

/**
 * Each precondition: sets the environment and the org's keys around an
 * already-planted address (a bring-your-own key is saved after the address).
 * Later addresses are planted with `plantAddresses`, which keeps the keys.
 */
const PRECONDITIONS: Record<string, { apply: (config: Record<string, unknown>) => Promise<void>; orgKeys: boolean }> = {
  'no key': {
    orgKeys: false,
    apply: async (config) => {
      setEnvKeys({});
      await plant(config);
    },
  },
  'a stored org key': {
    orgKeys: true,
    apply: async (config) => {
      setEnvKeys({});
      await plant({ ...config, api_keys: Object.fromEntries(Object.entries(orgKeys()).map(([provider, key]) => [provider, encrypt(key)])) });
    },
  },
  'a bring-your-own key saved through the settings': {
    orgKeys: true,
    apply: async (config) => {
      setEnvKeys({});
      await plant(config);
      await bringOwnKeys();
    },
  },
  'the platform env key (OPENAI_API_KEY)': {
    orgKeys: false,
    apply: async (config) => {
      setEnvKeys({ OPENAI_API_KEY: 'sk-env-openai-test' });
      await plant(config);
    },
  },
  'org keys and every env key together': {
    orgKeys: true,
    apply: async (config) => {
      setEnvKeys({ OPENAI_API_KEY: 'sk-env-openai-test', ANTHROPIC_API_KEY: 'sk-ant-env-test', OPENROUTER_API_KEY: 'sk-or-env-test' });
      await plant(config);
      await bringOwnKeys();
    },
  },
};

/** Apply a precondition and check it took: the org's own keys are stored (and decrypt) exactly when it says so. */
async function applyPrecondition(name: string, config: Record<string, unknown>) {
  const precondition = PRECONDITIONS[name]!;
  await precondition.apply(config);
  assert.deepEqual((await getOrgAIConfig(orgId)).api_keys, precondition.orgKeys ? orgKeys() : {}, `${name}: the org's keys as the precondition stores them`);
}

/** A fetch stand-in that records every request and answers like a model server, so nothing ever leaves this machine. */
function recordFetches(t: test.TestContext): string[] {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    if (url.endsWith('/embeddings')) return Response.json({ data: [{ embedding: new Array(1536).fill(0) }] });
    if (url.endsWith('/api/chat')) return Response.json({ message: { role: 'assistant', content: 'ok' }, done: true });
    return Response.json({ id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
  });
  return urls;
}

/** One-pixel PNG for the image-question path. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/** Every path that would use a stored AI address, by name. */
const TRIGGERS: ReadonlyArray<{ readonly name: string; readonly run: () => Promise<unknown> }> = [
  { name: 'embed()', run: () => embed('hello', orgId) },
  { name: 'embedQuiet()', run: () => embedQuiet('hello', orgId) },
  {
    name: 'the embed-content job',
    run: () => handleEmbedContent({ id: `job-${randomUUID()}`, name: 'embed-content', attempts: 0, data: { source_type: 'wiki_page', source_id: wikiId } }),
  },
  ...TASKS.map((task) => ({
    name: `llm(${task})`,
    run: async () => llm({ task, messages: [{ role: 'user', content: 'hello' }], orgConfig: await getOrgAIConfig(orgId), orgId }),
  })),
  {
    name: 'the agent loop',
    run: async () => createAgentMessage({ resolved: await resolveReasonProvider(orgId), system: 'test', messages: [{ role: 'user', content: 'hello' }], tools: [], maxTokens: 16 }),
  },
  { name: 'an image question', run: () => answerImageAttachmentQuestion({ orgId, bytes: PNG, mimeType: 'image/png' }) },
];

/**
 * Run each trigger on its own and return the requests each one sent. A trigger may fail (a refusal, or a stand-in
 * answer it cannot read); only where its requests went matters.
 */
async function requestsPerTrigger(urls: string[]): Promise<Record<string, string[]>> {
  const sent: Record<string, string[]> = {};
  for (const trigger of TRIGGERS) {
    const start = urls.length;
    try { await trigger.run(); } catch { /* a refusal */ }
    sent[trigger.name] = urls.slice(start);
  }
  return sent;
}

/** The private-model endpoint the agent would be bound to, or null when it is refused. It sends nothing itself. */
async function privateEndpoint(): Promise<string | null> {
  try { return privateDeftyEndpoint(await resolveReasonProvider(orgId)); } catch { return null; }
}

const wikiEmbeddingIsNull = async () =>
  ((await db.execute(sql`SELECT embedding IS NULL AS empty FROM wiki_pages WHERE id = ${wikiId}`)).rows[0] as { empty: boolean }).empty;

function sameHost(url: string, address: string) {
  return new URL(url).host === new URL(address).host;
}

before(async () => {
  await db.execute(sql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, ${orgId}, ${orgId})`);
  await db.execute(sql`INSERT INTO users (id, name, email) VALUES (${ownerId}, ${ownerId}, ${`${ownerId}@example.test`})`);
  await db.execute(sql`INSERT INTO org_members (id, org_id, user_id, role) VALUES (${randomUUID()}, ${orgId}, ${ownerId}, 'owner')`);
  await db.execute(sql`INSERT INTO wiki_pages (id, org_id, type, title, slug, content)
    VALUES (${wikiId}, ${orgId}, 'fact', 'Stored address page', ${`stored-address-${wikiId}`}, 'Some text to embed')`);
});

after(async () => {
  for (const key of ENV_KEYS) envTarget[key] = savedEnv[key];
  for (const [key, value] of Object.entries(savedProcessEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await db.execute(sql`DELETE FROM wiki_pages WHERE org_id = ${orgId}`);
  await db.execute(sql`DELETE FROM org_members WHERE org_id = ${orgId}`);
  await db.execute(sql`DELETE FROM orgs WHERE id = ${orgId}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${ownerId}`);
  await closeDb();
});

for (const [plantName, plantFor] of Object.entries(PLANTS)) {
  for (const preconditionName of Object.keys(PRECONDITIONS)) {
    test(`hosted, ${plantName}, with ${preconditionName}: no request leaves for a stored inward or custom address`, async (t) => {
      setHosted(true);
      await db.execute(sql`UPDATE wiki_pages SET embedding = NULL WHERE id = ${wikiId}`);
      const urls = recordFetches(t);
      await applyPrecondition(preconditionName, plantFor(ADDRESSES[0]!));
      const keys = (await storedConfig()).api_keys ?? null;
      for (const address of ADDRESSES) {
        await plantAddresses(plantFor(address));
        const stored = await storedConfig();
        assert.deepEqual(stored.api_keys ?? null, keys, `${address}: the precondition's keys are still stored`);
        assert.equal(stored.embed?.base_url, address, `${address}: the address is still stored (the precondition did not clear it)`);
        assert.equal(stored.ollama_url, address);
        const label = `${preconditionName}, ${address}`;
        for (const [trigger, sent] of Object.entries(await requestsPerTrigger(urls))) {
          assert.deepEqual(sent.filter((url) => sameHost(url, address)), [], `${label}, ${trigger}: nothing sent to the stored address`);
          assert.deepEqual(sent.filter((url) => !STANDARD_ORIGINS.has(new URL(url).origin)), [], `${label}, ${trigger}: nothing sent anywhere but a named provider`);
        }
        const endpoint = await privateEndpoint();
        assert.ok(endpoint === null || !sameHost(endpoint, address), `${label}: the private model endpoint is not the stored address`);
        assert.equal((await getEmbedConfigMasked(orgId)).provider, 'off', `${label}: embeddings are off while a custom address is stored`);
        assert.equal(await wikiEmbeddingIsNull(), true, `${label}: the background job wrote no embedding`);
      }
    });
  }
}

/**
 * Which triggers fetch the stored address on a self-hosted install, per stored configuration. The rest do not by
 * design: llm() never sends Anthropic or OpenRouter to a route's address (llm(summarize) and llm(classify) in the
 * first), and tasks with no route use the org's own keys at the standard addresses (classify, summarize and extract in
 * the second). The hosted cases still run every trigger.
 */
const SELF_HOSTED_REACHES: Record<string, readonly string[]> = {
  [PLANT_EVERY_ROUTE]: ['embed()', 'embedQuiet()', 'the embed-content job', 'llm(reason)', 'llm(extract)', 'the agent loop', 'an image question'],
  [PLANT_OLLAMA_REASON]: ['embed()', 'embedQuiet()', 'the embed-content job', 'llm(reason)', 'the agent loop', 'an image question'],
};

test('canary, self-hosted: each trigger fetches the same stored address, so each hosted refusal is real', async (t) => {
  setHosted(false);
  const urls = recordFetches(t);
  const address = ADDRESSES[0]!;
  for (const [plantName, plantFor] of Object.entries(PLANTS)) {
    await db.execute(sql`UPDATE wiki_pages SET embedding = NULL WHERE id = ${wikiId}`);
    await applyPrecondition('org keys and every env key together', plantFor(address));
    const sent = await requestsPerTrigger(urls);
    for (const trigger of SELF_HOSTED_REACHES[plantName]!) {
      assert.ok(sent[trigger]?.some((url) => sameHost(url, address)), `${plantName}: ${trigger} reaches the stored address: ${JSON.stringify(sent[trigger])}`);
    }
    assert.equal(await wikiEmbeddingIsNull(), false, `${plantName}: the embed-content job wrote the vector it fetched`);
    assert.ok(sameHost((await privateEndpoint())!, address), `${plantName}: the private model endpoint is the stored address`);
  }
  await db.execute(sql`UPDATE wiki_pages SET embedding = NULL WHERE id = ${wikiId}`);
});

test('canary, hosted: a stored standard address is fetched at its standard place', async (t) => {
  setHosted(true);
  const urls = recordFetches(t);
  await applyPrecondition('a stored org key', { embed: { provider: 'openai', base_url: 'https://api.openai.com/v1' } });
  assert.equal((await embed('hello', orgId))?.length, 1536);
  assert.deepEqual(urls, ['https://api.openai.com/v1/embeddings']);
});
