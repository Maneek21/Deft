export const validEquipmentModule = {
  schema_version: '1',
  id: 'org.example.equipment',
  slug: 'equipment',
  version: '1.0.0',
  name: 'Equipment',
  collections: [
    {
      key: 'assets',
      name: 'Assets',
      fields: [
        { key: 'label', label: 'Label', type: 'text', required: true },
        {
          key: 'condition',
          label: 'Condition',
          type: 'single_select',
          options: [
            { value: 'ready', label: 'Ready' },
            { value: 'repair', label: 'Repair' },
          ],
          default: 'ready',
        },
        { key: 'replacement_cost', label: 'Replacement cost', type: 'number' },
        {
          key: 'currency',
          label: 'Currency',
          type: 'single_select',
          options: [{ value: 'usd', label: 'USD' }],
          default: 'usd',
        },
        { key: 'site', label: 'Site', type: 'relation', target_collection: 'sites' },
      ],
      search: {
        title_field: 'label',
        subtitle_fields: ['condition'],
        fields: ['label', 'condition'],
      },
      views: [{
        key: 'by_condition',
        name: 'By condition',
        type: 'board',
        fields: ['label', 'condition', 'replacement_cost', 'currency'],
        group_by: 'condition',
        summary: { value_field: 'replacement_cost', unit_field: 'currency' },
      }],
      latest_related: [{
        key: 'latest_inspection',
        label: 'Latest inspection',
        source_collection: 'inspections',
        relation_field: 'asset',
        date_field: 'inspected_on',
        where: [{ field: 'result', values: ['pass'] }],
      }],
    },
    {
      key: 'sites',
      name: 'Sites',
      fields: [{ key: 'label', label: 'Label', type: 'text', required: true }],
    },
    {
      key: 'inspections',
      name: 'Inspections',
      fields: [
        { key: 'asset', label: 'Asset', type: 'relation', target_collection: 'assets' },
        { key: 'inspected_on', label: 'Inspected on', type: 'date' },
        {
          key: 'result',
          label: 'Result',
          type: 'single_select',
          options: [
            { value: 'pass', label: 'Pass' },
            { value: 'fail', label: 'Fail' },
          ],
        },
      ],
    },
  ],
  navigation: { default_collection: 'assets', default_view: 'by_condition' },
} as const;

type MutableManifest = Record<string, any>;

export const moduleSemanticNegativeCorpus: readonly Readonly<{
  name: string;
  expectedPath: RegExp;
  mutate(manifest: MutableManifest): void;
}>[] = [
  {
    name: 'bad relation target',
    expectedPath: /target_collection/,
    mutate: (manifest) => { manifest.collections[0].fields[4].target_collection = 'missing_sites'; },
  },
  {
    name: 'invalid latest-related rule',
    expectedPath: /latest_related/,
    mutate: (manifest) => { manifest.collections[0].latest_related[0].date_field = 'result'; },
  },
  {
    name: 'invalid board summary reference',
    expectedPath: /summary/,
    mutate: (manifest) => { manifest.collections[0].views[0].summary.value_field = 'label'; },
  },
  {
    name: 'invalid field default',
    expectedPath: /default/,
    mutate: (manifest) => { manifest.collections[0].fields[1].default = 'retired'; },
  },
  {
    name: 'invalid search fields',
    expectedPath: /search/,
    mutate: (manifest) => { manifest.collections[0].search.fields = ['condition']; },
  },
  {
    name: 'invalid navigation target',
    expectedPath: /navigation\.default_view/,
    mutate: (manifest) => { manifest.navigation.default_view = 'missing_view'; },
  },
  {
    name: 'unsupported schema version',
    expectedPath: /schema_version/,
    mutate: (manifest) => { manifest.schema_version = '3'; },
  },
];
