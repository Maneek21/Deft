import type { ModuleCollection, ModuleRecord, ModuleRelationGroup } from './modules';

export function initialModuleRelationValues(
  collection: ModuleCollection,
  relations: ModuleRelationGroup[],
): Record<string, string[]> {
  return Object.fromEntries(collection.fields.filter((field) => field.type === 'relation').map((field) => [
    field.key,
    relations.find((group) => group.fieldKey === field.key)?.records.map((record) => record.id) ?? [],
  ]));
}

export function moduleFormRelationPatch(
  collection: ModuleCollection,
  values: Record<string, unknown>,
  changedFields: ReadonlySet<string>,
  editing: boolean,
): Record<string, string[]> {
  return Object.fromEntries(collection.fields
    .filter((field) => field.type === 'relation' && (!editing || changedFields.has(field.key)))
    .flatMap((field) => {
      const value = values[field.key];
      const ids = Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))] : [];
      return !editing && ids.length === 0 ? [] : [[field.key, ids]];
    }));
}

export function incomingModuleFields(collections: ModuleCollection[], targetCollection: string) {
  return collections.flatMap((collection) => collection.fields
    .filter((field) => field.type === 'relation' && field.targetCollection === targetCollection)
    .map((field) => ({ collection, field })));
}

export function incomingCreateRelations(
  sourceCollection: ModuleCollection,
  targetCollection: ModuleCollection,
  targetRecord: ModuleRecord,
  directRelation: ModuleRelationGroup,
): ModuleRelationGroup[] {
  const relations = new Map([[directRelation.fieldKey, directRelation]]);
  for (const sourceField of sourceCollection.fields) {
    if (sourceField.type !== 'relation' || sourceField.multiple || relations.has(sourceField.key)) continue;
    let targetField = targetCollection.fields.find((candidate) => candidate.key === sourceField.key);
    if (!targetField) {
      // Different names may describe the same context. Suggest only when both
      // collections declare one relation to that collection; never guess a role.
      const sourceMatches = sourceCollection.fields.filter((candidate) => candidate.type === 'relation' && candidate.targetCollection === sourceField.targetCollection);
      const targetMatches = targetCollection.fields.filter((candidate) => candidate.type === 'relation' && candidate.targetCollection === sourceField.targetCollection);
      if (sourceMatches.length !== 1 || targetMatches.length !== 1) continue;
      targetField = targetMatches[0];
    }
    if (targetField?.type !== 'relation' || targetField.multiple || targetField.targetCollection !== sourceField.targetCollection) continue;
    const visible = targetRecord.relations.find((group) => group.fieldKey === targetField.key)?.records ?? [];
    if (visible.length !== 1 || visible[0]!.collectionKey !== sourceField.targetCollection) continue;
    relations.set(sourceField.key, { fieldKey: sourceField.key, records: [visible[0]!] });
  }
  return [...relations.values()];
}

/** Only an explicitly preferred timeline opts a collection into chronological history. */
export function incomingTimelineDateField(collection: ModuleCollection) {
  const view = collection.views.find((candidate) => ['table', 'board', 'timeline'].includes(candidate.type));
  if (view?.type !== 'timeline' || !view.startField) return undefined;
  return collection.fields.find((field) => field.key === view.startField && ['date', 'datetime'].includes(field.type));
}
