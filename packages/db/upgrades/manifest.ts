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
    {
      version: '0.3.0-preview.25',
      file: '0.3.0-preview.25-app-origin-run-cutover.sql',
      description: 'Permit exact tenant-bound App-origin Run ancestry behind the production rollout gate',
    },
    {
      version: '0.3.0-preview.26',
      file: '0.3.0-preview.26-app-automation-foundation.sql',
      description: 'Add dormant approved App automation definitions, fire identities, and exact Run lineage',
    },
    {
      version: '0.3.0-preview.27',
      file: '0.3.0-preview.27-web-session-families.sql',
      description: 'Add durable browser session families for rotation and immediate revocation; legacy browser sessions require sign-in',
    },
    {
      version: '0.3.0-preview.28',
      file: '0.3.0-preview.28-password-generation.sql',
      description: 'Invalidate outstanding browser password reset links after credential changes',
    },
    {
      version: '0.3.0-preview.29',
      file: '0.3.0-preview.29-native-create-requests.sql',
      description: 'Persist scoped native create identities for safe explicit retries',
    },
    {
      version: '0.3.0-preview.30',
      file: '0.3.0-preview.30-module-record-merges.sql',
      description: 'Preserve tenant-bound original values and link provenance for reviewed Module record merges',
    },
    {
      version: '0.3.0-preview.31',
      file: '0.3.0-preview.31-app-runtime-channel.sql',
      description: 'Add dormant reviewed Runtime ancestry, sessions and fenced Run attempts',
    },
    {
      version: '0.3.0-preview.32',
      file: '0.3.0-preview.32-app-public-claims.sql',
      description: 'Add dormant public endpoints, retained ingress and canonical exclusive claims',
    },
    {
      version: '0.3.0-preview.33',
      file: '0.3.0-preview.33-app-runtime-authoring.sql',
      description: 'Permit explicitly reviewed Runtime App protocol v3 with effective grant coherence',
    },
    {
      version: '0.3.0-preview.34',
      file: '0.3.0-preview.34-app-installed-authoring.sql',
      description: 'Permit additive installed Runtime App protocol v4 with effective grant coherence',
    },
    {
      version: '0.3.0-preview.35',
      file: '0.3.0-preview.35-app-public-runtime.sql',
      description: 'Bind reviewed public ingress principals to one governed Runtime Run',
    },
    {
      version: '0.3.0-preview.36',
      file: '0.3.0-preview.36-app-experience-sessions.sql',
      description: 'Pin installed Experience sessions to authenticated web and App authority',
    },
    {
      version: '0.3.0-preview.37',
      file: '0.3.0-preview.37-app-resource-sync.sql',
      description: 'Add dormant host-reviewed resource sync bindings, sessions, intent and encrypted projections',
    },
    {
      version: '0.3.0-preview.38',
      file: '0.3.0-preview.38-app-resource-authoring.sql',
      description: 'Permit reviewed App Protocol v5 stage and activation with pinned resource descriptors',
    },
    {
      version: '0.3.0-preview.39',
      file: '0.3.0-preview.39-app-resource-consent.sql',
      description: 'Prevent duplicate current owner-private resource consent for one reviewed App grant',
    },
    {
      version: '0.3.0-preview.40',
      file: '0.3.0-preview.40-app-experience-resource-exposure.sql',
      description: 'Add dormant immutable human session consent for exact Experience private-field disclosure',
    },
    {
      version: '0.3.0-preview.41',
      file: '0.3.0-preview.41-app-public-availability.sql',
      description: 'Add optional reviewed scalar public availability and canonical claim deadlines',
    },
    {
      version: '0.3.0-preview.42',
      file: '0.3.0-preview.42-app-public-budgets.sql',
      description: 'Add reviewed public endpoint budgets and fresh canonical reservation charge instants',
    },
    {
      version: '0.3.0-preview.43', file: '0.3.0-preview.43-app-public-hmac.sql',
      description: 'Add reviewed signed public ingress key versions and bounded durable nonce receipts',
    },
    {
      version: '0.3.0-preview.44', file: '0.3.0-preview.44-app-native-calendar.sql',
      description: 'Add separately consented host-native Calendar bindings and exact protocol 6 Run/public ancestry',
    },
    { version: '0.3.0-preview.45', file: '0.3.0-preview.45-app-resource-access.sql', description: 'Add dormant immutable exact-content human private App resource sharing' },
    { version: '0.3.0-preview.46', file: '0.3.0-preview.46-app-public-control.sql', description: 'Add retained public controls and atomic pre-effect withdrawal identities' },
    { version: '0.3.0-preview.47', file: '0.3.0-preview.47-app-attachment-custody.sql', description: 'Add dormant protocol7/channel3 encrypted owner-only attachment quarantine and checked parent custody' },
    { version: '0.3.0-preview.48', file: '0.3.0-preview.48-app-public-cancellation.sql', description: 'Add explicit current-owner public cancellation selection and bounded historical create consent' },
    { version: '0.3.0-preview.49', file: '0.3.0-preview.49-app-private-mcp.sql', description: 'Add dormant independent exact-purpose first-class MCP private resource grants' },
    { version: '0.3.0-preview.50', file: '0.3.0-preview.50-app-attachment-grant-admission.sql', description: 'Admit closed owner-only protocol7 effective grants and bounded checkpoint custody accounting' },
    { version: '0.3.0-preview.51', file: '0.3.0-preview.51-app-attachment-composition.sql', description: 'Admit separately reviewed protocol7 blob-grant.v2 Runtime and Experience composition without widening v1' },
    { version: '0.3.0-preview.52', file: '0.3.0-preview.52-private-defty-context.sql', description: 'Add permanent exact Defty Space seals, reviewed private-purpose grants and bounded encrypted canonical message history' },
    { version: '0.3.0-preview.53', file: '0.3.0-preview.53-app-private-state.sql', description: 'Add dormant encrypted artifact-bound owner-private App state with revision CAS and bounded retention' },
    { version: '0.3.0-preview.54', file: '0.3.0-preview.54-app-experience-consent.sql', description: 'Add revocable exact-scope human Experience consent independent of technical leases and separate bounded agent policies' },
    { version: '0.3.0-preview.55', file: '0.3.0-preview.55-app-action-batches.sql', description: 'Group bounded immutable Runtime Run inputs under one exact host review with revocable per-effect release fencing' },
    { version: '0.3.0-preview.56', file: '0.3.0-preview.56-app-action-batch-policy-revision.sql', description: 'Pin every batch to its exact owner policy revision and fail closed for unpinned preview55 batches' },
  ] satisfies UpgradeMigration[],
} as const;

export type UpgradeManifest = typeof upgradeManifest;
