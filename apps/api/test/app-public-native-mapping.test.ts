import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePublicNativeMapping, projectPublicNativeInput, publicNativeRecordFields } from '../src/lib/app-public-native-mapping.js';

const manifest = { schema_version: '1', id: 'community.test.booking', slug: 'public-native-map', version: '1.0.0', name: 'Booking',
  collections: [{ key: 'bookings', name: 'Bookings', singular_name: 'Booking', fields: [
    { key: 'title', label: 'Title', type: 'text', required: true },
    { key: 'start_at', label: 'Start', type: 'datetime', required: true },
    { key: 'end_at', label: 'End', type: 'datetime', required: true },
    { key: 'private_note', label: 'Private note', type: 'text', required: true },
    { key: 'number', label: 'Number', type: 'number', required: true },
  ], views: [{ key: 'all', name: 'All', type: 'table', fields: ['title'] }],
  search: { title_field: 'title', subtitle_fields: [], fields: ['title'] } }],
  navigation: { default_collection: 'bookings', default_view: 'all' } };
const mapping = { title: { source: 'record.field' as const, field_key: 'title' },
  start: { source: 'record.field' as const, field_key: 'start_at' },
  end: { source: 'record.field' as const, field_key: 'end_at' },
  description: { source: 'claim.claim_id' as const } };

test('native public mapping projects only reviewed canonical scalars into certified Calendar input', () => {
  const reviewed = validatePublicNativeMapping(mapping, manifest, 'bookings', 'calendar.events.create.v1');
  assert.deepEqual(publicNativeRecordFields(reviewed), ['title', 'start_at', 'end_at']);
  const input = projectPublicNativeInput({ mapping: reviewed, resource_id: 'record-1', claim_id: 'claim-1',
    operation: 'calendar.events.create.v1', data: { title: 'Reviewed booking', start_at: '2055-11-07T01:30:00-04:00',
      end_at: '2055-11-07T01:45:00-04:00', private_note: 'NOT_SELECTED', number: 42 } });
  assert.deepEqual(input, { title: 'Reviewed booking', start: '2055-11-07T01:30:00-04:00',
    end: '2055-11-07T01:45:00-04:00', description: 'claim-1' });
  assert.equal(JSON.stringify(input).includes('NOT_SELECTED'), false);
});

test('native public mapping denies undeclared selectors, non-datetime times and invalid captured values', () => {
  for (const candidate of [
    { ...mapping, title: { source: 'record.field', field_key: 'absent' } },
    { ...mapping, start: { source: 'record.field', field_key: 'title' } },
    { ...mapping, title: { source: 'record.field', field_key: 'number' } },
    { ...mapping, start: { source: 'claim.resource_id' } },
    { ...mapping, arbitrary: { source: 'claim.resource_id' } },
    { ...mapping, title: { source: 'record.field', field_key: 'title', callback: 'ignored' } },
  ]) assert.throws(() => validatePublicNativeMapping(candidate, manifest, 'bookings', 'calendar.events.create.v1'));
  assert.throws(() => validatePublicNativeMapping(mapping, manifest, 'other', 'calendar.events.create.v1'));
  assert.throws(() => validatePublicNativeMapping(mapping, manifest, 'bookings', 'calendar.events.cancel.v1'));
  for (const data of [{ title: 'Booking', start_at: 'not-an-instant', end_at: '2055-11-07T01:45:00-04:00' },
    { title: 'Booking', start_at: '2055-11-07T01:45:00-04:00', end_at: '2055-11-07T01:30:00-04:00' },
    { title: { text: 'Booking' }, start_at: '2055-11-07T01:30:00-04:00', end_at: '2055-11-07T01:45:00-04:00' },
    { title: 'x'.repeat(201), start_at: '2055-11-07T01:30:00-04:00', end_at: '2055-11-07T01:45:00-04:00' }]) {
    assert.throws(() => projectPublicNativeInput({ mapping, data, resource_id: 'record-1', claim_id: 'claim-1', operation: 'calendar.events.create.v1' }));
  }
});
