const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** An exact bounded list of record identifiers; resolution and authority stay host-owned. */
export function parseResourceRecordList(value: string, { maxItems = 25, allowEmpty = false }: { maxItems?: number; allowEmpty?: boolean } = {}): readonly string[] {
  if (typeof value !== 'string' || value.length > 925 || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 25)
    throw new Error('RESOURCE_RECORD_LIST_INVALID');
  if (value === '' && allowEmpty === true) return Object.freeze([]);
  const rows = value.split(',');
  if (rows.length < 1 || rows.length > maxItems || rows.some(row => !uuid.test(row))
    || new Set(rows.map(row => row.toLowerCase())).size !== rows.length) throw new Error('RESOURCE_RECORD_LIST_INVALID');
  return Object.freeze(rows.map(row => row.toLowerCase()));
}
