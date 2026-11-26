/**
 * A small JSON Schema checker for the keywords the app file schema uses. It
 * refuses any keyword it does not understand, so a schema change can never
 * make these tests pass by being ignored.
 */
const KNOWN = new Set([
  '$schema', '$id', 'title', 'description', 'default', 'type', 'properties', 'required',
  'additionalProperties', 'anyOf', 'oneOf', 'const', 'enum', 'items', 'minItems', 'maxItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
]);

type Schema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  return expected === actual || (expected === 'number' && actual === 'integer');
}

/** Problems found, as "path: reason"; empty when the value fits. */
export function validateJsonSchema(schema: Schema, value: unknown, path = '$'): string[] {
  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) throw new Error(`Unsupported JSON Schema keyword ${key} at ${path}`);
  }
  const problems: string[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
    if (!types.some((type) => typeMatches(type, value))) return [`${path}: expected ${types.join('|')}`];
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) problems.push(`${path}: expected const`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    problems.push(`${path}: not in enum`);
  }
  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) problems.push(`${path}: too short`);
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) problems.push(`${path}: too long`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) problems.push(`${path}: pattern`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) problems.push(`${path}: below minimum`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) problems.push(`${path}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) problems.push(`${path}: too few items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) problems.push(`${path}: too many items`);
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, index) => problems.push(...validateJsonSchema(schema.items as Schema, item, `${path}[${index}]`)));
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in record)) problems.push(`${path}: missing required ${key}`);
    }
    for (const [key, item] of Object.entries(record)) {
      if (properties[key]) problems.push(...validateJsonSchema(properties[key]!, item, `${path}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${path}: unknown key ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        problems.push(...validateJsonSchema(schema.additionalProperties as Schema, item, `${path}.${key}`));
      }
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const results = (schema.anyOf as Schema[]).map((option) => validateJsonSchema(option, value, path));
    if (!results.some((result) => result.length === 0)) {
      problems.push(`${path}: matches no anyOf option (${results.map((result) => result[0]).join(' / ')})`);
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = (schema.oneOf as Schema[]).filter((option) => validateJsonSchema(option, value, path).length === 0).length;
    if (matches !== 1) problems.push(`${path}: matches ${matches} oneOf options`);
  }
  return problems;
}
