import {
  MODULE_OPERATION_DEFINITIONS, MODULE_OPERATION_NAMES, MODULE_OPERATION_REQUEST_SCHEMAS as requests,
  MODULE_OPERATION_RESULT_SCHEMAS as results, projectModuleRecordSearch,
  type ModuleActor, type ModuleOperationName, type ModuleRecord,
} from '@deft/shared/modules';
import { RESOURCE_CONTRACT_VERSIONS, type ResourceRefV1 } from '@deft/shared/resources';
import {
  getModuleInstallation, getModuleRecord, getModuleSchema, listModuleSummaries, queryModuleRecords,
  listIncomingModuleRecords, getModuleRelatedLatest, type ModuleInstallationView,
} from './module-service.js';
import { searchAuthorizedModuleResources } from './resource-search-service.js';
import { readModuleTaskLinks } from './module-task-read-operation.js';

export type ModuleReadSource = { type: string; id: string; title: string; url: string; ref?: ResourceRefV1 };
const readNames = new Set<string>(MODULE_OPERATION_NAMES.filter((name) => MODULE_OPERATION_DEFINITIONS[name].mode === 'read'));
export function isModuleReadOperation(name: string): name is ModuleOperationName { return readNames.has(name); }

/** Same authorized reads and destinations for native Defty, employee MCP and personal MCP. */
export async function executeModuleReadOperation(actor: ModuleActor, operation: ModuleOperationName, input: unknown): Promise<{ result: unknown; citations: ModuleReadSource[] }> {
  const installations = new Map<string, ModuleInstallationView>();
  const installationFor = async (moduleId: string) => {
    let installation = installations.get(moduleId);
    if (!installation) {
      installation = await getModuleInstallation(actor, { moduleId });
      installations.set(moduleId, installation);
    }
    return installation;
  };
  const recordSources = async (records: ModuleRecord[]) => Promise.all(records.map(async (record) => {
    const installation = await installationFor(record.module_id);
    return {
      type: 'module_record', id: record.resource_id,
      title: projectModuleRecordSearch(installation.manifest, record.collection_key, record.data)?.title || record.collection_key,
      url: `/modules/${encodeURIComponent(installation.slug)}/${encodeURIComponent(record.collection_key)}/${encodeURIComponent(record.id)}`,
      ref: { schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
        provider: { kind: 'module' as const, provider_instance_id: record.installation_id },
        resource_type: record.collection_key, resource_id: record.id },
    };
  }));
  switch (operation) {
    case 'module_list': {
      requests.module_list.parse(input);
      const result = results.module_list.parse({ modules: await listModuleSummaries(actor) });
      return { result, citations: result.modules.flatMap((module) => {
        const url = `/modules/${encodeURIComponent(module.slug)}`;
        return [
          { type: 'module', id: module.installation_id, title: module.name, url },
          ...module.collections.map((collection) => ({ type: 'module', id: `${module.installation_id}:${collection.key}`,
            title: `${module.name}: ${collection.name}`, url: `${url}/${encodeURIComponent(collection.key)}` })),
          { type: 'module', id: `${module.installation_id}:follow-ups`, title: `${module.name}: Follow-up queue`, url: `${url}?workspace=follow-ups` },
        ];
      }) };
    }
    case 'module_schema_get': {
      const request = requests.module_schema_get.parse(input);
      const result = results.module_schema_get.parse(await getModuleSchema(actor, request.module_id));
      return { result, citations: [{ type: 'module', id: result.installation_id, title: result.manifest.name,
        url: `/modules/${encodeURIComponent(result.manifest.slug)}` }] };
    }
    case 'module_record_search': {
      const result = results.module_record_search.parse(await searchAuthorizedModuleResources(actor, requests.module_record_search.parse(input)));
      return { result, citations: result.items.map((item) => ({ type: 'module_record', id: item.resource_id, title: item.title, url: item.url,
        ref: { schema_version: RESOURCE_CONTRACT_VERSIONS.ref, provider: { kind: 'module', provider_instance_id: item.installation_id }, resource_type: item.collection_key, resource_id: item.record_id },
      })) };
    }
    case 'module_record_get': {
      const request = requests.module_record_get.parse(input);
      const result = results.module_record_get.parse({ record: await getModuleRecord(actor, request.record_id) });
      return { result, citations: await recordSources([result.record]) };
    }
    case 'module_record_query': {
      const request = requests.module_record_query.parse(input);
      const page = await queryModuleRecords(actor, request);
      const result = results.module_record_query.parse({ items: page.records, next_cursor: page.next_cursor });
      // Resolve once before projecting the page rather than issuing one lookup per row.
      if (page.records.length) await installationFor(request.module_id);
      return { result, citations: await recordSources(result.items) };
    }
    case 'module_record_incoming': {
      const request = requests.module_record_incoming.parse(input);
      const record = await getModuleRecord(actor, request.record_id);
      const page = await listIncomingModuleRecords(actor, request.record_id, { ...request, expectedInstallationId: record.installation_id });
      const result = results.module_record_incoming.parse({ items: page.records, next_cursor: page.next_cursor });
      if (page.records.length) await installationFor(record.module_id);
      return { result, citations: await recordSources(result.items) };
    }
    case 'module_record_latest_related': {
      const request = requests.module_record_latest_related.parse(input);
      const record = await getModuleRecord(actor, request.record_id);
      const result = results.module_record_latest_related.parse(await getModuleRelatedLatest(actor, request.record_id, record.installation_id));
      const installation = await installationFor(record.module_id);
      return { result, citations: result.summaries.flatMap((summary) => summary.latest ? [{
        type: 'module_record', id: `module_record:${summary.latest.record.id}`, title: summary.latest.record.label,
        url: `/modules/${encodeURIComponent(installation.slug)}/${encodeURIComponent(summary.latest.record.collection_key)}/${encodeURIComponent(summary.latest.record.id)}`,
        ref: { schema_version: RESOURCE_CONTRACT_VERSIONS.ref, provider: { kind: 'module' as const, provider_instance_id: record.installation_id }, resource_type: summary.latest.record.collection_key, resource_id: summary.latest.record.id },
      }] : []) };
    }
    case 'module_record_task_links': {
      const result = await readModuleTaskLinks(actor, input);
      return { result, citations: result.tasks.map((task) => ({ type: 'task', id: task.task_id,
        title: task.identifier ? `${task.identifier}: ${task.title}` : task.title, url: task.url,
        ref: { schema_version: RESOURCE_CONTRACT_VERSIONS.ref, provider: { kind: 'core', provider_instance_id: 'tasks' }, resource_type: 'task', resource_id: task.task_id },
      })) };
    }
    default: throw new Error('Operation is not a Module read');
  }
}
