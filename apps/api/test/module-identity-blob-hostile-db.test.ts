import './fixtures/app-run-enabled-env.js';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const safe = Boolean(safeTestDatabaseUrl());

test('hostile input: blob stage routes refuse a customer Protocol 7 App carrying exact Contacts; composition upgrades too', { skip: !safe, timeout: 120000 }, async (t) => {
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
    DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true', DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true',
    DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true' });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`tester2:${id}`).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1', run_encryption: ring('t2-enc'), receipt_signing: ring('t2-sign'), fingerprint: ring('t2-fp') });
  const [{ app }, { db, closeDb }, s, orm, kit, web, modules, bundled] = await Promise.all([
    import('../src/index.js'), import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('@deft/app-kit'),
    import('../src/lib/web-sessions.js'), import('../src/lib/module-service.js'), import('../src/lib/bundled-modules.js'),
  ]);
  t.after(async () => {
    await (await import('../src/lib/app-attachment-runtime.js')).shutdownAppAttachmentRuntime();
    await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime();
    await closeDb();
  });
  const contacts = bundled.getBundledModule('contacts')!;
  const contactsArtifact = await kit.prepareModuleArtifact({ path: 'modules/contacts/deft.module.json', manifest: contacts });
  const contactsRef = { module_id: contacts.id, version: contacts.version, manifest_path: contactsArtifact.path, manifest_digest: contactsArtifact.digest };
  const source = JSON.parse((await runtimeSecurityPackage()).json);

  async function seed(withContacts: boolean) {
    const org = randomUUID(), owner = randomUUID(), suffix = randomUUID().replaceAll('-', '');
    await db.insert(s.orgs).values({ id: org, name: 'Tester2 blob', slug: `t2-blob-${suffix}` });
    await db.insert(s.users).values({ id: owner, name: 'Owner', email: `t2-blob-${suffix}@example.test` });
    await db.insert(s.orgMembers).values({ org_id: org, user_id: owner, role: 'owner', is_active: true });
    const session = await web.createWebSession({ id: owner, org_id: org, email: `t2-blob-${suffix}@example.test` });
    const actor = modules.humanModuleActor({ orgId: org, userId: owner, role: 'owner', source: 'rest' });
    if (withContacts) {
      await modules.installModuleFromManifest(actor, contacts, { source: 'bundled' });
      await modules.updateModuleInstallation(actor, 'contacts', { enabled: false });
    }
    const request = async (path: string, method = 'GET', body?: unknown) => {
      const response = await app.request('http://localhost' + path, { method,
        headers: { authorization: `Bearer ${session.accessToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as any };
    };
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const r = await request(path, method, body); assert.ok(r.status < 300, `${path}: ${JSON.stringify(r)}`); return r.body;
    };
    const state = async () => ({
      installs: await db.select().from(s.appInstallations).where(orm.eq(s.appInstallations.org_id, org)),
      versions: await db.select().from(s.appVersions).where(orm.eq(s.appVersions.org_id, org)),
      bindings: await db.select().from(s.appModuleBindings).where(orm.eq(s.appModuleBindings.org_id, org)),
      modules: await db.select().from(s.moduleInstallations).where(orm.eq(s.moduleInstallations.org_id, org)),
    });
    return { org, suffix, request, call, state };
  }

  const ownModule = (suffix: string) => ({ schema_version: '1', id: `community.example.items.a${suffix}`, slug: `items-${suffix}`, version: '1.0.0', name: 'Items',
    collections: [{ key: 'items', name: 'Items', singular_name: 'Item', fields: [{ key: 'title', label: 'Title', type: 'text', required: true }],
      views: [{ key: 'all', name: 'All', type: 'table', fields: ['title'] }], search: { title_field: 'title', subtitle_fields: [], fields: ['title'] } }],
    navigation: { default_collection: 'items', default_view: 'all' } });

  /** A composition (Experience-bearing) Protocol 7 package. */
  async function composition(id: string, version: string, refs: unknown[], artifacts: unknown[]) {
    return kit.buildDeftAppPackage({ manifest: { ...source.manifest, id, version, modules: refs }, artifacts: [...source.artifacts, ...artifacts] } as never);
  }
  /** A plain (no action plane) Protocol 7 package for /api/apps/blob/stage. */
  async function plain(id: string, refs: unknown[], artifacts: unknown[]) {
    const { private_state: _ps, ...rest } = source.manifest;
    return kit.buildDeftAppPackage({ manifest: { ...rest, id, modules: refs, experiences: [], runtime_actions: [], private_capabilities: [],
      runtime_requirements: source.manifest.runtime_requirements.filter((r: { key: string }) => r.key === 'sync_provider') }, artifacts } as never);
  }

  const failures: string[] = [];
  const expect409 = (label: string, r: { status: number; body: any }) => {
    if (r.status !== 409 || r.body?.code !== 'MODULE_IDENTITY_RESERVED') failures.push(`${label}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  };

  for (const withContacts of [false, true]) {
    const env = await seed(withContacts);
    const before = await env.state();
    const tag = `contacts installed: ${withContacts}`;
    const plainPkg = await plain(`community.example.blob.a${env.suffix}`, [contactsRef], [contactsArtifact]);
    expect409(`blob/stage (${tag})`, await env.request('/api/apps/blob/stage', 'POST', plainPkg.json));
    const comp = await composition(`community.example.comp.a${env.suffix}`, '1.0.0', [contactsRef], [contactsArtifact]);
    expect409(`blob/composition/stage (${tag})`, await env.request('/api/apps/blob/composition/stage', 'POST', comp.json));
    // Look-alike Email ids get no exemption.
    for (const id of ['io.deft.email.x', 'io.deft.emai1', 'com.deft.email']) {
      const fake = await composition(id, '1.0.0', [contactsRef], [contactsArtifact]);
      expect409(`blob/composition/stage ${id} (${tag})`, await env.request('/api/apps/blob/composition/stage', 'POST', fake.json));
    }
    // Plain /api/apps/stage never exempts a Protocol 7 io.deft.email package.
    const email = await composition('io.deft.email', '1.0.0', [contactsRef], [contactsArtifact]);
    expect409(`apps/stage io.deft.email P7 (${tag})`, await env.request('/api/apps/stage', 'POST', email.json));
    const afterRefusals = await env.state();
    if (JSON.stringify(afterRefusals) !== JSON.stringify(before)) failures.push(`state changed after refusals (${tag})`);

    // Upgrade: a customer composition App installed without Contacts, then an upgrade that adds it.
    const own = ownModule(env.suffix);
    const ownArtifact = await kit.prepareModuleArtifact({ path: 'modules/items/deft.module.json', manifest: own });
    const ownRef = { module_id: own.id, version: own.version, manifest_path: ownArtifact.path, manifest_digest: ownArtifact.digest };
    const appId = `community.example.upgrade.a${env.suffix}`;
    const first = await composition(appId, '1.0.0', [ownRef], [ownArtifact]);
    const { app: installed } = await env.call('/api/apps/blob/composition/stage', 'POST', first.json);
    const initial = await env.call(`/api/apps/blob/composition/${installed.id}/context?app_version_id=${installed.version_id}`);
    const { review } = await env.call(`/api/apps/blob/composition/${installed.id}/review`, 'POST', initial.review_request);
    await env.call(`/api/apps/blob/composition/${installed.id}/activate`, 'POST', { ...initial.review_request, expected_review_digest: review.review_digest, accept_host_policy: true });
    const [prior] = await db.select().from(s.appInstallations).where(orm.eq(s.appInstallations.id, installed.id));
    const versionsBefore = (await env.state()).versions.length;
    const next = await composition(appId, '1.1.0', [ownRef, contactsRef], [ownArtifact, contactsArtifact]);
    const staged = await env.request(`/api/apps/blob/composition/${installed.id}/upgrade/stage`, 'POST',
      { schema_version: 'deft.app_attachment_upgrade_stage.v1', package_json: next.json, expected_lifecycle_epoch: prior!.lifecycle_epoch });
    expect409(`blob/composition/:id/upgrade/stage adds Contacts (${tag})`, staged);
    if ((await env.state()).versions.length !== versionsBefore) failures.push(`upgrade stored a version (${tag})`);
    if (staged.status < 300) {
      // If the stage got through, follow it to activation: Contacts must still not change hands.
      const contactsBefore = (await env.state()).modules.filter((m) => m.slug === 'contacts');
      const prefix = `/api/apps/blob/composition/${installed.id}/upgrade`;
      const context = await env.request(prefix + `/context?app_version_id=${staged.body.app_version_id}`);
      const upgradeReview = context.status < 300 ? await env.request(prefix + '/review', 'POST', context.body.review_request) : context;
      const activated = upgradeReview.status < 300 ? await env.request(prefix + '/activate', 'POST', {
        ...context.body.review_request, expected_review_digest: upgradeReview.body.review.review_digest, accept_host_policy: true,
      }) : upgradeReview;
      if (activated.status >= 300) failures.push(`activation detail (${tag}): ${JSON.stringify(activated.body).slice(0, 300)}`);
      const contactsAfter = (await env.state()).modules.filter((m) => m.slug === 'contacts');
      const contactsBinding = (await env.state()).bindings.filter((b) => b.module_id === contacts.id);
      failures.push(`upgrade activation (${tag}): ${activated.status} ${String(activated.body?.code ?? '')}; Contacts rows ${contactsBefore.length}→${contactsAfter.length}`
        + `; source ${contactsAfter[0]?.source ?? '-'}; enabled ${String(contactsBefore[0]?.is_enabled ?? '-')}→${String(contactsAfter[0]?.is_enabled ?? '-')}`
        + `; App bindings to Contacts ${contactsBinding.length}`);
    }
  }
  assert.deepEqual(failures, []);
});
