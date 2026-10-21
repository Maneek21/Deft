import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {prepareModuleArtifact,type DeftAppManifestV1Input,type DeftAppManifestV2Input} from '../../core.js';
import {registerAuthorToolTemplate} from '../../author-tool-extensions.js';
async function exists(path:string){try{await access(path);return true;}catch{return false;}}
async function writeJson(path:string,value:unknown){await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n','utf8');}
export async function initializeConnected(cwd:string,automation: boolean): Promise<void> {
  const manifestPath = resolve(cwd, 'deft.app.json');
  if (await exists(manifestPath)) throw new Error('deft.app.json already exists');
  const modulePath = 'modules/connected-campaigns/deft.module.json';
  const moduleManifest = {
    schema_version: '2',
    id: 'community.example.connected-campaigns',
    slug: 'connected-campaigns',
    version: '1.0.0',
    name: 'Connected Campaigns',
    description: 'Campaign resources that reference Contacts owned by a dependency App.',
    collections: [{
      key: 'campaigns',
      name: 'Campaigns',
      singular_name: 'Campaign',
      fields: [
        { key: 'subject', label: 'Subject', type: 'text', required: true },
        { key: 'body', label: 'Body', type: 'long_text', required: true },
        {
          key: 'contacts',
          label: 'Contacts',
          type: 'resource_ref',
          target: { module_id: 'org.deft.reference.resource-contacts', resource_type: 'contacts' },
          multiple: true,
          display: 'label',
        },
      ],
      views: [
        { key: 'all', name: 'All campaigns', type: 'table', fields: ['subject', 'contacts'] },
        { key: 'detail', name: 'Campaign details', type: 'detail', fields: ['subject', 'body', 'contacts'] },
      ],
      search: { title_field: 'subject', subtitle_fields: [], fields: ['subject', 'body'] },
    }],
    navigation: { default_collection: 'campaigns', default_view: 'all' },
  };
  const artifact = await prepareModuleArtifact({ path: modulePath, manifest: moduleManifest });
  const connectedManifest: Omit<DeftAppManifestV1Input, 'schema_version' | 'compatibility'> = {
    id: 'community.example.connected-campaigns-app',
    version: '1.0.0',
    name: 'Connected Campaigns',
    description: 'A connected Deft App that relates Campaigns to Contacts and requests sandbox email.',
    license: 'AGPL-3.0-only',
    modules: [{
      module_id: moduleManifest.id,
      version: moduleManifest.version,
      manifest_path: modulePath,
      manifest_digest: artifact.digest,
    }],
    navigation: [{
      key: 'campaigns', label: 'Campaigns', module_id: moduleManifest.id,
      collection_key: 'campaigns', view_key: 'all',
    }],
    dependencies: [{
      key: 'contacts_app',
      app_id: 'org.deft.reference.resource-contacts-app',
      version: '1.0.0',
    }],
    resource_requirements: [
      {
        key: 'campaign',
        source: { kind: 'included_module', module_id: moduleManifest.id, version: moduleManifest.version },
        resource_type: 'campaigns',
        fields: ['subject', 'body', 'contacts'],
      },
      {
        key: 'contact',
        source: {
          kind: 'dependency_module',
          dependency_key: 'contacts_app',
          module_id: 'org.deft.reference.resource-contacts',
          version: '1.0.0',
        },
        resource_type: 'contacts',
        fields: ['email'],
      },
    ],
    capability_requirements: [{
      key: 'send_email',
      interface: {
        kind: 'private', namespace: 'app_lineage', key: 'sandbox_email_send', version: '1',
      },
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
  const manifest: DeftAppManifestV1Input | DeftAppManifestV2Input = automation
    ? {
        ...connectedManifest,
        schema_version: '2',
        compatibility: { app_protocol: '2' },
        automation_requests: [{
          key: 'daily_campaign_send',
          label: 'Daily campaign send',
          trigger: { kind: 'daily_local_time' },
          action_key: 'send_campaign_email',
        }],
      }
    : {
        ...connectedManifest,
        schema_version: '1',
        compatibility: { app_protocol: '1' },
      };
  await writeJson(resolve(cwd, modulePath), moduleManifest);
  await writeJson(manifestPath, manifest);
  await writeFile(resolve(cwd, 'APP_BRIEF.md'), [
    '# App brief',
    '',
    'Describe the connected workspace outcome, the resources it relates, and why each requested authority is needed.',
    '',
  ].join('\n'), 'utf8');
  await writeFile(resolve(cwd, 'AGENTS.md'), [
    '# Connected Deft App',
    '',
    '- Build only through the published `@deft/app-kit` manifest, Module, and package contracts.',
    '- Keep staging at zero authority. A workspace owner or admin reviews, binds, and activates requests.',
    '- Never add credentials, provider endpoints, executable code, arbitrary mapping, policy overrides, or Deft core edits.',
    '- Keep Contacts as an exact dependency and reference its records; do not copy them into Campaigns.',
    automation
      ? '- The automation request is declarative and requested-only. The host owns schedule, timezone, pins, budgets, policy, approval, and execution.'
      : '- The sandbox email action is single-recipient, human-initiated, and always requires host review.',
    automation
      ? '- App Protocol v2 provides only bounded daily scheduling; it does not provide workflows, custom UI, runtime, sync, or public ingress.'
      : '- App Protocol v1 does not provide automation, custom UI, runtime, sync, or public ingress.',
    '',
  ].join('\n'), 'utf8');
  await writeFile(resolve(cwd, '.gitignore'), '.deft/\n', 'utf8');
  console.log(`Initialized ${manifest.name} in ${cwd}`);
}

registerAuthorToolTemplate('connected',cwd=>initializeConnected(cwd,false));
registerAuthorToolTemplate('connected-automation',cwd=>initializeConnected(cwd,true));
