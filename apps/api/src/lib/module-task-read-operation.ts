import { MODULE_OPERATION_REQUEST_SCHEMAS, MODULE_OPERATION_RESULT_SCHEMAS, parseModuleRecordResourceId, type ModuleActor } from '@deft/shared/modules';
import { getModuleInstallation, getModuleRecord } from './module-service.js';
import { listModuleRecordTaskLinks } from './module-task-links.js';

export async function readModuleTaskLinks(actor: ModuleActor, value: unknown) {
  const input = MODULE_OPERATION_REQUEST_SCHEMAS.module_record_task_links.parse(value);
  const record = await getModuleRecord(actor, parseModuleRecordResourceId(input.resource_id));
  const installation = await getModuleInstallation(actor, { moduleId: record.module_id });
  const rows = await listModuleRecordTaskLinks(actor, installation.slug, record.id, {
    offset: input.offset, limit: input.limit + 1,
  });
  const tasks = rows.slice(0, input.limit);
  return MODULE_OPERATION_RESULT_SCHEMAS.module_record_task_links.parse({
    resource_id: input.resource_id, tasks, count: tasks.length,
    next_offset: rows.length > input.limit ? input.offset + input.limit : null,
  });
}
