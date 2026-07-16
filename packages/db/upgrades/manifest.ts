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
  migrations: [] satisfies UpgradeMigration[],
} as const;

export type UpgradeManifest = typeof upgradeManifest;
