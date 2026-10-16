import {
  NativePublicActionDeclarationSchema, NATIVE_CALENDAR_CONTRACTS, parseNativeCalendarInput,
  type NativeCalendarOperation, type NativePublicActionDeclaration,
} from '@deft/app-kit';
import { parseSupportedDeftModuleManifest } from '@deft/shared/modules';

export type PublicNativeMapping = NativePublicActionDeclaration['input_mapping'];

/** Native input selectors are authored against one exact App-owned Module
 * version. This never authorizes a public read or invokes package code. */
export function validatePublicNativeMapping(mapping: unknown, moduleManifest: unknown,
  collectionKey: string, operation: NativeCalendarOperation): PublicNativeMapping {
  const parsed = NativePublicActionDeclarationSchema.shape.input_mapping.parse(mapping);
  if (operation !== 'calendar.events.create.v1') throw new Error('Public native operation unavailable');
  const collection = parseSupportedDeftModuleManifest(moduleManifest).collections.find(item => item.key === collectionKey);
  if (!collection) throw new Error('Public native collection unavailable');
  const input = NATIVE_CALENDAR_CONTRACTS[operation].input_schema;
  if (input.required.some(key => !Object.hasOwn(parsed, key))) throw new Error('Missing native input selector');
  for (const [key, source] of Object.entries(parsed)) {
    const schema = (input.properties as Record<string, { type: string }>)[key];
    if (!schema || schema.type !== 'string') throw new Error('Invalid native scalar input');
    if (source.source === 'record.field') {
      const field = collection.fields.find(item => item.key === source.field_key);
      if (!field || !['text', 'date', 'datetime', 'single_select'].includes(field.type)) {
        throw new Error('Invalid native scalar field');
      }
      if ((key === 'start' || key === 'end') && field.type !== 'datetime') {
        throw new Error('Native Calendar time requires a datetime field');
      }
    } else if (key === 'start' || key === 'end') {
      throw new Error('Native Calendar time requires a canonical datetime field');
    }
  }
  return parsed;
}

export function publicNativeRecordFields(mapping: PublicNativeMapping): string[] {
  return [...new Set(Object.values(mapping).flatMap(source => source.source === 'record.field' ? [source.field_key] : []))];
}

/** Call only after the scoped canonical record revision was checked at Run
 * admission. The resulting input is sealed once by the ordinary Run capsule. */
export function projectPublicNativeInput(input: Readonly<{
  mapping: PublicNativeMapping; resource_id: string; claim_id: string;
  data: unknown; operation: NativeCalendarOperation;
}>) {
  const mapping = NativePublicActionDeclarationSchema.shape.input_mapping.parse(input.mapping);
  if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data)) {
    throw new Error('Invalid canonical native input');
  }
  const data = input.data as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const [key, source] of Object.entries(mapping)) {
    projected[key] = source.source === 'claim.resource_id' ? input.resource_id
      : source.source === 'claim.claim_id' ? input.claim_id : data[source.field_key];
  }
  return parseNativeCalendarInput(input.operation, projected);
}
