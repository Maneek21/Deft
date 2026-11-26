import type { DeftModuleManifest } from '@deft/shared/modules';

/**
 * Plain sentences that say what an app (a module manifest) adds: each record
 * type, its fields, how record types link, and its views. Shown before install
 * so a person can check the file does what they meant, without reading JSON.
 */

type Collection = DeftModuleManifest['collections'][number];
type Field = Collection['fields'][number];
type View = NonNullable<Collection['views']>[number];

export type ModuleCollectionDescription = {
  key: string;
  name: string;
  /** "Candidates: 5 fields, 1 link and 2 views." */
  summary: string;
  /** "Name: text, required" */
  fields: string[];
  /** "Each Candidate links to one Role" */
  relations: string[];
  /** "Pipeline: a board grouped by Stage" */
  views: string[];
};

export type ModuleDescription = {
  name: string;
  version: string;
  /** "Hiring adds 2 record types: Roles and Candidates." */
  summary: string;
  collections: ModuleCollectionDescription[];
  /** Who can see and change the records. */
  access: string;
};

export const MODULE_ACCESS_SENTENCE =
  "Owners, admins and members can see and change these records. Guests can't.";

const MAX_OPTIONS_LISTED = 6;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function singularOf(collection: Collection): string {
  if (collection.singular_name) return collection.singular_name;
  const name = collection.name;
  if (/ies$/i.test(name)) return `${name.slice(0, -3)}y`;
  if (/(ss|us|is)$/i.test(name)) return name;
  if (/(ches|shes|xes|sses)$/i.test(name)) return name.slice(0, -2);
  if (/s$/i.test(name)) return name.slice(0, -1);
  return name;
}

function optionList(options: Array<{ value: string; label: string }>): string {
  const labels = options.map((option) => option.label);
  if (labels.length <= MAX_OPTIONS_LISTED) return list(labels);
  return `${labels.slice(0, MAX_OPTIONS_LISTED).join(', ')} and ${labels.length - MAX_OPTIONS_LISTED} more`;
}

function fieldKind(field: Field): string {
  switch (field.type) {
    case 'text': return 'text';
    case 'long_text': return 'long text';
    case 'email': return 'an email address';
    case 'url': return 'a web address';
    case 'date': return 'a date';
    case 'datetime': return 'a date and time';
    case 'number': return 'a number';
    case 'boolean': return 'yes or no';
    case 'single_select': return `pick one of ${optionList(field.options)}`;
    case 'multi_select': return `pick any of ${optionList(field.options)}`;
    case 'member': return field.multiple ? 'workspace members' : 'a workspace member';
    case 'tags': return 'a list of tags';
    case 'relation': return 'a link to another record';
    default: return 'a link to a record in another app';
  }
}

function fieldDefault(field: Field): string | null {
  if (!('default' in field) || field.default === undefined) return null;
  if (field.type === 'single_select') {
    const option = field.options.find((item) => item.value === field.default);
    return option ? `starts as ${option.label}` : null;
  }
  if (field.type === 'multi_select' && Array.isArray(field.default)) {
    const labels = field.default
      .map((value) => field.options.find((item) => item.value === value)?.label)
      .filter((label): label is string => Boolean(label));
    return labels.length > 0 ? `starts as ${list(labels)}` : null;
  }
  if (field.type === 'boolean') return `starts as ${field.default ? 'yes' : 'no'}`;
  if (typeof field.default === 'string' || typeof field.default === 'number') return `starts as ${field.default}`;
  return null;
}

export function describeModuleField(field: Field): string {
  const parts = [fieldKind(field)];
  const start = fieldDefault(field);
  if (start) parts.push(start);
  if (field.required) parts.push('required');
  return `${field.label}: ${parts.join(', ')}`;
}

function describeRelation(source: Collection, field: Field, collections: Collection[]): string | null {
  if (field.type === 'relation') {
    const target = collections.find((collection) => collection.key === field.target_collection);
    const targetName = target
      ? (field.multiple ? target.name : singularOf(target))
      : field.target_collection;
    const amount = field.multiple ? 'any number of' : 'one';
    const named = target && [singularOf(target), target.name].some((name) => name.toLowerCase() === field.label.toLowerCase());
    return `Each ${singularOf(source)} links to ${amount} ${targetName}${named ? '' : ` (${field.label})`}${field.required ? ', required' : ''}`;
  }
  if (field.type === 'resource_ref') {
    return `Each ${singularOf(source)} links to ${field.multiple ? 'records' : 'a record'} in another app (${field.label})`;
  }
  return null;
}

function fieldLabel(collection: Collection, key: string): string {
  return collection.fields.find((field) => field.key === key)?.label ?? key;
}

export function describeModuleView(collection: Collection, view: View): string {
  switch (view.type) {
    case 'table':
      return `${view.name}: a table`;
    case 'board': {
      const summary = view.summary ? `, with ${fieldLabel(collection, view.summary.value_field)} totals` : '';
      return `${view.name}: a board grouped by ${fieldLabel(collection, view.group_by)}${summary}`;
    }
    case 'timeline': {
      const end = view.end_field ? ` to ${fieldLabel(collection, view.end_field)}` : '';
      return `${view.name}: a timeline from ${fieldLabel(collection, view.start_field)}${end}`;
    }
    case 'form':
      return `${view.name}: a form for adding records`;
    case 'detail':
      return `${view.name}: a page for one record`;
    default:
      return `${(view as { name: string }).name}: a view`;
  }
}

export function describeModuleCollection(collection: Collection, collections: Collection[]): ModuleCollectionDescription {
  const relations: string[] = [];
  const fields: string[] = [];
  for (const field of collection.fields) {
    const relation = describeRelation(collection, field, collections);
    if (relation) relations.push(relation);
    else fields.push(describeModuleField(field));
  }
  const views = (collection.views ?? []).map((view) => describeModuleView(collection, view));
  const counts = [plural(fields.length, 'field')];
  if (relations.length > 0) counts.push(plural(relations.length, 'link'));
  counts.push(views.length > 0 ? plural(views.length, 'view') : 'a standard table');
  return {
    key: collection.key,
    name: collection.name,
    summary: `${collection.name}: ${list(counts)}.`,
    fields,
    relations,
    views,
  };
}

export function describeModuleManifest(manifest: DeftModuleManifest): ModuleDescription {
  const collections = manifest.collections.map((collection) => describeModuleCollection(collection, manifest.collections));
  const names = manifest.collections.map((collection) => collection.name);
  return {
    name: manifest.name,
    version: manifest.version,
    summary: `${manifest.name} adds ${plural(names.length, 'record type')}: ${list(names)}.`,
    collections,
    access: MODULE_ACCESS_SENTENCE,
  };
}

/** The PATCH body after install when the person let Defty read the records. */
export function agentAccessPatchFor(agentRead: boolean): { agent_access: 'read' } | null {
  return agentRead ? { agent_access: 'read' } : null;
}
