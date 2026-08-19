import {
  parseDeftModuleManifest,
  type DeftModuleManifestV1,
} from '@deft/shared/modules';

const contactsDirectory = parseDeftModuleManifest({
  schema_version: '1',
  id: 'com.deft.contacts',
  slug: 'contacts',
  version: '1.1.0',
  name: 'Contacts',
  description: 'A native relationship workspace for contacts, companies, deals, and activity.',
  icon: 'contact',
  collections: [
    {
      key: 'contacts',
      name: 'Contacts',
      singular_name: 'Contact',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        // Retained for 1.0.0 record compatibility. New records should prefer
        // the normalized company_id relationship.
        { key: 'company', label: 'Company', type: 'text' },
        {
          key: 'company_id',
          label: 'Company',
          type: 'relation',
          target_collection: 'companies',
        },
        { key: 'email', label: 'Email', type: 'email' },
        { key: 'phone', label: 'Phone', type: 'text' },
        { key: 'role', label: 'Role', type: 'text' },
        {
          key: 'status',
          label: 'Status',
          type: 'single_select',
          default: 'active',
          options: [
            { value: 'lead', label: 'Lead' },
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ],
        },
        { key: 'owner', label: 'Owner', type: 'member' },
        { key: 'tags', label: 'Tags', type: 'tags' },
        { key: 'last_contacted_at', label: 'Last contacted', type: 'datetime' },
        { key: 'notes', label: 'Notes', type: 'long_text' },
      ],
      search: {
        title_field: 'name',
        subtitle_fields: ['company', 'role'],
        fields: ['name', 'company', 'email', 'phone', 'role', 'status'],
      },
      views: [
        {
          key: 'table',
          name: 'Table',
          type: 'table',
          fields: ['name', 'company_id', 'email', 'role', 'status', 'owner', 'last_contacted_at'],
        },
        {
          key: 'pipeline',
          name: 'By status',
          type: 'board',
          group_by: 'status',
          fields: ['name', 'company_id', 'email', 'owner', 'last_contacted_at'],
        },
        {
          key: 'form',
          name: 'Form',
          type: 'form',
          fields: ['name', 'company_id', 'email', 'phone', 'role', 'status', 'owner', 'tags', 'last_contacted_at', 'notes'],
        },
        {
          key: 'detail',
          name: 'Details',
          type: 'detail',
          fields: ['name', 'company_id', 'email', 'phone', 'role', 'status', 'owner', 'tags', 'last_contacted_at', 'notes'],
        },
      ],
    },
    {
      key: 'companies',
      name: 'Companies',
      singular_name: 'Company',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'website', label: 'Website', type: 'url' },
        { key: 'domain', label: 'Domain', type: 'text' },
        { key: 'industry', label: 'Industry', type: 'text' },
        {
          key: 'status',
          label: 'Status',
          type: 'single_select',
          default: 'prospect',
          options: [
            { value: 'prospect', label: 'Prospect' },
            { value: 'customer', label: 'Customer' },
            { value: 'partner', label: 'Partner' },
            { value: 'inactive', label: 'Inactive' },
          ],
        },
        { key: 'owner', label: 'Owner', type: 'member' },
        { key: 'tags', label: 'Tags', type: 'tags' },
        { key: 'notes', label: 'Notes', type: 'long_text' },
      ],
      search: {
        title_field: 'name',
        subtitle_fields: ['domain', 'industry'],
        fields: ['name', 'domain', 'industry', 'status', 'tags'],
      },
      views: [
        {
          key: 'table',
          name: 'Table',
          type: 'table',
          fields: ['name', 'domain', 'industry', 'status', 'owner'],
        },
        {
          key: 'pipeline',
          name: 'By status',
          type: 'board',
          group_by: 'status',
          fields: ['name', 'domain', 'industry', 'owner'],
        },
        {
          key: 'form',
          name: 'Form',
          type: 'form',
          fields: ['name', 'website', 'domain', 'industry', 'status', 'owner', 'tags', 'notes'],
        },
        {
          key: 'detail',
          name: 'Details',
          type: 'detail',
          fields: ['name', 'website', 'domain', 'industry', 'status', 'owner', 'tags', 'notes'],
        },
      ],
    },
    {
      key: 'deals',
      name: 'Deals',
      singular_name: 'Deal',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        {
          key: 'company_id',
          label: 'Company',
          type: 'relation',
          target_collection: 'companies',
        },
        {
          key: 'primary_contact_id',
          label: 'Primary contact',
          type: 'relation',
          target_collection: 'contacts',
        },
        { key: 'value', label: 'Value', type: 'number' },
        {
          key: 'stage',
          label: 'Stage',
          type: 'single_select',
          default: 'lead',
          options: [
            { value: 'lead', label: 'Lead' },
            { value: 'qualified', label: 'Qualified' },
            { value: 'proposal', label: 'Proposal' },
            { value: 'negotiation', label: 'Negotiation' },
            { value: 'won', label: 'Won' },
            { value: 'lost', label: 'Lost' },
          ],
        },
        { key: 'close_date', label: 'Close date', type: 'date' },
        { key: 'owner', label: 'Owner', type: 'member' },
        { key: 'tags', label: 'Tags', type: 'tags' },
        { key: 'notes', label: 'Notes', type: 'long_text' },
      ],
      search: {
        title_field: 'name',
        subtitle_fields: ['stage'],
        fields: ['name', 'stage', 'value', 'tags'],
      },
      views: [
        {
          key: 'pipeline',
          name: 'Pipeline',
          type: 'board',
          group_by: 'stage',
          fields: ['name', 'company_id', 'primary_contact_id', 'value', 'owner', 'close_date'],
        },
        {
          key: 'timeline',
          name: 'Close timeline',
          type: 'timeline',
          start_field: 'close_date',
          fields: ['name', 'company_id', 'stage', 'value', 'owner'],
        },
        {
          key: 'table',
          name: 'Table',
          type: 'table',
          fields: ['name', 'company_id', 'primary_contact_id', 'value', 'stage', 'owner', 'close_date'],
        },
        {
          key: 'form',
          name: 'Form',
          type: 'form',
          fields: ['name', 'company_id', 'primary_contact_id', 'value', 'stage', 'close_date', 'owner', 'tags', 'notes'],
        },
        {
          key: 'detail',
          name: 'Details',
          type: 'detail',
          fields: ['name', 'company_id', 'primary_contact_id', 'value', 'stage', 'close_date', 'owner', 'tags', 'notes'],
        },
      ],
    },
    {
      key: 'activities',
      name: 'Activities',
      singular_name: 'Activity',
      fields: [
        { key: 'subject', label: 'Subject', type: 'text', required: true },
        {
          key: 'kind',
          label: 'Type',
          type: 'single_select',
          default: 'note',
          options: [
            { value: 'call', label: 'Call' },
            { value: 'email', label: 'Email' },
            { value: 'meeting', label: 'Meeting' },
            { value: 'note', label: 'Note' },
          ],
        },
        { key: 'occurred_at', label: 'Occurred at', type: 'datetime' },
        {
          key: 'contact_id',
          label: 'Contact',
          type: 'relation',
          target_collection: 'contacts',
        },
        {
          key: 'company_id',
          label: 'Company',
          type: 'relation',
          target_collection: 'companies',
        },
        {
          key: 'deal_id',
          label: 'Deal',
          type: 'relation',
          target_collection: 'deals',
        },
        { key: 'owner', label: 'Owner', type: 'member' },
        { key: 'notes', label: 'Notes', type: 'long_text' },
      ],
      search: {
        title_field: 'subject',
        subtitle_fields: ['kind', 'occurred_at'],
        fields: ['subject', 'kind', 'occurred_at', 'notes'],
      },
      views: [
        {
          key: 'timeline',
          name: 'Timeline',
          type: 'timeline',
          start_field: 'occurred_at',
          fields: ['subject', 'kind', 'contact_id', 'company_id', 'deal_id', 'owner'],
        },
        {
          key: 'table',
          name: 'Table',
          type: 'table',
          fields: ['subject', 'kind', 'occurred_at', 'contact_id', 'company_id', 'deal_id', 'owner'],
        },
        {
          key: 'form',
          name: 'Form',
          type: 'form',
          fields: ['subject', 'kind', 'occurred_at', 'contact_id', 'company_id', 'deal_id', 'owner', 'notes'],
        },
        {
          key: 'detail',
          name: 'Details',
          type: 'detail',
          fields: ['subject', 'kind', 'occurred_at', 'contact_id', 'company_id', 'deal_id', 'owner', 'notes'],
        },
      ],
    },
  ],
  navigation: { default_collection: 'contacts', default_view: 'table' },
});

const bundledModules = new Map<string, DeftModuleManifestV1>([
  [contactsDirectory.slug, contactsDirectory],
]);

export function listBundledModules(): DeftModuleManifestV1[] {
  return [...bundledModules.values()];
}

export function getBundledModule(slug: string): DeftModuleManifestV1 | null {
  return bundledModules.get(slug) ?? null;
}
