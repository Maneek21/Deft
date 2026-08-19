type UnknownRecord = Record<string, unknown>;

export type TaskModuleRecordLink = {
  edgeId: string;
  resourceId: string;
  recordId: string;
  moduleSlug: string;
  moduleName: string;
  collectionKey: string;
  collectionName: string;
  title: string;
  url: string;
  createdAt: string;
};

export type ModuleRecordTaskLink = {
  edgeId: string;
  taskId: string;
  title: string;
  identifier: string | null;
  status: string;
  priority: string;
  projectId: string;
  projectName: string;
  url: string;
  createdAt: string;
};

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function text(row: UnknownRecord, key: string): string | null {
  return typeof row[key] === 'string' ? row[key] as string : null;
}

export function normalizeTaskModuleRecordLinks(value: unknown): TaskModuleRecordLink[] {
  const body = record(value);
  const rows = Array.isArray(body.links) ? body.links : [];
  return rows.flatMap((value) => {
    const row = record(value);
    const edgeId = text(row, 'edge_id');
    const resourceId = text(row, 'resource_id');
    const recordId = text(row, 'record_id');
    const moduleSlug = text(row, 'module_slug');
    const moduleName = text(row, 'module_name');
    const collectionKey = text(row, 'collection_key');
    const collectionName = text(row, 'collection_name');
    const title = text(row, 'title');
    const url = text(row, 'url');
    const createdAt = text(row, 'created_at');
    if (
      !edgeId || !resourceId || !/^module_record:[A-Za-z0-9][A-Za-z0-9_-]*$/.test(resourceId) || !recordId
      || !moduleSlug || !moduleName || !collectionKey || !collectionName
      || !title || !url?.startsWith('/') || url.startsWith('//') || !createdAt
    ) return [];
    return [{
      edgeId,
      resourceId,
      recordId,
      moduleSlug,
      moduleName,
      collectionKey,
      collectionName,
      title,
      url,
      createdAt,
    }];
  });
}

export function normalizeModuleRecordTaskLinks(value: unknown): ModuleRecordTaskLink[] {
  const body = record(value);
  const rows = Array.isArray(body.links) ? body.links : [];
  return rows.flatMap((value) => {
    const row = record(value);
    const edgeId = text(row, 'edge_id');
    const taskId = text(row, 'task_id');
    const title = text(row, 'title');
    const identifier = row.identifier === null ? null : text(row, 'identifier');
    const status = text(row, 'status');
    const priority = text(row, 'priority');
    const projectId = text(row, 'project_id');
    const projectName = text(row, 'project_name');
    const url = text(row, 'url');
    const createdAt = text(row, 'created_at');
    if (
      !edgeId || !taskId || !title || !status || !priority || !projectId
      || !projectName || !url?.startsWith('/') || url.startsWith('//') || !createdAt
    ) return [];
    return [{
      edgeId,
      taskId,
      title,
      identifier,
      status,
      priority,
      projectId,
      projectName,
      url,
      createdAt,
    }];
  });
}
