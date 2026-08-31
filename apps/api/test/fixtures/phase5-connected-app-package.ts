import {
  buildDeftAppPackage,
  prepareModuleArtifact,
  type DeftAppManifestV1Input,
} from '@deft/app-kit';

const contactModule = {
  schema_version: '1',
  id: 'community.deft.contacts',
  slug: 'connected-contacts',
  version: '1.0.0',
  name: 'Connected Contacts',
  collections: [{
    key: 'contacts',
    name: 'Contacts',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'email', label: 'Email', type: 'email' },
    ],
    views: [{ key: 'detail', name: 'Contact', type: 'detail', fields: ['name', 'email'] }],
    search: { title_field: 'name', subtitle_fields: ['email'], fields: ['name', 'email'] },
  }],
} as const;

const campaignModule = {
  schema_version: '2',
  id: 'community.deft.connected-campaigns',
  slug: 'connected-campaigns',
  version: '3.0.0',
  name: 'Connected Campaigns',
  collections: [{
    key: 'campaigns',
    name: 'Campaigns',
    fields: [
      { key: 'subject', label: 'Subject', type: 'text', required: true },
      { key: 'body', label: 'Body', type: 'long_text', required: true },
      {
        key: 'contacts',
        label: 'Contacts',
        type: 'resource_ref',
        target: { module_id: 'community.deft.contacts', resource_type: 'contacts' },
        multiple: true,
        display: 'label',
      },
    ],
    views: [{ key: 'detail', name: 'Campaign', type: 'detail', fields: ['subject', 'body', 'contacts'] }],
  }],
} as const;

export async function buildPhase5DependencyAppPackage() {
  const artifact = await prepareModuleArtifact({
    path: 'modules/connected-contacts/deft.module.json',
    manifest: contactModule,
  });
  return buildDeftAppPackage({
    manifest: {
      schema_version: '0',
      id: 'community.deft.contacts-app',
      version: '1.0.0',
      name: 'Connected Contacts',
      license: 'AGPL-3.0-only',
      compatibility: { app_protocol: '0' },
      modules: [{
        module_id: contactModule.id,
        version: contactModule.version,
        manifest_path: artifact.path,
        manifest_digest: artifact.digest,
      }],
      navigation: [{
        key: 'contacts',
        label: 'Contacts',
        module_id: contactModule.id,
        collection_key: 'contacts',
        view_key: 'detail',
      }],
    },
    artifacts: [artifact],
  });
}

export async function buildPhase5ConnectedAppPackage() {
  const artifact = await prepareModuleArtifact({
    path: 'modules/connected-campaigns/deft.module.json',
    manifest: campaignModule,
  });
  const manifest: DeftAppManifestV1Input = {
    schema_version: '1',
    id: 'community.deft.connected-campaigns-app',
    version: '3.0.0',
    name: 'Connected Campaigns',
    license: 'AGPL-3.0-only',
    compatibility: { app_protocol: '1' },
    modules: [{
      module_id: campaignModule.id,
      version: campaignModule.version,
      manifest_path: artifact.path,
      manifest_digest: artifact.digest,
    }],
    navigation: [{
      key: 'campaigns',
      label: 'Campaigns',
      module_id: campaignModule.id,
      collection_key: 'campaigns',
      view_key: 'detail',
    }],
    dependencies: [{
      key: 'contacts_app',
      app_id: 'community.deft.contacts-app',
      version: '1.0.0',
    }],
    resource_requirements: [
      {
        key: 'campaign',
        source: { kind: 'included_module', module_id: campaignModule.id, version: campaignModule.version },
        resource_type: 'campaigns',
        fields: ['subject', 'body', 'contacts'],
      },
      {
        key: 'contact',
        source: {
          kind: 'dependency_module',
          dependency_key: 'contacts_app',
          module_id: 'community.deft.contacts',
          version: '1.0.0',
        },
        resource_type: 'contacts',
        fields: ['email'],
      },
    ],
    capability_requirements: [{
      key: 'send_email',
      interface: { kind: 'private', namespace: 'app_lineage', key: 'sandbox_email_send', version: '1' },
    }],
    connector_requirements: [{ key: 'mail_provider', provider_kind: 'mcp' }],
    actions: [{
      key: 'send_campaign_email',
      label: 'Send campaign email',
      capability_requirement_key: 'send_email',
      connector_requirement_key: 'mail_provider',
      placement: { kind: 'resource_detail', resource_requirement_key: 'campaign' },
      input_bindings: [
        {
          input_key: 'to',
          source: {
            kind: 'selected_relation_field',
            source_resource_requirement_key: 'campaign',
            relation_field_key: 'contacts',
            target_resource_requirement_key: 'contact',
            target_field_key: 'email',
            selection: 'one',
          },
        },
        {
          input_key: 'subject',
          source: { kind: 'resource_field', resource_requirement_key: 'campaign', field_key: 'subject' },
        },
        {
          input_key: 'body_text',
          source: { kind: 'resource_field', resource_requirement_key: 'campaign', field_key: 'body' },
        },
      ],
    }],
  };
  return buildDeftAppPackage({ manifest, artifacts: [artifact] });
}
