export type UpgradeMigration = {
  version: string;
  file: string;
  description: string;
};

export type SchemaRequirement = {
  table: string;
  column?: string;
};

export const upgradeManifest = {
  schema: 'deft.upgrades.v1',
  baseline: {
    version: '0.2.0-preview.1',
    releaseTag: 'v0.2.0-preview.1',
    requirements: [
      { table: 'orgs' },
      { table: 'users', column: 'notification_preferences' },
      { table: 'tasks' },
      { table: 'messages' },
      { table: 'wiki_pages', column: 'origin_space_id' },
      { table: 'wiki_citations', column: 'source_space_id' },
      { table: 'work_intents' },
      { table: 'message_observations' },
      { table: 'teams' },
      { table: 'team_members' },
      { table: 'team_resources' },
      { table: 'team_dashboard_snapshots' },
    ] satisfies SchemaRequirement[],
    requiredExtensions: ['vector'],
    requiredIndexes: [
      'agent_employee_templates_org_slug_uniq',
      'work_intent_dedupe_unique',
      'message_observation_message_version_unique',
      'teams_org_handle_unique',
    ],
  },
  migrations: [
    {
      version: '0.2.0-preview.2',
      file: '0.2.0-preview.2-automation-runs.sql',
      description: 'Add durable automation runs and meeting brief idempotency',
    },
    {
      version: '0.2.0-preview.3',
      file: '0.2.0-preview.3-attention-notifications.sql',
      description: 'Add durable attention lifecycle, delivery ledger, approvers, and browser subscriptions',
    },
    {
      version: '0.2.0-preview.4',
      file: '0.2.0-preview.4-security-content-redaction.sql',
      description: 'Redact legacy cross-reference, reminder, notification, and restricted clip-derived text',
    },
    {
      version: '0.2.0-preview.5',
      file: '0.2.0-preview.5-job-queue-hardening.sql',
      description: 'Add tenant-aware dedupe, renewable leases, and race-safe recurring jobs',
    },
    {
      version: '0.2.0-preview.6',
      file: '0.2.0-preview.6-modules-v1.sql',
      description: 'Add declarative module installations, immutable versions, records, and native search',
    },
    {
      version: '0.2.0-preview.7',
      file: '0.2.0-preview.7-module-relations-views.sql',
      description: 'Add normalized module record relations and personal saved views',
    },
    {
      version: '0.3.0-preview.4',
      file: '0.3.0-preview.4-agent-channel-leases.sql',
      description: 'Add single-flight Agent Channel leases and truthful work outcomes',
    },
    {
      version: '0.3.0-preview.5',
      file: '0.3.0-preview.5-wiki-memory-sync.sql',
      description: 'Add idempotent Hermes-to-wiki memory reconciliation receipts',
    },
  ] satisfies UpgradeMigration[],
} as const;

export type UpgradeManifest = typeof upgradeManifest;
