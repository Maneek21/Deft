const APP_ID = 'org.deft.contacts-crm-app';
const MODULE_ID = 'com.deft.contacts';
export const CRM_APP_VERSIONS = Object.freeze({ base: '1.8.0', connected: '1.9.0' });

export function buildContactsCrmManifest(module, artifact, { connected = true, appVersion = connected ? CRM_APP_VERSIONS.connected : CRM_APP_VERSIONS.base } = {}) {
  if (module.id !== MODULE_ID) throw new Error(`Expected canonical Contacts Module ${MODULE_ID}`);
  const manifest = {
    schema_version: connected ? '1' : '0', id: APP_ID, version: appVersion,
    name: 'Contacts CRM', description: 'Companies, contacts, opportunities, follow-ups and reviewed outreach in one workspace.',
    license: 'AGPL-3.0-only', compatibility: { app_protocol: connected ? '1' : '0' },
    modules: [{ module_id: MODULE_ID, version: module.version, manifest_path: artifact.path, manifest_digest: artifact.digest }],
    navigation: ['contacts', 'companies', 'deals', 'activities', 'outreach'].map((key) => ({ key, label: key === 'outreach' ? 'Outreach' : key[0].toUpperCase() + key.slice(1), module_id: MODULE_ID, collection_key: key })),
  };
  if (!connected) return manifest;
  const source = { kind: 'included_module', module_id: MODULE_ID, version: module.version };
  manifest.dependencies = [];
  manifest.resource_requirements = [
    { key: 'outreach', source, resource_type: 'outreach', fields: ['subject', 'body', 'contacts'] },
    { key: 'contact', source, resource_type: 'contacts', fields: ['email'] },
  ];
  manifest.capability_requirements = [{ key: 'send_email', interface: { kind: 'private', namespace: 'app_lineage', key: 'sandbox_email_send', version: '1' } }];
  manifest.connector_requirements = [{ key: 'mail_provider', provider_kind: 'mcp' }];
  manifest.actions = [{ key: 'send_outreach_email', label: 'Review outreach email', capability_requirement_key: 'send_email', connector_requirement_key: 'mail_provider', placement: { kind: 'resource_detail', resource_requirement_key: 'outreach' }, input_bindings: [
    { input_key: 'to', source: { kind: 'selected_relation_field', source_resource_requirement_key: 'outreach', relation_field_key: 'contacts', target_resource_requirement_key: 'contact', target_field_key: 'email', selection: 'one' } },
    { input_key: 'subject', source: { kind: 'resource_field', resource_requirement_key: 'outreach', field_key: 'subject' } },
    { input_key: 'body_text', source: { kind: 'resource_field', resource_requirement_key: 'outreach', field_key: 'body' } },
  ] }];
  return manifest;
}
