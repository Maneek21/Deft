import { createHash } from 'node:crypto';
import {
  validateModuleRecordData,
  type DeftModuleManifest,
  type ModuleFieldV2,
  type ModuleRecordData,
} from '@deft/shared/modules';
import { buildActionGraph } from './agent-action-graph.js';
import type { CompiledActionDraft, ProposedAgentAction } from './agent-action-proposals.js';
import { deftyModuleActor, getModuleSchema, listModuleSummaries } from './module-service.js';
import { getMessageTextAttachments } from './agent-message-attachments.js';
import {
  MAX_MODULE_BULK_CREATE_ROWS,
  MODULE_RECORD_BULK_CREATE_ACTION,
} from './module-record-bulk-create.js';

type CsvImportTarget = {
  moduleId: string;
  moduleName: string;
  moduleSlug: string;
  manifestDigest: string;
  manifest: DeftModuleManifest;
  collectionKey: string;
  collectionName: string;
  collectionSingularName?: string;
};

export type ParsedCsv = { headers: string[]; rows: string[][] };

function importIntent(prompt: string): boolean {
  const plain = prompt.replace(/\s+/g, ' ').trim();
  return /\b(?:import|upload|load)\b/i.test(plain)
    || /\bbulk\s+(?:add|create|insert)\b/i.test(plain)
    || /\badd\s+(?:all|these|the)\b.{0,60}\b(?:rows?|records?|entries)\b/i.test(plain);
}

export function parseCsv(text: string): ParsedCsv {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      record.push(field);
      if (record.some((cell) => cell.trim().length > 0)) records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('CSV has an unterminated quoted field');
  record.push(field);
  if (record.some((cell) => cell.trim().length > 0)) records.push(record);
  if (records.length < 2) throw new Error('CSV needs one header row and at least one data row');

  const headers = records[0]!.map((header) => header.trim());
  if (headers.some((header) => !header)) throw new Error('CSV headers cannot be empty');
  const normalizedHeaders = headers.map(normalizeName);
  if (new Set(normalizedHeaders).size !== normalizedHeaders.length) {
    throw new Error('CSV headers must be unique');
  }
  const rows = records.slice(1);
  for (const [index, row] of rows.entries()) {
    if (row.length !== headers.length) {
      throw new Error(`CSV row ${index + 2} has ${row.length} columns; expected ${headers.length}`);
    }
  }
  if (rows.length > MAX_MODULE_BULK_CREATE_ROWS) {
    throw new Error(`CSV has ${rows.length} data rows; the reviewed import limit is ${MAX_MODULE_BULK_CREATE_ROWS}`);
  }
  return { headers, rows };
}

function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function promptContainsName(prompt: string, value: string): boolean {
  const normalizedPrompt = `_${normalizeName(prompt)}_`;
  const normalizedValue = normalizeName(value);
  return normalizedValue.length > 0 && normalizedPrompt.includes(`_${normalizedValue}_`);
}

function coerceCell(field: ModuleFieldV2, rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (!trimmed) return undefined;
  switch (field.type) {
    case 'number': {
      const value = Number(trimmed);
      if (!Number.isFinite(value)) throw new Error('must be a finite number');
      return value;
    }
    case 'boolean':
      if (/^(?:true|yes|1)$/i.test(trimmed)) return true;
      if (/^(?:false|no|0)$/i.test(trimmed)) return false;
      throw new Error('must be true/false, yes/no, or 1/0');
    case 'single_select': {
      const normalized = normalizeName(trimmed);
      const matches = field.options.filter((option) =>
        normalizeName(option.value) === normalized || normalizeName(option.label) === normalized);
      if (matches.length !== 1) throw new Error('must match one declared option');
      return matches[0]!.value;
    }
    case 'multi_select': {
      const values = trimmed.split(';').map((item) => item.trim()).filter(Boolean);
      return values.map((value) => {
        const normalized = normalizeName(value);
        const matches = field.options.filter((option) =>
          normalizeName(option.value) === normalized || normalizeName(option.label) === normalized);
        if (matches.length !== 1) throw new Error('contains an undeclared option');
        return matches[0]!.value;
      });
    }
    case 'tags':
      return trimmed.split(';').map((item) => item.trim()).filter(Boolean);
    case 'member':
      return field.multiple
        ? trimmed.split(';').map((item) => item.trim()).filter(Boolean)
        : trimmed;
    case 'relation':
    case 'resource_ref':
      throw new Error('is a relation; import the scalar display field or link records after import');
    case 'text':
    case 'long_text':
      return rawValue;
    case 'email':
    case 'url':
    case 'date':
    case 'datetime':
      return trimmed;
  }
}

export function compileCsvRows(
  parsed: ParsedCsv,
  manifest: DeftModuleManifest,
  collectionKey: string,
): ModuleRecordData[] {
  const collection = manifest.collections.find((candidate) => candidate.key === collectionKey);
  if (!collection) throw new Error(`Module collection '${collectionKey}' is unavailable`);
  const mappedFields = parsed.headers.map((header) => {
    const normalized = normalizeName(header);
    const exactKey = collection.fields.find((field) => normalizeName(field.key) === normalized);
    if (exactKey) return exactKey;
    const labelMatches = collection.fields.filter((field) => normalizeName(field.label) === normalized);
    if (labelMatches.length === 1) return labelMatches[0]!;
    if (labelMatches.length > 1) throw new Error(`CSV header '${header}' is ambiguous; use a manifest field key`);
    throw new Error(`CSV header '${header}' is not a field in ${collection.name}`);
  });

  return parsed.rows.map((row, rowIndex) => {
    const data: Record<string, unknown> = {};
    for (const [columnIndex, rawValue] of row.entries()) {
      const field = mappedFields[columnIndex]!;
      try {
        const value = coerceCell(field, rawValue);
        if (value !== undefined) data[field.key] = value;
      } catch (error) {
        throw new Error(`CSV row ${rowIndex + 2}, column '${parsed.headers[columnIndex]}': ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const validated = validateModuleRecordData(manifest, collectionKey, data);
    if (!validated.success) {
      const issue = validated.issues[0]!;
      throw new Error(`CSV row ${rowIndex + 2}${issue.field ? `, field '${issue.field}'` : ''}: ${issue.message}`);
    }
    return validated.data;
  });
}

function scoreTarget(prompt: string, target: CsvImportTarget): number {
  let score = 0;
  if (promptContainsName(prompt, target.collectionKey)) score += 8;
  if (promptContainsName(prompt, target.collectionName)) score += 8;
  if (target.collectionSingularName && promptContainsName(prompt, target.collectionSingularName)) score += 6;
  if (promptContainsName(prompt, target.moduleSlug)) score += 3;
  if (promptContainsName(prompt, target.moduleName)) score += 3;
  if (prompt.toLowerCase().includes(target.moduleId.toLowerCase())) score += 4;
  return score;
}

async function resolveTarget(orgId: string, userId: string, prompt: string): Promise<{
  target?: CsvImportTarget;
  clarification?: string;
}> {
  const actor = deftyModuleActor({ orgId, userId, role: 'member' });
  const summaries = await listModuleSummaries(actor);
  const targets: CsvImportTarget[] = [];
  for (const summary of summaries) {
    const schema = await getModuleSchema(actor, summary.module_id);
    for (const collection of schema.manifest.collections) {
      targets.push({
        moduleId: summary.module_id,
        moduleName: summary.name,
        moduleSlug: summary.slug,
        manifestDigest: schema.manifest_digest,
        manifest: schema.manifest,
        collectionKey: collection.key,
        collectionName: collection.name,
        ...(collection.singular_name ? { collectionSingularName: collection.singular_name } : {}),
      });
    }
  }
  const scored = targets.map((target) => ({ target, score: scoreTarget(prompt, target) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  if (scored.length === 0) {
    return { clarification: 'Which enabled module collection should I import this CSV into?' };
  }
  const winners = scored.filter((candidate) => candidate.score === scored[0]!.score);
  if (winners.length !== 1) {
    const labels = winners.slice(0, 5).map(({ target }) => `${target.moduleName} / ${target.collectionName}`);
    return { clarification: `The import target is ambiguous. Choose one: ${labels.join(', ')}.` };
  }
  return { target: winners[0]!.target };
}

function clarificationDraft(question: string): CompiledActionDraft {
  return {
    actions: [],
    graph: { intent: 'clarify', summary: '', actions: [], clarification: question },
    clarification: question,
    metrics: { duration_ms: 0, tokens_in: 0, tokens_out: 0, model: 'deterministic:module-csv-import' },
  };
}

export async function compileMessageModuleCsvImport(params: {
  orgId: string;
  userId: string;
  messageId: string;
  promptContent: string;
}): Promise<CompiledActionDraft | null> {
  if (!importIntent(params.promptContent)) return null;
  const attachments = (await getMessageTextAttachments({ messageId: params.messageId, orgId: params.orgId }))
    .filter((file) => file.filename.toLowerCase().endsWith('.csv')
      || file.mime_type.toLowerCase().split(';', 1)[0]?.trim() === 'text/csv'
      || file.mime_type.toLowerCase().split(';', 1)[0]?.trim() === 'application/csv');
  if (attachments.length === 0) return null;
  if (attachments.length !== 1) return clarificationDraft('Attach one CSV per reviewed import request.');
  const file = attachments[0]!;
  if (file.content === null) {
    return clarificationDraft(`I could not read ${file.filename} (${file.unavailable_reason ?? 'file unavailable'}).`);
  }

  const resolved = await resolveTarget(params.orgId, params.userId, params.promptContent);
  if (!resolved.target) return clarificationDraft(resolved.clarification!);
  try {
    const parsed = parseCsv(file.content);
    const rows = compileCsvRows(parsed, resolved.target.manifest, resolved.target.collectionKey);
    const batchKey = `csv_import_${createHash('sha256')
      .update(`${params.messageId}:${file.id}:${resolved.target.moduleId}:${resolved.target.collectionKey}`)
      .digest('hex')
      .slice(0, 32)}`;
    const baseAction: ProposedAgentAction = {
      action: MODULE_RECORD_BULK_CREATE_ACTION,
      params: {
        module_id: resolved.target.moduleId,
        module_name: resolved.target.moduleName,
        collection_key: resolved.target.collectionKey,
        collection_name: resolved.target.collectionName,
        expected_manifest_digest: resolved.target.manifestDigest,
        source_file_name: file.filename,
        rows: rows.map((data) => ({ data })),
        idempotency_key: batchKey,
        source_message_id: params.messageId,
      },
      approval_tier: 'full',
      tool_use_id: null,
      source: 'deterministic_csv_import',
    };
    const summary = `I prepared an import of ${rows.length} ${resolved.target.collectionName} record${rows.length === 1 ? '' : 's'} from ${file.filename} for approval.`;
    const graph = buildActionGraph([baseAction], params.messageId, summary);
    const node = graph.actions[0]!;
    const action = {
      ...baseAction,
      node_id: node.id,
      depends_on: node.depends_on,
      idempotency_key: node.idempotency_key,
      params: {
        ...baseAction.params,
        proposal_node_id: node.id,
        proposal_depends_on: node.depends_on,
      },
    };
    return {
      actions: [action],
      graph,
      summary,
      metrics: { duration_ms: 0, tokens_in: 0, tokens_out: 0, model: 'deterministic:module-csv-import' },
    };
  } catch (error) {
    return clarificationDraft(error instanceof Error ? error.message : 'The CSV could not be validated.');
  }
}
