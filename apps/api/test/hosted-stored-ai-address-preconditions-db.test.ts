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
const PLANTS: Record<string, (address: string) => Record<string, unknown>> = {
  'every route and the embedding pinned to the address': (address) => ({
    embed: { provider: 'openai', base_url: address },
    ai_models: {
      reason: { provider: 'openai', model: 'gpt-4o', baseUrl: address },
      classify: { provider: 'openrouter', model: 'openai/gpt-4o-mini', baseUrl: address },
      summarize: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', baseUrl: address },
      extract: { provider: 'ollama', model: 'llama3.1' },
    },
    ollama_url: address,
  }),
  'reasoning through the stored Ollama address, embedding at the address': (address) => ({
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
const PRECONDITIONS: Record<string, (config: Record<string, unknown>) => Promise<void>> = {
  'no key': async (config) => {
    setEnvKeys({});
    await plant(config);
  },
  'a stored org key': async (config) => {
    setEnvKeys({});
    await plant({ ...config, api_keys: Object.fromEntries(Object.entries(orgKeys()).map(([provider, key]) => [provider, encrypt(key)])) });
  },
  'a bring-your-own key saved through the settings': async (config) => {
    setEnvKeys({});
    await plant(config);
    await bringOwnKeys();
  },
  'the platform env key (OPENAI_API_KEY)': async (config) => {
    setEnvKeys({ OPENAI_API_KEY: 'sk-env-openai-test' });
    await plant(config);
  },
  'org keys and every env key together': async (config) => {
    setEnvKeys({ OPENAI_API_KEY: 'sk-env-openai-test', ANTHROPIC_API_KEY: 'sk-ant-env-test', OPENROUTER_API_KEY: 'sk-or-env-test' });
    await plant(config);
    await bringOwnKeys();
  },
};

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

/** Trigger every path that would use a stored AI address. Failures are expected (refusals); only where requests go matters. */
async function triggerEveryUse(): Promise<{ privateEndpoint: string | null; embedProvider: string }> {
  const quietly = async (run: () => Promise<unknown>) => { try { await run(); } catch { /* a refusal */ } };
  await quietly(() => embed('hello', orgId));
  await quietly(() => embedQuiet('hello', orgId));
  await quietly(() => handleEmbedContent({ id: `job-${randomUUID()}`, name: 'embed-content', attempts: 0, data: { source_type: 'wiki_page', source_id: wikiId } }));
  const orgConfig = await getOrgAIConfig(orgId);
  for (const task of TASKS) {
    await quietly(() => llm({ task, messages: [{ role: 'user', content: 'hello' }], orgConfig, orgId }));
  }
  const resolved = await resolveReasonProvider(orgId);
  await quietly(() => createAgentMessage({ resolved, system: 'test', messages: [{ role: 'user', content: 'hello' }], tools: [], maxTokens: 16 }));
  await quietly(() => answerImageAttachmentQuestion({ orgId, bytes: PNG, mimeType: 'image/png' }));
  let privateEndpoint: string | null = null;
  try { privateEndpoint = privateDeftyEndpoint(resolved); } catch { /* refused */ }
  return { privateEndpoint, embedProvider: (await getEmbedConfigMasked(orgId)).provider };
}

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
  for (const [preconditionName, apply] of Object.entries(PRECONDITIONS)) {
    test(`hosted, ${plantName}, with ${preconditionName}: no request leaves for a stored inward or custom address`, async (t) => {
      setHosted(true);
      await db.execute(sql`UPDATE wiki_pages SET embedding = NULL WHERE id = ${wikiId}`);
      const urls = recordFetches(t);
      await apply(plantFor(ADDRESSES[0]!));
      const keys = (await storedConfig()).api_keys ?? null;
      for (const address of ADDRESSES) {
        await plantAddresses(plantFor(address));
        const stored = await storedConfig();
        assert.deepEqual(stored.api_keys ?? null, keys, `${address}: the precondition's keys are still stored`);
        assert.equal(stored.embed?.base_url, address, `${address}: the address is still stored (the precondition did not clear it)`);
        assert.equal(stored.ollama_url, address);
        const start = urls.length;
        const { privateEndpoint, embedProvider } = await triggerEveryUse();
        const sent = urls.slice(start);
        const label = `${preconditionName}, ${address}`;
        assert.deepEqual(sent.filter((url) => sameHost(url, address)), [], `${label}: nothing sent to the stored address`);
        assert.deepEqual(sent.filter((url) => !STANDARD_ORIGINS.has(new URL(url).origin)), [], `${label}: nothing sent anywhere but a named provider`);
        assert.ok(privateEndpoint === null || !sameHost(privateEndpoint, address), `${label}: the private model endpoint is not the stored address`);
        assert.equal(embedProvider, 'off', `${label}: embeddings are off while a custom address is stored`);
        const [wiki] = (await db.execute(sql`SELECT embedding IS NULL AS empty FROM wiki_pages WHERE id = ${wikiId}`)).rows as Array<{ empty: boolean }>;
        assert.equal(wiki!.empty, true, `${label}: the background job wrote no embedding`);
      }
    });
  }
}

test('canary, self-hosted: the same stored address is fetched by the same triggers, so the hosted refusals are real', async (t) => {
  setHosted(false);
  const urls = recordFetches(t);
  const address = ADDRESSES[0]!;
  for (const plantFor of Object.values(PLANTS)) {
    await PRECONDITIONS['org keys and every env key together']!(plantFor(address));
    await triggerEveryUse();
  }
  const reached = urls.filter((url) => sameHost(url, address)).map((url) => new URL(url).pathname);
  for (const path of ['/embeddings', '/chat/completions', '/api/chat']) {
    assert.ok(reached.some((reachedPath) => reachedPath.endsWith(path)), `self-hosted reaches ${path} at the stored address: ${reached.join(', ')}`);
  }
  await db.execute(sql`UPDATE wiki_pages SET embedding = NULL WHERE id = ${wikiId}`);
});

test('canary, hosted: a stored standard address is fetched at its standard place', async (t) => {
  setHosted(true);
  const urls = recordFetches(t);
  await PRECONDITIONS['a stored org key']!({ embed: { provider: 'openai', base_url: 'https://api.openai.com/v1' } });
  assert.equal((await embed('hello', orgId))?.length, 1536);
  assert.deepEqual(urls, ['https://api.openai.com/v1/embeddings']);
});
