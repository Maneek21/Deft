import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AppExperienceSessionAuthoritySchema, AppInstallationAuthoritySchema,
  AppPublicPrincipalSchema, AppRuntimeSessionAuthoritySchema, isSameAppInstallationAuthority,
} from '../src/app-platform-authority';
import {
  CapabilityInvocationProviderRefSchema, CapabilityInvocationRequestSchema,
  CapabilityProviderIdentitySchema,
} from '../src/capabilities';

const installation = {
  org_id: 'org-1', app_installation_id: 'install-1', app_version_id: 'version-1',
  lifecycle_epoch: 3, grant_epoch: 7,
};
const runtime = {
  ...installation, audience: 'app_runtime', runtime_registration_id: 'runtime-1',
  runtime_binding_id: 'binding-1', runtime_epoch: 2, session_id: 'runtime-session-1', session_epoch: 1,
};
const publicPrincipal = { ...installation, audience: 'app_public', endpoint_id: 'endpoint-1', endpoint_epoch: 4 };
const experience = { ...installation, audience: 'app_experience', user_id: 'user-1', session_id: 'ui-1', session_epoch: 1 };

test('audiences are disjoint and carry no employee or caller-supplied grant authority', () => {
  const pairs = [
    [AppRuntimeSessionAuthoritySchema, runtime],
    [AppPublicPrincipalSchema, publicPrincipal],
    [AppExperienceSessionAuthoritySchema, experience],
  ] as const;
  for (const [schema, value] of pairs) {
    assert.equal(schema.safeParse(value).success, true);
    for (const [, foreign] of pairs) if (foreign !== value) assert.equal(schema.safeParse(foreign).success, false);
    for (const field of ['employee_id', 'effective_grant', 'permissions', 'token', 'unknown']) {
      assert.equal(schema.safeParse({ ...value, [field]: 'injected' }).success, false);
    }
  }
});

test('installation pins distinguish organization, installation, version and every epoch', () => {
  assert.equal(isSameAppInstallationAuthority(installation, { ...installation }), true);
  for (const field of ['org_id', 'app_installation_id', 'app_version_id'] as const) {
    assert.equal(isSameAppInstallationAuthority(installation, { ...installation, [field]: 'foreign' }), false);
  }
  for (const field of ['lifecycle_epoch', 'grant_epoch'] as const) {
    assert.equal(isSameAppInstallationAuthority(installation, { ...installation, [field]: installation[field] + 1 }), false);
    for (const value of [-1, 0.5, '1', NaN, Infinity, 2_147_483_648]) {
      assert.equal(AppInstallationAuthoritySchema.safeParse({ ...installation, [field]: value }).success, false);
    }
  }
});

test('host identity contracts reject missing, padded, oversized and control-character identities', () => {
  for (const value of ['', ' org-1', 'org-1 ', 'org\n1', 'x'.repeat(129)]) {
    assert.equal(AppInstallationAuthoritySchema.safeParse({ ...installation, org_id: value }).success, false);
  }
  const { app_version_id: omitted, ...missing } = installation;
  assert.equal(AppInstallationAuthoritySchema.safeParse(missing).success, false);
  assert.equal(AppInstallationAuthoritySchema.safeParse({ ...installation, ignored: true }).success, false);
});

test('Runtime provider identity does not open the legacy capability invocation entrance', () => {
  assert.equal(CapabilityProviderIdentitySchema.safeParse({
    org_id: 'org-1', provider_kind: 'app_runtime', provider_instance_id: 'runtime-1',
  }).success, true);
  const request = {
    org_id: 'org-1', actor: { user_id: 'user-1' }, input: {},
    provider: { provider_kind: 'mcp', connection_slug: 'provider-1', operation_name: 'send' },
  };
  assert.equal(CapabilityInvocationRequestSchema.safeParse(request).success, true);
  assert.equal(CapabilityInvocationRequestSchema.safeParse({
    ...request, provider: { ...request.provider, provider_kind: 'app_runtime' },
  }).success, false);
  assert.equal(CapabilityInvocationProviderRefSchema.safeParse({
    provider_kind: 'mcp', requested_provider_key: 'provider-1',
    resolved_provider: { org_id: 'org-1', provider_kind: 'app_runtime', provider_instance_id: 'runtime-1' },
  }).success, false);
});
