import type { DeftModuleManifestV1Input } from '../src/modules.js';

export function equipmentRegisterManifest(): DeftModuleManifestV1Input {
  return {
    schema_version: '1',
    id: 'community.deft.equipment-register',
    slug: 'equipment-register',
    version: '1.0.0',
    name: 'Equipment Register',
    collections: [
      {
        key: 'equipment',
        name: 'Equipment',
        singular_name: 'Asset',
        fields: [
          { key: 'name', label: 'Name', type: 'text', required: true },
          { key: 'serial_number', label: 'Serial number', type: 'text' },
          {
            key: 'status',
            label: 'Status',
            type: 'single_select',
            options: [
              { value: 'available', label: 'Available' },
              { value: 'assigned', label: 'Assigned' },
              { value: 'repair', label: 'In repair' },
            ],
            default: 'available',
          },
          { key: 'assignees', label: 'Assignees', type: 'member', multiple: true },
          { key: 'tags', label: 'Tags', type: 'tags' },
          {
            key: 'location_id',
            label: 'Location',
            type: 'relation',
            target_collection: 'locations',
          },
          { key: 'purchased_on', label: 'Purchased on', type: 'date' },
        ],
        search: {
          title_field: 'name',
          subtitle_fields: ['serial_number'],
          fields: ['name', 'serial_number', 'status', 'tags'],
        },
        views: [
          {
            key: 'table',
            name: 'All equipment',
            type: 'table',
            fields: ['name', 'serial_number', 'status', 'assignees', 'location_id'],
          },
          {
            key: 'status_board',
            name: 'By status',
            type: 'board',
            group_by: 'status',
            fields: ['name', 'serial_number', 'assignees', 'location_id'],
          },
          {
            key: 'form',
            name: 'Equipment form',
            type: 'form',
            fields: ['name', 'serial_number', 'status', 'assignees', 'tags', 'location_id', 'purchased_on'],
          },
        ],
      },
      {
        key: 'locations',
        name: 'Locations',
        singular_name: 'Location',
        fields: [
          { key: 'name', label: 'Name', type: 'text', required: true },
          { key: 'notes', label: 'Notes', type: 'long_text' },
        ],
        search: { title_field: 'name', fields: ['name'] },
        views: [{ key: 'table', name: 'All locations', type: 'table', fields: ['name'] }],
      },
    ],
    navigation: { default_collection: 'equipment', default_view: 'table' },
  };
}

export function contentCalendarManifest(): DeftModuleManifestV1Input {
  return {
    schema_version: '1',
    id: 'community.deft.content-calendar',
    slug: 'content-calendar',
    version: '1.0.0',
    name: 'Content Calendar',
    collections: [
      {
        key: 'content_items',
        name: 'Content',
        singular_name: 'Content item',
        fields: [
          { key: 'title', label: 'Title', type: 'text', required: true },
          {
            key: 'status',
            label: 'Status',
            type: 'single_select',
            options: [
              { value: 'idea', label: 'Idea' },
              { value: 'draft', label: 'Draft' },
              { value: 'scheduled', label: 'Scheduled' },
              { value: 'published', label: 'Published' },
            ],
            default: 'idea',
          },
          {
            key: 'channel',
            label: 'Channel',
            type: 'single_select',
            options: [
              { value: 'blog', label: 'Blog' },
              { value: 'social', label: 'Social' },
              { value: 'email', label: 'Email' },
            ],
          },
          { key: 'owner', label: 'Owner', type: 'member' },
          { key: 'tags', label: 'Tags', type: 'tags' },
          {
            key: 'campaign_id',
            label: 'Campaign',
            type: 'relation',
            target_collection: 'campaigns',
          },
          { key: 'publish_at', label: 'Publish at', type: 'datetime' },
        ],
        search: {
          title_field: 'title',
          subtitle_fields: ['channel', 'status'],
          fields: ['title', 'channel', 'status', 'tags'],
        },
        views: [
          {
            key: 'calendar',
            name: 'Publishing timeline',
            type: 'timeline',
            start_field: 'publish_at',
            fields: ['title', 'status', 'channel', 'owner', 'campaign_id'],
          },
          {
            key: 'workflow',
            name: 'Workflow',
            type: 'board',
            group_by: 'status',
            fields: ['title', 'channel', 'owner', 'publish_at'],
          },
        ],
      },
      {
        key: 'campaigns',
        name: 'Campaigns',
        singular_name: 'Campaign',
        fields: [
          { key: 'name', label: 'Name', type: 'text', required: true },
          { key: 'brief', label: 'Brief', type: 'long_text' },
          { key: 'lead', label: 'Lead', type: 'member' },
        ],
        search: { title_field: 'name', fields: ['name', 'brief'] },
        views: [{ key: 'table', name: 'All campaigns', type: 'table', fields: ['name', 'lead'] }],
      },
    ],
    navigation: { default_collection: 'content_items', default_view: 'calendar' },
  };
}
