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
    {
      version: '0.3.0-preview.6',
      file: '0.3.0-preview.6-agent-channel-v2.sql',
      description: 'Require the lease-safe Agent Channel v2 compatibility contract',
    },
    {
      version: '0.3.0-preview.7',
      file: '0.3.0-preview.7-agent-channel-runtime-reconciliation.sql',
      description: 'Reconcile durable runtime effects before uncertain Agent Channel terminal outcomes',
    },
    {
      version: '0.3.0-preview.14',
      file: '0.3.0-preview.14-attachment-links.sql',
      description: 'Add tenant-bound message and task attachment links with legacy backfill',
    },
    {
      version: '0.3.0-preview.15',
      file: '0.3.0-preview.15-attachment-processing.sql',
      description: 'Add bounded attachment processing metadata and permission-inheriting derivatives',
    },
    {
      version: '0.3.0-preview.16',
      file: '0.3.0-preview.16-declarative-apps-v0.sql',
      description: 'Add declarative App v0 installations, immutable versions, and owned Module bindings',
    },
    {
      version: '0.3.0-preview.17',
      file: '0.3.0-preview.17-governed-app-runs-foundation.sql',
      description: 'Add dormant governed App Run metadata, encrypted payload, attempt, event, and receipt boundaries',
    },
    {
      version: '0.3.0-preview.18',
      file: '0.3.0-preview.18-governed-app-run-engine-hardening.sql',
      description: 'Harden dormant App Run replay, cancellation, retry ancestry, and attempt fencing',
    },
    {
      version: '0.3.0-preview.19',
      file: '0.3.0-preview.19-governed-app-run-cutover-gate.sql',
      description: 'Fail closed on App Run release, budget, approval-link, replay-horizon, and attempt dispatch boundaries',
    },
    {
      version: '0.3.0-preview.20',
      file: '0.3.0-preview.20-app-run-live-authority-versions.sql',
      description: 'Add monotonic live authority versions for governed App Run authorization rechecks',
    },
    {
      version: '0.3.0-preview.21',
      file: '0.3.0-preview.21-app-run-ancestry-guard.sql',
      description: 'Guard child App Run lineage, authorization ceilings, and root budget continuity',
    },
    {
      version: '0.3.0-preview.22',
      file: '0.3.0-preview.22-resource-relations.sql',
      description: 'Add tenant-bound, live-authorized resource relation sets, edges, and replay receipts',
    },
    {
      version: '0.3.0-preview.23',
      file: '0.3.0-preview.23-connected-app-grants-foundation.sql',
      description: 'Add immutable connected-App grant requests, exact binding lineage, and dormant App Run identities',
    },
    {
      version: '0.3.0-preview.24',
      file: '0.3.0-preview.24-connected-app-review-lifecycle.sql',
      description: 'Enable reviewed connected-App grants, immutable supersession, and lifecycle coherence',
    },
  ] satisfies UpgradeMigration[],
} as const;

export type UpgradeManifest = typeof upgradeManifest;
