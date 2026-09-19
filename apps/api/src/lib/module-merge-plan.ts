import { MODULE_LIMITS, type ModuleMergePreviewRequest, type ModuleRecordData, type ModuleFieldV2 } from '@deft/shared/modules';
import { ModuleError } from './module-errors.js';

type MergeRecord = { id: string; data: ModuleRecordData };
export type MergeEdge = { id: string; source_record_id: string; target_record_id: string; field_key: string; position: number };
type DesiredEdge = Omit<MergeEdge, 'id'>;
export type MergeConflict = { kind: 'field' | 'relation'; key: string; source: unknown; target: unknown; choice: 'source' | 'target' | null };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const edgeKey = (edge: DesiredEdge) => JSON.stringify([edge.source_record_id, edge.field_key, edge.target_record_id]);

// Pure plan only. Callers must authorize, validate, lock and recheck the complete reviewed snapshot.
export function planModuleRecordMerge(source: MergeRecord, target: MergeRecord, fields: ModuleFieldV2[], edges: MergeEdge[],
  choices: Pick<ModuleMergePreviewRequest, 'field_choices' | 'relation_choices'>) {
  if (source.id === target.id) throw new ModuleError('Choose two different records', 'MODULE_VALIDATION_ERROR', 400);
  const keys = new Set([...Object.keys(source.data), ...Object.keys(target.data)]);
  const relations = fields.filter((field) => field.type === 'relation');
  for (const key of Object.keys(choices.field_choices)) {
    if (!keys.has(key) || relations.some((field) => field.key === key)) throw new ModuleError('Unknown merge field choice', 'MODULE_VALIDATION_ERROR', 400);
  }
  for (const key of Object.keys(choices.relation_choices)) {
    if (!relations.some((field) => field.key === key)) throw new ModuleError('Unknown merge relation choice', 'MODULE_VALIDATION_ERROR', 400);
  }
  const data: ModuleRecordData = {};
  const conflicts: MergeConflict[] = [];
  for (const key of [...keys].sort()) {
    const sourceValue = source.data[key], targetValue = target.data[key];
    const choice = choices.field_choices[key];
    if (sourceValue !== undefined && targetValue !== undefined && !same(sourceValue, targetValue)) {
      conflicts.push({ kind: 'field', key, source: sourceValue, target: targetValue, choice: choice ?? null });
    }
    // Missing fields are filled, but explicit null/empty/false/zero values are never treated as missing.
    const value = choice === 'source' ? sourceValue : choice === 'target' ? targetValue : targetValue === undefined ? sourceValue : targetValue;
    if (value !== undefined) data[key] = value;
  }
  const mappedTarget = (id: string) => id === source.id ? target.id : id;
  const outgoing = (recordId: string, field: string) => [...new Set(edges.filter((edge) => edge.source_record_id === recordId && edge.field_key === field)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map((edge) => mappedTarget(edge.target_record_id)))];
  const selectedRelations = new Map<string, string[]>();
  for (const field of relations) {
    const fromSource = outgoing(source.id, field.key), fromTarget = outgoing(target.id, field.key);
    const choice = choices.relation_choices[field.key];
    if (!field.multiple && fromSource.length && fromTarget.length && !same(fromSource, fromTarget)) {
      conflicts.push({ kind: 'relation', key: field.key, source: fromSource, target: fromTarget, choice: choice ?? null });
    }
    const values = choice === 'source' ? fromSource : choice === 'target' ? fromTarget : field.multiple
      ? [...new Set([...fromTarget, ...fromSource])] : fromTarget.length ? fromTarget : fromSource;
    if (values.length > (field.multiple ? MODULE_LIMITS.relation_values_per_field : 1)) throw new ModuleError('Merged relation exceeds its record limit', 'MODULE_VALIDATION_ERROR', 400);
    selectedRelations.set(field.key, values);
  }
  for (const edge of edges) {
    if ([source.id, target.id].includes(edge.source_record_id) && !selectedRelations.has(edge.field_key)) {
      throw new ModuleError('A retained relation is absent from the current manifest; resolve it before merging', 'MODULE_VALIDATION_ERROR', 400);
    }
  }
  const desired = new Map<string, DesiredEdge>();
  // Incoming edges keep their owning record. Only the referenced identity changes.
  for (const edge of edges) {
    if ([source.id, target.id].includes(edge.source_record_id)) continue;
    const mapped = { source_record_id: edge.source_record_id, target_record_id: mappedTarget(edge.target_record_id), field_key: edge.field_key, position: edge.position };
    const key = edgeKey(mapped);
    const prior = desired.get(key);
    if (!prior || mapped.position < prior.position) desired.set(key, mapped);
  }
  for (const [field_key, ids] of selectedRelations) ids.forEach((target_record_id, position) => {
    const edge = { source_record_id: target.id, field_key, target_record_id, position };
    desired.set(edgeKey(edge), edge);
  });
  // The absorbed record's own original edges remain as archived history. Never resurrect deleted edges.
  const activeCurrent = edges.filter((edge) => edge.source_record_id !== source.id);
  const currentKeys = new Set(activeCurrent.map(edgeKey));
  const remove_edge_ids = activeCurrent.filter((edge) => !desired.has(edgeKey(edge))).map((edge) => edge.id).sort();
  const add_edges = [...desired.values()].filter((edge) => !currentKeys.has(edgeKey(edge)));
  const reposition_edges = activeCurrent.flatMap((edge) => {
    const wanted = desired.get(edgeKey(edge));
    return wanted && wanted.position !== edge.position ? [{ id: edge.id, position: wanted.position }] : [];
  });
  return { data, conflicts, ready: conflicts.every((conflict) => conflict.choice !== null),
    relations: Object.fromEntries(selectedRelations), remove_edge_ids, add_edges, reposition_edges,
    affected_record_ids: [...new Set([target.id, ...activeCurrent.filter((edge) => remove_edge_ids.includes(edge.id)).map((edge) => edge.source_record_id), ...add_edges.map((edge) => edge.source_record_id)])].sort() };
}
