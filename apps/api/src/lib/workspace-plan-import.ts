import { createHash } from 'node:crypto';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import readXlsxFile from 'read-excel-file/node';
import { z } from 'zod';
import {
  agentActions,
  agentEmployees,
  orgMembers,
  projects,
  taskActivity,
  tasks,
  users,
} from '@deft/db/schema';
import { buildActionGraph } from './agent-action-graph.js';
import type { CompiledActionDraft, ProposedAgentAction } from './agent-action-proposals.js';
import {
  ensureAttachmentProcessed,
  getAttachmentDerivative,
  loadMessageAttachmentRecords,
} from './attachment-manifests.js';
import { canAccessAttachmentMessage } from './attachment-access.js';
import { db } from './db.js';
import { localFileStore } from './file-store.js';
import { parseCsv, type ParsedCsv } from './module-csv-import.js';
import { reserveTaskNumberRange } from './task-numbering.js';
import { resolveAssigneeWithMatches } from './resolve-assignee.js';
import {
  employeeCanAccessSpace,
} from './mcp-tools/employee-space-access.js';
import {
  employeeProjectAccessAllows,
  loadEmployeeProjectAccess,
} from './mcp-tools/employee-project-access.js';
import { messages } from '@deft/db/schema';

export const WORKSPACE_PLAN_IMPORT_ACTION = 'workspace_plan_import';
export const MAX_WORKSPACE_PLAN_PROJECTS = 10;
export const MAX_WORKSPACE_PLAN_TASKS = 100;
const MAX_WORKBOOK_BYTES = 5 * 1024 * 1024;
const MAX_WORKBOOK_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
const MAX_WORKBOOK_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_WORKBOOK_ENTRIES = 200;
const MAX_WORKSPACE_PLAN_COLUMNS = 30;
const MAX_WORKSPACE_PLAN_TEXT = 250_000;

const prioritySchema = z.enum(['p0', 'p1', 'p2', 'p3']);
const workspacePlanTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(240),
  description: z.string().max(10_000).nullable(),
  priority: prioritySchema,
  assignee_id: z.string().min(1).nullable(),
  assignee_name: z.string().max(200).nullable(),
  start_date: z.string().nullable(),
  due_date: z.string().nullable(),
  estimation: z.string().max(50).nullable(),
  source_row: z.number().int().min(2),
});
const workspacePlanProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(4_000).nullable(),
  prefix: z.string().regex(/^[A-Z0-9]{2,6}$/),
  create_project: z.boolean(),
  tasks: z.array(workspacePlanTaskSchema).min(1).max(MAX_WORKSPACE_PLAN_TASKS),
});
export const WorkspacePlanImportParamsSchema = z.object({
  source_message_id: z.string().min(1),
  source_file_id: z.string().min(1),
  source_file_name: z.string().min(1).max(500),
  source_content_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sheet_name: z.string().max(200).nullable(),
  preview_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  idempotency_key: z.string().min(1).max(200),
  projects: z.array(workspacePlanProjectSchema).min(1).max(MAX_WORKSPACE_PLAN_PROJECTS),
});

export type WorkspacePlanImportParams = z.infer<typeof WorkspacePlanImportParamsSchema>;
export type WorkspacePlanTask = z.infer<typeof workspacePlanTaskSchema>;
export type WorkspacePlanProject = z.infer<typeof workspacePlanProjectSchema>;

type RawPlanRow = {
  sourceRow: number;
  projectName: string;
  projectPrefix: string | null;
  projectDescription: string | null;
  taskTitle: string;
  taskDescription: string | null;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  assigneeName: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimation: string | null;
};

type ParsedPlanTable = {
  sheetName: string | null;
  rows: RawPlanRow[];
};

const HEADER_ALIASES = new Map<string, keyof Omit<RawPlanRow, 'sourceRow'>>([
  ['project', 'projectName'],
  ['project_name', 'projectName'],
  ['project_prefix', 'projectPrefix'],
  ['prefix', 'projectPrefix'],
  ['project_description', 'projectDescription'],
  ['task', 'taskTitle'],
  ['task_name', 'taskTitle'],
  ['task_title', 'taskTitle'],
  ['title', 'taskTitle'],
  ['task_description', 'taskDescription'],
  ['description', 'taskDescription'],
  ['priority', 'priority'],
  ['assignee', 'assigneeName'],
  ['assignee_name', 'assigneeName'],
  ['owner', 'assigneeName'],
  ['start_date', 'startDate'],
  ['due_date', 'dueDate'],
  ['estimate', 'estimation'],
  ['estimation', 'estimation'],
]);

function normalizeHeader(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeIdentity(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

function stableUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][parseInt(hex[16]!, 16) % 4]!;
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableValue(item)]));
}

function sha256Json(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error('Spreadsheet cells must contain text, numbers, booleans, or dates');
}

function nullableText(value: string, maxLength: number, label: string, row: number): string | null {
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) throw new Error(`Row ${row} ${label} exceeds ${maxLength} characters`);
  return text;
}

function requiredText(value: string, maxLength: number, label: string, row: number): string {
  const text = nullableText(value, maxLength, label, row);
  if (!text) throw new Error(`Row ${row} requires ${label}`);
  return text;
}

function normalizedDate(value: string, label: string, row: number): string | null {
  const text = value.trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`Row ${row} ${label} must be YYYY-MM-DD`);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`Row ${row} ${label} is not a real calendar date`);
  }
  return text;
}

function normalizedPriority(value: string, row: number): 'p0' | 'p1' | 'p2' | 'p3' {
  const normalized = normalizeHeader(value);
  if (!normalized || normalized === 'p2' || normalized === 'medium' || normalized === 'normal') return 'p2';
  if (normalized === 'p0' || normalized === 'urgent' || normalized === 'critical') return 'p0';
  if (normalized === 'p1' || normalized === 'high') return 'p1';
  if (normalized === 'p3' || normalized === 'low') return 'p3';
  throw new Error(`Row ${row} priority must be p0, p1, p2, p3, urgent, high, medium, or low`);
}

export function parseWorkspacePlanTable(parsed: ParsedCsv, sheetName: string | null = null): ParsedPlanTable {
  if (parsed.headers.length > MAX_WORKSPACE_PLAN_COLUMNS) {
    throw new Error(`Workspace plan has more than ${MAX_WORKSPACE_PLAN_COLUMNS} columns`);
  }
  const mapped = parsed.headers.map((header) => {
    const normalized = normalizeHeader(header);
    const field = HEADER_ALIASES.get(normalized);
    if (!field) throw new Error(`Unsupported workspace-plan column '${header}'`);
    return field;
  });
  if (new Set(mapped).size !== mapped.length) throw new Error('Workspace-plan columns map to duplicate fields');
  if (!mapped.includes('projectName') || !mapped.includes('taskTitle')) {
    throw new Error('Workspace plan requires Project and Task columns');
  }
  if (parsed.rows.length > MAX_WORKSPACE_PLAN_TASKS) {
    throw new Error(`Workspace plan has more than ${MAX_WORKSPACE_PLAN_TASKS} tasks`);
  }

  let totalText = 0;
  const rows = parsed.rows.map((cells, index): RawPlanRow => {
    const sourceRow = index + 2;
    const values = Object.fromEntries(mapped.map((field, column) => {
      const value = cellText(cells[column] ?? '');
      if (value.trimStart().startsWith('=')) {
        throw new Error(`Row ${sourceRow} contains a formula-like cell; formulas are not imported`);
      }
      totalText += value.length;
      return [field, value];
    })) as Partial<Record<keyof Omit<RawPlanRow, 'sourceRow'>, string>>;
    if (totalText > MAX_WORKSPACE_PLAN_TEXT) throw new Error('Workspace plan text exceeds the reviewed import limit');
    return {
      sourceRow,
      projectName: requiredText(values.projectName ?? '', 120, 'Project', sourceRow),
      projectPrefix: nullableText(values.projectPrefix ?? '', 6, 'Project Prefix', sourceRow),
      projectDescription: nullableText(values.projectDescription ?? '', 4_000, 'Project Description', sourceRow),
      taskTitle: requiredText(values.taskTitle ?? '', 240, 'Task', sourceRow),
      taskDescription: nullableText(values.taskDescription ?? '', 10_000, 'Task Description', sourceRow),
      priority: normalizedPriority(values.priority ?? '', sourceRow),
      assigneeName: nullableText(values.assigneeName ?? '', 200, 'Assignee', sourceRow),
      startDate: normalizedDate(values.startDate ?? '', 'Start Date', sourceRow),
      dueDate: normalizedDate(values.dueDate ?? '', 'Due Date', sourceRow),
      estimation: nullableText(values.estimation ?? '', 50, 'Estimation', sourceRow),
    };
  });
  if (rows.length === 0) throw new Error('Workspace plan needs at least one task row');
  const duplicates = new Set<string>();
  for (const row of rows) {
    const key = `${normalizeIdentity(row.projectName)}\u0000${normalizeIdentity(row.taskTitle)}`;
    if (duplicates.has(key)) throw new Error(`Duplicate task '${row.taskTitle}' in project '${row.projectName}'`);
    duplicates.add(key);
  }
  return { sheetName, rows };
}

function validateWorkbookEnvelope(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.byteLength > MAX_WORKBOOK_BYTES) throw new Error('XLSX file exceeds the 5 MB reviewed import limit');
  let entries = 0;
  let totalOriginal = 0;
  const extracted = unzipSync(bytes, {
    filter: (file) => {
      entries += 1;
      totalOriginal += file.originalSize;
      if (entries > MAX_WORKBOOK_ENTRIES) throw new Error('XLSX contains too many package entries');
      if (file.originalSize > MAX_WORKBOOK_ENTRY_BYTES || totalOriginal > MAX_WORKBOOK_UNCOMPRESSED_BYTES) {
        throw new Error('XLSX expanded content exceeds the reviewed import limit');
      }
      if (file.size > 0 && file.originalSize / file.size > 100) {
        throw new Error('XLSX compression ratio exceeds the safety limit');
      }
      if (/vbaProject\.bin|macrosheets|activeX|externalLinks|embeddings|oleObject/i.test(file.name)) {
        throw new Error('XLSX active or external content is not supported');
      }
      return /\.xml$/i.test(file.name);
    },
  });
  if (entries === 0 || !extracted['xl/workbook.xml']) throw new Error('XLSX workbook structure is invalid');
  const decoder = new TextDecoder();
  for (const [name, content] of Object.entries(extracted)) {
    const xml = decoder.decode(content);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XLSX document types and entities are not supported');
    if (/^xl\/worksheets\//i.test(name) && /<f(?:\s|>)/i.test(xml)) {
      throw new Error('XLSX formulas are not imported; replace them with values and upload again');
    }
  }
  return extracted;
}

export async function parseWorkspacePlanXlsx(bytes: Uint8Array): Promise<ParsedPlanTable> {
  validateWorkbookEnvelope(bytes);
  const sheets = await readXlsxFile(Buffer.from(bytes));
  const nonEmpty = sheets.filter((sheet) => sheet.data.some((row) => row.some((cell) => cell !== null && cellText(cell).trim().length > 0)));
  if (nonEmpty.length === 0) throw new Error('XLSX has no non-empty worksheets');
  const preferred = nonEmpty.filter((sheet) => /^(?:plan|tasks?|roadmap|workspace plan)$/i.test(sheet.sheet.trim()));
  const selected = preferred.length === 1 ? preferred[0] : nonEmpty.length === 1 ? nonEmpty[0] : null;
  if (!selected) throw new Error(`XLSX has multiple non-empty sheets; keep one plan sheet or name it Plan or Tasks`);
  const rows = selected.data.map((row) => row.map(cellText));
  if (rows.length < 2) throw new Error('XLSX needs one header row and at least one task row');
  return parseWorkspacePlanTable({ headers: rows[0]!, rows: rows.slice(1) }, selected.sheet);
}

export function workspacePlanIntent(prompt: string): boolean {
  const plain = prompt.replace(/\s+/g, ' ').trim();
  return /\b(?:import|upload|load|turn|create|set up|setup)\b/i.test(plain)
    && /\b(?:projects?|tasks?|roadmap|work plan|project plan|workspace plan)\b/i.test(plain);
}

function deriveProjectPrefix(name: string): string {
  const parts = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (parts.length >= 2) return parts.map((part) => part[0]).join('').slice(0, 6).padEnd(2, 'X');
  return (parts[0] ?? '').slice(0, 6).padEnd(2, 'X');
}

async function canReadSourceMessage(params: {
  messageId: string;
  orgId: string;
  actorUserId: string;
  employeeId?: string;
}): Promise<boolean> {
  if (!params.employeeId) {
    return canAccessAttachmentMessage(params.messageId, params.orgId, params.actorUserId);
  }
  const [message] = await db.select({ space_id: messages.space_id }).from(messages).where(and(
    eq(messages.id, params.messageId),
    eq(messages.org_id, params.orgId),
    eq(messages.is_deleted, false),
  )).limit(1);
  return Boolean(message && await employeeCanAccessSpace(
    params.employeeId,
    params.orgId,
    message.space_id,
  ));
}

async function readPlanAttachment(params: {
  orgId: string;
  actorUserId: string;
  messageId: string;
  attachmentId?: string;
  employeeId?: string;
}): Promise<{
  file: Awaited<ReturnType<typeof ensureAttachmentProcessed>>;
  table: ParsedPlanTable;
}> {
  if (!(await canReadSourceMessage(params))) throw new Error('Source message is not visible');
  const records = await loadMessageAttachmentRecords({ messageId: params.messageId, orgId: params.orgId });
  const candidates = records.filter((record) => {
    const name = record.filename.toLowerCase();
    return name.endsWith('.csv') || name.endsWith('.xlsx');
  });
  const selected = params.attachmentId
    ? candidates.find((record) => record.id === params.attachmentId)
    : candidates.length === 1 ? candidates[0] : null;
  if (!selected) {
    throw new Error(params.attachmentId
      ? 'The selected spreadsheet is not attached to this message'
      : 'Attach exactly one CSV or XLSX workspace plan');
  }
  const file = await ensureAttachmentProcessed(selected);
  if (file.processing_status !== 'ready') {
    throw new Error(`Spreadsheet is ${file.processing_status} (${file.processing_error ?? 'processing unavailable'})`);
  }
  if (!file.content_sha256) throw new Error('Spreadsheet checksum is unavailable');
  if (file.filename.toLowerCase().endsWith('.csv')) {
    const derivative = await getAttachmentDerivative({ fileId: file.id, orgId: params.orgId, kind: 'text' });
    if (!derivative) throw new Error('CSV text extraction is unavailable');
    return { file, table: parseWorkspacePlanTable(parseCsv(derivative.content)) };
  }
  const bytes = await localFileStore.get(file.storage_key);
  return { file, table: await parseWorkspacePlanXlsx(bytes) };
}

async function resolveWorkspacePlan(params: {
  orgId: string;
  employeeId?: string;
  sourceSeed: string;
  table: ParsedPlanTable;
}): Promise<WorkspacePlanProject[]> {
  const currentProjects = await db.select({
    id: projects.id,
    name: projects.name,
    description: projects.description,
    prefix: projects.prefix,
    is_archived: projects.is_archived,
    is_deleted: projects.is_deleted,
  }).from(projects).where(eq(projects.org_id, params.orgId));
  const access = params.employeeId
    ? await loadEmployeeProjectAccess({ org_id: params.orgId, employee_id: params.employeeId })
    : null;
  if (access && !access.resolved) throw new Error('Agent employee is inactive or unavailable');

  const assignees = new Map<string, { id: string; name: string }>();
  for (const name of [...new Set(params.table.rows.map((row) => row.assigneeName).filter((name): name is string => Boolean(name)))]) {
    const resolved = await resolveAssigneeWithMatches(name, params.orgId);
    if (!resolved.ok) {
      throw new Error(resolved.ambiguous
        ? `Assignee '${name}' is ambiguous: ${resolved.matches.map((match) => match.name).join(', ')}`
        : `Assignee '${name}' is not an active workspace member`);
    }
    assignees.set(normalizeIdentity(name), { id: resolved.value.id, name: resolved.value.name });
  }

  const grouped = new Map<string, RawPlanRow[]>();
  for (const row of params.table.rows) {
    const key = normalizeIdentity(row.projectName);
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  if (grouped.size > MAX_WORKSPACE_PLAN_PROJECTS) {
    throw new Error(`Workspace plan has more than ${MAX_WORKSPACE_PLAN_PROJECTS} projects`);
  }

  const reservedPrefixes = new Set(currentProjects.map((project) => project.prefix.toUpperCase()));
  const result: WorkspacePlanProject[] = [];
  for (const [projectKey, rows] of grouped) {
    const first = rows[0]!;
    const suppliedPrefixes = [...new Set(rows.map((row) => row.projectPrefix?.toUpperCase()).filter((value): value is string => Boolean(value)))];
    if (suppliedPrefixes.length > 1) throw new Error(`Project '${first.projectName}' has conflicting prefixes`);
    const descriptions = [...new Set(rows.map((row) => row.projectDescription).filter((value): value is string => Boolean(value)))];
    if (descriptions.length > 1) throw new Error(`Project '${first.projectName}' has conflicting descriptions`);
    const named = currentProjects.filter((project) => normalizeIdentity(project.name) === projectKey);
    const active = named.filter((project) => !project.is_archived && !project.is_deleted);
    const suppliedPrefix = suppliedPrefixes[0];
    const matched = active.length === 1
      ? active[0]
      : suppliedPrefix ? active.find((project) => project.prefix.toUpperCase() === suppliedPrefix) : null;
    if (named.length > 0 && !matched) {
      throw new Error(`Project '${first.projectName}' is archived, deleted, or ambiguous; use one active exact name and prefix`);
    }

    let projectId: string;
    let prefix: string;
    let createProject: boolean;
    if (matched) {
      projectId = matched.id;
      prefix = matched.prefix;
      createProject = false;
      if (suppliedPrefix && suppliedPrefix !== matched.prefix.toUpperCase()) {
        throw new Error(`Project '${first.projectName}' prefix does not match existing project ${matched.prefix}`);
      }
      if (access && !employeeProjectAccessAllows(access, projectId)) {
        throw new Error(`Project '${first.projectName}' is outside this employee's project boundary`);
      }
    } else {
      if (access && !access.unrestricted) {
        throw new Error(`Project '${first.projectName}' does not exist and this employee cannot create projects outside its boundary`);
      }
      prefix = suppliedPrefix ?? deriveProjectPrefix(first.projectName);
      if (!/^[A-Z0-9]{2,6}$/.test(prefix)) {
        throw new Error(`Project '${first.projectName}' needs a unique 2-6 character alphanumeric prefix`);
      }
      if (reservedPrefixes.has(prefix)) throw new Error(`Project prefix ${prefix} is already in use`);
      reservedPrefixes.add(prefix);
      projectId = stableUuid(`${params.sourceSeed}:project:${projectKey}:${prefix}`);
      createProject = true;
    }

    const projectTasks = rows.map((row) => {
      const assignee = row.assigneeName ? assignees.get(normalizeIdentity(row.assigneeName))! : null;
      return {
        id: stableUuid(`${params.sourceSeed}:task:${row.sourceRow}:${projectId}:${normalizeIdentity(row.taskTitle)}`),
        title: row.taskTitle,
        description: row.taskDescription,
        priority: row.priority,
        assignee_id: assignee?.id ?? null,
        assignee_name: assignee?.name ?? null,
        start_date: row.startDate,
        due_date: row.dueDate,
        estimation: row.estimation,
        source_row: row.sourceRow,
      } satisfies WorkspacePlanTask;
    });
    result.push({
      id: projectId,
      name: matched?.name ?? first.projectName,
      description: descriptions[0] ?? matched?.description ?? null,
      prefix,
      create_project: createProject,
      tasks: projectTasks,
    });
  }
  return result;
}

function clarificationDraft(question: string): CompiledActionDraft {
  return {
    actions: [],
    graph: { intent: 'clarify', summary: '', actions: [], clarification: question },
    clarification: question,
    metrics: { duration_ms: 0, tokens_in: 0, tokens_out: 0, model: 'deterministic:workspace-plan-import' },
  };
}

export async function compileMessageWorkspacePlanImport(params: {
  orgId: string;
  actorUserId: string;
  messageId: string;
  promptContent: string;
  attachmentId?: string;
  employeeId?: string;
  force?: boolean;
}): Promise<CompiledActionDraft | null> {
  if (!params.force && !workspacePlanIntent(params.promptContent)) return null;
  try {
    const { file, table } = await readPlanAttachment({
      orgId: params.orgId,
      actorUserId: params.actorUserId,
      messageId: params.messageId,
      attachmentId: params.attachmentId,
      employeeId: params.employeeId,
    });
    const sourceSeed = `${params.orgId}:${params.messageId}:${file.id}:${file.content_sha256}`;
    const planProjects = await resolveWorkspacePlan({
      orgId: params.orgId,
      employeeId: params.employeeId,
      sourceSeed,
      table,
    });
    const previewDigest = sha256Json({ sourceSeed, sheetName: table.sheetName, projects: planProjects });
    const actionParams: WorkspacePlanImportParams = {
      source_message_id: params.messageId,
      source_file_id: file.id,
      source_file_name: file.filename,
      source_content_sha256: file.content_sha256!,
      sheet_name: table.sheetName,
      preview_digest: previewDigest,
      idempotency_key: `workspace_plan_${previewDigest.slice('sha256:'.length, 'sha256:'.length + 32)}`,
      projects: planProjects,
    };
    WorkspacePlanImportParamsSchema.parse(actionParams);
    const taskCount = planProjects.reduce((count, project) => count + project.tasks.length, 0);
    const newProjectCount = planProjects.filter((project) => project.create_project).length;
    const summary = `I prepared ${taskCount} task${taskCount === 1 ? '' : 's'} across ${planProjects.length} project${planProjects.length === 1 ? '' : 's'} from ${file.filename} for full review${newProjectCount ? `, including ${newProjectCount} new project${newProjectCount === 1 ? '' : 's'}` : ''}.`;
    const baseAction: ProposedAgentAction = {
      action: WORKSPACE_PLAN_IMPORT_ACTION,
      params: actionParams,
      approval_tier: 'full',
      tool_use_id: null,
      source: 'deterministic_workspace_plan_import',
      ...(params.employeeId ? { agent_employee_id: params.employeeId } : {}),
    };
    const graph = buildActionGraph([baseAction], params.messageId, summary);
    const node = graph.actions[0]!;
    return {
      actions: [{
        ...baseAction,
        node_id: node.id,
        depends_on: node.depends_on,
        idempotency_key: node.idempotency_key,
        params: {
          ...actionParams,
          proposal_node_id: node.id,
          proposal_depends_on: node.depends_on,
        },
      }],
      graph,
      summary,
      metrics: { duration_ms: 0, tokens_in: 0, tokens_out: 0, model: 'deterministic:workspace-plan-import' },
    };
  } catch (error) {
    return clarificationDraft(error instanceof Error ? error.message : 'The workspace plan could not be validated.');
  }
}

function cleanImportParams(params: Record<string, unknown>): WorkspacePlanImportParams {
  const { proposal_node_id: _nodeId, proposal_depends_on: _dependencies, ...input } = params;
  return WorkspacePlanImportParamsSchema.parse(input);
}

function dateValue(value: string | null): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

async function validateCurrentAssignees(
  executor: Parameters<Parameters<typeof db.transaction>[0]>[0],
  orgId: string,
  assigneeIds: string[],
): Promise<void> {
  if (assigneeIds.length === 0) return;
  const rows = await executor.select({ id: users.id }).from(users).where(and(
    inArray(users.id, assigneeIds),
    or(
      sql`EXISTS (SELECT 1 FROM ${orgMembers} WHERE ${orgMembers.user_id} = ${users.id} AND ${orgMembers.org_id} = ${orgId} AND ${orgMembers.is_active} = true)`,
      sql`EXISTS (SELECT 1 FROM ${agentEmployees} WHERE ${agentEmployees.user_id} = ${users.id} AND ${agentEmployees.org_id} = ${orgId} AND ${agentEmployees.is_active} = true AND ${agentEmployees.is_deleted} = false AND ${agentEmployees.unhealthy} = false)`,
    ),
  ));
  if (rows.length !== assigneeIds.length) throw new Error('One or more assignees are no longer active in this workspace');
}

export async function executeWorkspacePlanImport(params: {
  actionId: string;
  actionParams: Record<string, unknown>;
  orgId: string;
  userId: string;
  agentEmployeeId?: string;
}): Promise<{ replayed: boolean; projects: Array<{ id: string; name: string; prefix: string; created: boolean }>; tasks: Array<{ id: string; project_id: string; identifier: string; title: string }> }> {
  const input = cleanImportParams(params.actionParams);
  if (!(await canReadSourceMessage({
    messageId: input.source_message_id,
    orgId: params.orgId,
    actorUserId: params.userId,
    employeeId: params.agentEmployeeId,
  }))) throw new Error('Source message is no longer visible');
  const sourceRecords = await loadMessageAttachmentRecords({ messageId: input.source_message_id, orgId: params.orgId });
  const sourceFile = sourceRecords.find((file) => file.id === input.source_file_id);
  if (!sourceFile || sourceFile.content_sha256 !== input.source_content_sha256 || sourceFile.processing_status !== 'ready') {
    throw new Error('Source spreadsheet no longer matches the reviewed preview');
  }
  const sourceSeed = `${params.orgId}:${input.source_message_id}:${input.source_file_id}:${input.source_content_sha256}`;
  const expectedPreviewDigest = sha256Json({
    sourceSeed,
    sheetName: input.sheet_name,
    projects: input.projects,
  });
  if (expectedPreviewDigest !== input.preview_digest) {
    throw new Error('Workspace-plan preview digest does not match its reviewed rows');
  }

  const access = params.agentEmployeeId
    ? await loadEmployeeProjectAccess({ org_id: params.orgId, employee_id: params.agentEmployeeId })
    : null;
  if (access && !access.resolved) throw new Error('Agent employee is inactive or unavailable');
  if (access) {
    for (const project of input.projects) {
      if (project.create_project && !access.unrestricted) {
        throw new Error(`Project '${project.name}' is outside this employee's project boundary`);
      }
      if (!project.create_project && !employeeProjectAccessAllows(access, project.id)) {
        throw new Error(`Project '${project.name}' is outside this employee's project boundary`);
      }
    }
  }

  const allTasks = input.projects.flatMap((project) => project.tasks.map((task) => ({ project, task })));
  const allTaskIds = allTasks.map(({ task }) => task.id);
  const newProjects = input.projects.filter((project) => project.create_project);
  const assigneeIds = [...new Set(allTasks.map(({ task }) => task.assignee_id).filter((id): id is string => Boolean(id)))];

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${params.orgId}:${input.idempotency_key}`}, 0))`);
    const existingTasks = await tx.select({
      id: tasks.id,
      project_id: tasks.project_id,
      number: tasks.number,
      title: tasks.title,
    }).from(tasks).where(and(eq(tasks.org_id, params.orgId), inArray(tasks.id, allTaskIds)));

    if (existingTasks.length > 0) {
      if (existingTasks.length !== allTaskIds.length) throw new Error('A partial prior import was detected; no additional rows were written');
      const activities = await tx.select({ task_id: taskActivity.task_id }).from(taskActivity).where(and(
        eq(taskActivity.org_id, params.orgId),
        eq(taskActivity.agent_action_id, params.actionId),
        inArray(taskActivity.task_id, allTaskIds),
      ));
      if (activities.length !== allTaskIds.length) throw new Error('Workspace-plan task identity collision');
      const currentProjects = await tx.select({ id: projects.id, name: projects.name, prefix: projects.prefix })
        .from(projects).where(and(eq(projects.org_id, params.orgId), inArray(projects.id, input.projects.map((project) => project.id))));
      if (currentProjects.length !== input.projects.length) throw new Error('Workspace-plan project replay is incomplete');
      return {
        replayed: true,
        projects: input.projects.map((project) => ({ id: project.id, name: project.name, prefix: project.prefix, created: project.create_project })),
        tasks: existingTasks.map((task) => ({
          id: task.id,
          project_id: task.project_id,
          identifier: `${input.projects.find((project) => project.id === task.project_id)!.prefix}-${task.number}`,
          title: task.title,
        })),
      };
    }

    const current = await tx.select({
      id: projects.id,
      name: projects.name,
      prefix: projects.prefix,
      is_archived: projects.is_archived,
      is_deleted: projects.is_deleted,
    }).from(projects).where(eq(projects.org_id, params.orgId));
    for (const project of input.projects) {
      const byId = current.find((candidate) => candidate.id === project.id);
      if (project.create_project) {
        if (byId || current.some((candidate) => candidate.prefix.toUpperCase() === project.prefix.toUpperCase())) {
          throw new Error(`Project prefix ${project.prefix} is no longer available`);
        }
      } else if (
        !byId
        || byId.is_archived
        || byId.is_deleted
        || byId.prefix !== project.prefix
        || normalizeIdentity(byId.name) !== normalizeIdentity(project.name)
      ) {
        throw new Error(`Existing project '${project.name}' no longer matches the reviewed preview`);
      }
    }
    await validateCurrentAssignees(tx, params.orgId, assigneeIds);
    if (newProjects.length > 0) {
      await tx.insert(projects).values(newProjects.map((project) => ({
        id: project.id,
        org_id: params.orgId,
        name: project.name,
        description: project.description,
        prefix: project.prefix,
        task_counter: 0,
      })));
    }

    const createdTasks: Array<{ id: string; project_id: string; identifier: string; title: string }> = [];
    for (const project of input.projects) {
      const range = await reserveTaskNumberRange({
        projectId: project.id,
        orgId: params.orgId,
        count: project.tasks.length,
        executor: tx as any,
      });
      const taskRows = project.tasks.map((task, index) => ({
        id: task.id,
        org_id: params.orgId,
        project_id: project.id,
        number: range.firstNumber + index,
        title: task.title,
        description: task.description,
        status: 'backlog' as const,
        priority: task.priority,
        assignee_id: task.assignee_id,
        created_by: params.userId,
        start_date: dateValue(task.start_date),
        due_date: dateValue(task.due_date),
        estimation: task.estimation,
        source_message_id: input.source_message_id,
      }));
      await tx.insert(tasks).values(taskRows);
      await tx.insert(taskActivity).values(taskRows.map((task) => ({
        org_id: params.orgId,
        task_id: task.id,
        user_id: params.userId,
        action: 'created',
        agent_action_id: params.actionId,
        acting_agent_employee_id: params.agentEmployeeId ?? null,
        metadata: {
          source: WORKSPACE_PLAN_IMPORT_ACTION,
          source_file_id: input.source_file_id,
          preview_digest: input.preview_digest,
        },
      })));
      createdTasks.push(...taskRows.map((task) => ({
        id: task.id,
        project_id: project.id,
        identifier: `${project.prefix}-${task.number}`,
        title: task.title,
      })));
    }

    const result = {
      replayed: false,
      projects: input.projects.map((project) => ({
        id: project.id,
        name: project.name,
        prefix: project.prefix,
        created: project.create_project,
      })),
      tasks: createdTasks,
    };
    await tx.update(agentActions).set({
      result,
      after_state: {
        preview_digest: input.preview_digest,
        project_ids: input.projects.map((project) => project.id),
        task_ids: createdTasks.map((task) => task.id),
      },
      executed_at: new Date(),
      error: null,
    }).where(and(eq(agentActions.id, params.actionId), eq(agentActions.org_id, params.orgId)));
    return result;
  });
}

export function sanitizeWorkspacePlanImportParams(params: unknown): unknown {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const parsed = cleanImportParams(params as Record<string, unknown>);
  return {
    source_message_id: parsed.source_message_id,
    source_file_id: parsed.source_file_id,
    source_file_name: parsed.source_file_name,
    sheet_name: parsed.sheet_name,
    preview_digest: parsed.preview_digest,
    idempotency_key: parsed.idempotency_key,
    projects: parsed.projects.map((project) => ({
      id: project.id,
      name: project.name,
      prefix: project.prefix,
      create_project: project.create_project,
      description: project.description,
      task_count: project.tasks.length,
      tasks: project.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        priority: task.priority,
        assignee_name: task.assignee_name,
        start_date: task.start_date,
        due_date: task.due_date,
        estimation: task.estimation,
        source_row: task.source_row,
      })),
    })),
  };
}
