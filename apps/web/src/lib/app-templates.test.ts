import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DeftModuleManifestV1Schema,
  isFirstPartyReservedId,
  validateModuleRecordData,
} from '@deft/shared/modules';
import {
  APP_TEMPLATES,
  appTemplateSlug,
  buildAppTemplateManifest,
  getAppTemplate,
  installAppTemplate,
  type AppTemplate,
} from './app-templates';

test('there are four starters, each a valid app file on its own with a board', () => {
  assert.deepEqual(APP_TEMPLATES.map((template) => template.key), [
    'hiring-pipeline', 'vendor-tracker', 'light-crm', 'content-calendar',
  ]);
  for (const template of APP_TEMPLATES) {
    // The raw JSON file is what the website offers for download.
    const raw = JSON.parse(readFileSync(new URL(`./app-templates/${template.key}.json`, import.meta.url), 'utf8'));
    assert.equal(DeftModuleManifestV1Schema.safeParse(raw).success, true, template.key);
    assert.equal(isFirstPartyReservedId(template.manifest.id), false);
    assert.ok(template.description.length > 0 && template.icon.length > 0);
    const defaultCollection = template.manifest.collections.find((item) => item.key === template.manifest.navigation?.default_collection);
    assert.ok(defaultCollection?.views?.some((view) => view.type === 'board'), `${template.key} opens on a record type with a board`);
    const defaultView = defaultCollection?.views?.find((view) => view.key === template.manifest.navigation?.default_view);
    assert.equal(defaultView?.type, 'board', `${template.key} opens on its board`);
    assert.doesNotMatch(`${template.name} ${template.description}`, /\b(modules?|collections?|manifests?)\b/i);
  }
});

test('every sample record is valid, and links only point at earlier samples of the linked record type', () => {
  for (const template of APP_TEMPLATES) {
    assert.ok(template.samples.length >= 3, template.key);
    const seen = new Map<string, string>();
    for (const sample of template.samples) {
      const collection = template.manifest.collections.find((item) => item.key === sample.collection);
      assert.ok(collection, `${template.key}: ${sample.collection}`);
      const result = validateModuleRecordData(template.manifest, sample.collection, sample.data);
      assert.equal(result.success, true, `${template.key}: ${JSON.stringify(result)}`);
      for (const [fieldKey, refs] of Object.entries(sample.links ?? {})) {
        const field = collection!.fields.find((item) => item.key === fieldKey);
        assert.equal(field?.type, 'relation', `${template.key}: ${fieldKey}`);
        for (const ref of Array.isArray(refs) ? refs : [refs]) {
          assert.equal(seen.get(ref), field?.type === 'relation' ? field.target_collection : undefined, `${template.key}: ${ref} comes first`);
        }
      }
      if (sample.ref) seen.set(sample.ref, sample.collection);
    }
  }
});

test('a starter is renamed for the workspace with a slug and id from the name', () => {
  const template = getAppTemplate('hiring-pipeline')!;
  const manifest = buildAppTemplateManifest(template, '  Hiring – EU team  ');
  assert.equal(manifest.name, 'Hiring – EU team');
  assert.equal(manifest.slug, 'hiring-eu-team');
  assert.equal(manifest.id, 'workspace.hiring-eu-team');
  assert.equal(manifest.collections.length, template.manifest.collections.length);
  assert.equal(appTemplateSlug(''), 'my-app');
  assert.equal(appTemplateSlug('2026 Café plans'), 'app-2026-cafe-plans');
  assert.equal(appTemplateSlug('3D printing'), 'app-3d-printing');
  assert.ok(appTemplateSlug('x'.repeat(200)).length <= 44);
  assert.throws(() => buildAppTemplateManifest(template, '<b>Hiring</b>'), (error: unknown) => (
    error instanceof Error && !/\[\s*\{|\{\s*"/.test(error.message) && /name/.test(error.message)
  ));
});

type Call = { path: string; body: Record<string, unknown> };

function fakeServer(options: { takenSlugs?: string[]; failRecordAt?: number } = {}) {
  const calls: Call[] = [];
  let recordCount = 0;
  const fetch = async (path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ path, body });
    if (path === '/api/modules/sideload') {
      if (options.takenSlugs?.includes(String(body.slug))) {
        return new Response(JSON.stringify({ error: 'An app with this id or slug is already installed', code: 'MODULE_ALREADY_INSTALLED' }), { status: 409 });
      }
      return new Response(JSON.stringify({ module: { slug: body.slug, module_id: body.id, manifest_digest: `sha256:${'a'.repeat(64)}` } }), { status: 201 });
    }
    recordCount += 1;
    if (options.failRecordAt === recordCount) {
      return new Response(JSON.stringify({ error: 'The record data is invalid', code: 'MODULE_VALIDATION_ERROR' }), { status: 400 });
    }
    return new Response(JSON.stringify({ record: { id: `record-${recordCount}` } }), { status: 201 });
  };
  return { fetch, calls };
}

test('installs as an uploaded app, retries a taken slug with -2, and seeds parents first with their links', async () => {
  const template = getAppTemplate('hiring-pipeline')!;
  const server = fakeServer({ takenSlugs: ['hiring'] });
  const result = await installAppTemplate({ template, name: 'Hiring', withSamples: true, fetch: server.fetch });
  assert.equal(result.slug, 'hiring-2');
  assert.equal(result.moduleId, 'workspace.hiring-2');
  assert.equal(result.seeded, template.samples.length);
  assert.equal(result.seedError, undefined);
  const sideloads = server.calls.filter((call) => call.path === '/api/modules/sideload');
  assert.deepEqual(sideloads.map((call) => call.body.slug), ['hiring', 'hiring-2']);
  const records = server.calls.filter((call) => call.path === '/api/modules/hiring-2/records');
  assert.equal(records.length, template.samples.length);
  assert.deepEqual(records.slice(0, 2).map((call) => call.body.collection_key), ['roles', 'roles']);
  // The first candidate links to the first role, created as record-1.
  assert.deepEqual(records[2]!.body.relations, { role_id: ['record-1'] });
  assert.deepEqual(records[3]!.body.relations, { role_id: ['record-2'] });
  for (const call of records) {
    assert.equal(call.body.expected_manifest_digest, `sha256:${'a'.repeat(64)}`);
    assert.match(String(call.body.idempotency_key), /^template:[a-f0-9]{24}:\d+$/);
  }
});

test('a known installed slug is skipped without a refused request', async () => {
  const template = getAppTemplate('vendor-tracker')!;
  const server = fakeServer();
  const result = await installAppTemplate({
    template,
    name: 'Vendors',
    withSamples: false,
    installed: [{ slug: 'vendors', moduleId: 'workspace.vendors' } as never],
    fetch: server.fetch,
  });
  assert.equal(result.slug, 'vendors-2');
  assert.equal(server.calls.length, 1);
  assert.equal(result.seeded, 0);
});

test('a seeding failure keeps the app installed and says how far it got', async () => {
  const template: AppTemplate = getAppTemplate('light-crm')!;
  const server = fakeServer({ failRecordAt: 3 });
  const result = await installAppTemplate({ template, name: 'Sales', withSamples: true, fetch: server.fetch });
  assert.equal(result.slug, 'sales');
  assert.equal(result.seeded, 2);
  assert.match(result.seedError ?? '', /^The app is installed, but only 2 of 5 sample records were added\. The record data is invalid\.$/);
});

test('an install refusal is thrown as readable text', async () => {
  const template = getAppTemplate('content-calendar')!;
  const fetch = async () => new Response(JSON.stringify({
    error: 'Only workspace owners and admins can manage apps',
    code: 'MODULE_ACCESS_DENIED',
  }), { status: 403 });
  await assert.rejects(
    () => installAppTemplate({ template, name: 'Plans', withSamples: false, fetch }),
    /^Error: Only workspace owners and admins can manage apps$/,
  );
});

test('a name that slugs to a built-in app moves on to -2, and the second install is named "<name> 2"', async () => {
  const template = getAppTemplate('light-crm')!;
  const calls: Array<Record<string, unknown>> = [];
  const fetch = async (path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push(body);
    if (body.slug === 'contacts') {
      return new Response(JSON.stringify({ error: 'The slug "contacts" belongs to Contacts, an app that ships with Deft.', code: 'MODULE_IDENTITY_RESERVED' }), { status: 409 });
    }
    return new Response(JSON.stringify({ module: { slug: body.slug, module_id: body.id, manifest_digest: `sha256:${'a'.repeat(64)}` } }), { status: 201 });
  };
  const result = await installAppTemplate({ template, name: 'Contacts', withSamples: false, fetch });
  assert.equal(result.slug, 'contacts-2');
  assert.equal(result.name, 'Contacts 2');
  assert.deepEqual(calls.map((call) => [call.slug, call.name]), [['contacts', 'Contacts'], ['contacts-2', 'Contacts 2']]);
});

test('it gives up after three refused names with a readable message', async () => {
  const template = getAppTemplate('hiring-pipeline')!;
  let count = 0;
  const fetch = async () => {
    count += 1;
    return new Response(JSON.stringify({ error: 'taken', code: 'MODULE_ALREADY_INSTALLED' }), { status: 409 });
  };
  await assert.rejects(
    () => installAppTemplate({ template, name: 'Hiring', withSamples: true, fetch }),
    /already installed\. Choose another name\./,
  );
  assert.equal(count, 3);
});

test('a first sample that fails reads "none of", and a parent without a readable id stops seeding', async () => {
  const template = getAppTemplate('hiring-pipeline')!;
  const none = fakeServer({ failRecordAt: 1 });
  const first = await installAppTemplate({ template, name: 'Hiring', withSamples: true, fetch: none.fetch });
  assert.match(first.seedError ?? '', /^The app is installed, but none of the 5 sample records were added\./);

  const unreadable = async (path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (path === '/api/modules/sideload') {
      return new Response(JSON.stringify({ module: { slug: body.slug, module_id: body.id, manifest_digest: `sha256:${'a'.repeat(64)}` } }), { status: 201 });
    }
    return new Response('ok', { status: 201 });
  };
  const second = await installAppTemplate({ template, name: 'Hiring', withSamples: true, fetch: unreadable });
  assert.equal(second.seeded, 1);
  assert.match(second.seedError ?? '', /only 1 of 5 sample records were added\. The new record could not be read back\.$/);
});

test('an install answer without a digest keeps the app and says the samples were not added', async () => {
  const template = getAppTemplate('vendor-tracker')!;
  const fetch = async () => new Response('', { status: 201 });
  const result = await installAppTemplate({ template, name: 'Vendors', withSamples: true, fetch });
  assert.equal(result.slug, 'vendors');
  assert.equal(result.seeded, 0);
  assert.match(result.seedError ?? '', /sample records were not added/);
});
