import {
  parseDeftModuleManifest,
  type DeftModuleManifestV1,
} from '@deft/shared/modules';

const contactsDirectory = parseDeftModuleManifest({
  schema_version: '1',
  id: 'com.deft.contacts',
  slug: 'contacts',
  version: '1.0.0',
  name: 'Contacts Directory',
  description: 'A shared directory of people and organizations your workspace works with.',
  icon: 'contact',
  collections: [
    {
      key: 'contacts',
      name: 'Contacts',
      singular_name: 'Contact',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'company', label: 'Company', type: 'text' },
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
          fields: ['name', 'company', 'email', 'role', 'status', 'last_contacted_at'],
        },
        {
          key: 'form',
          name: 'Form',
          type: 'form',
          fields: ['name', 'company', 'email', 'phone', 'role', 'status', 'last_contacted_at', 'notes'],
        },
        {
          key: 'detail',
          name: 'Details',
          type: 'detail',
          fields: ['name', 'company', 'email', 'phone', 'role', 'status', 'last_contacted_at', 'notes'],
        },
      ],
    },
  ],
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
