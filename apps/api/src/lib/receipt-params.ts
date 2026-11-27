/**
 * Receipt-safe action param sanitization.
 *
 * Module mutations already drop record values from the signed receipt store.
 * This module is the single receipt representation used for both HMAC input
 * and `action_params_json` persistence. Action execution still receives the
 * original unsanitized params from its caller.
 */
import {
  MODULE_OPERATION_DEFINITIONS,
  MODULE_OPERATION_NAMES,
} from '@deft/shared/modules';
import { sanitizeModuleActionParamsForHistory } from './module-service.js';

const MODULE_MUTATION_ACTIONS: ReadonlySet<string> = new Set(
  MODULE_OPERATION_NAMES.filter(
    (operation) => MODULE_OPERATION_DEFINITIONS[operation].mode === 'write',
  ),
);

const MODULE_TASK_LINK_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'module_record_task_link',
  'module_record_task_unlink',
]);

/**
 * Exact sensitive keys after camelCase/hyphen normalization.
 * `token_count` and `secretary` are not in this set and must remain.
 */
const SENSITIVE_RECEIPT_KEYS: ReadonlySet<string> = new Set([
  'password',
  'new_password',
  'current_password',
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'authorization',
  'cookie',
  'client_secret',
  'secret',
  'credentials',
  'bearer',
  'auth_token',
  'id_token',
  'private_key',
]);

const REDACTED = '[redacted]';

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sanitizeModuleTaskLinkParamsForReceipt(value: unknown): Record<string, unknown> {
  const params = recordValue(value);
  const sanitized: Record<string, unknown> = {};
  for (const key of ['resource_id', 'task_identifier', 'idempotency_digest', 'input_digest']) {
    if (typeof params[key] === 'string') sanitized[key] = params[key];
  }
  return sanitized;
}

/**
 * Module record values remain in the narrowly-authorized agent_actions row
 * while a proposal is pending, but must not be copied into the broad signed
 * receipt store. Receipts retain only concurrency, identity, and field-name
 * metadata needed to audit the decision.
 */
export function sanitizeModuleActionParamsForReceipt(
  action: string,
  paramsValue: unknown,
): Record<string, unknown> {
  const params = recordValue(paramsValue);
  if (MODULE_TASK_LINK_WRITE_ACTIONS.has(action)) {
    return sanitizeModuleTaskLinkParamsForReceipt(params);
  }
  if (!MODULE_MUTATION_ACTIONS.has(action)) return params;
  const sanitized = sanitizeModuleActionParamsForHistory(action, params);
  // Retry repair reads an already-scrubbed terminal action. Preserve only
  // the safe field-name/digest evidence that the first terminalization wrote;
  // never reintroduce record values or the raw idempotency key.
  const hasRawMutationPayload = (
    (params.data !== null && typeof params.data === 'object')
    || (params.patch !== null && typeof params.patch === 'object')
    || Array.isArray(params.unset_fields)
  );
  if (!hasRawMutationPayload && Array.isArray(params.changed_fields)) {
    sanitized.changed_fields = [...new Set(
      params.changed_fields.filter((field): field is string => typeof field === 'string'),
    )].sort();
  }
  for (const key of ['idempotency_digest', 'input_digest'] as const) {
    const value = params[key];
    if (typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)) {
      sanitized[key] = value;
    }
  }
  if (
    action === 'module_record_bulk_create'
    && typeof params.__deft_bulk_retry_of_action_id === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(params.__deft_bulk_retry_of_action_id)
  ) {
    sanitized.__deft_bulk_retry_of_action_id = params.__deft_bulk_retry_of_action_id;
  }
  return sanitized;
}

export function normalizeReceiptParamKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

function redactSensitiveReceiptValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveReceiptValue);
  if (value instanceof Date) return value;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_RECEIPT_KEYS.has(normalizeReceiptParamKey(key))
        ? REDACTED
        : redactSensitiveReceiptValue(nested);
    }
    return out;
  }
  return value;
}

/**
 * create_note and write_canvas write a document: their content is read
 * through the document's own access once it exists (review F15 B-I1), so a
 * receipt names the document and the size, never the content.
 */
const DOCUMENT_CONTENT_ACTIONS: ReadonlySet<string> = new Set(['create_note', 'write_canvas']);

/**
 * M7's document tools: an edit's receipt names the document and the summary,
 * never its operations; a created document's names where it went and the
 * sizes, never the title or the Markdown (rule C4).
 */
function withoutDocumentToolText(action: string, params: Record<string, unknown>, resultValue: unknown): Record<string, unknown> {
  const result = resultValue && typeof resultValue === 'object' ? resultValue as Record<string, unknown> : {};
  const documentId = typeof result.document_id === 'string' ? result.document_id
    : typeof params.document_id === 'string' ? params.document_id : null;
  if (action === 'edit_document') {
    return Object.fromEntries(['document_id', 'summary', 'suggestion_id'].flatMap((key) => (typeof params[key] === 'string' ? [[key, params[key]]] : [])));
  }
  const omitted = (value: unknown) => (value && typeof value === 'object' && (value as Record<string, unknown>).content_omitted === true
    ? value
    : { document_id: documentId, content_omitted: true, content_bytes: Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? '')) });
  return {
    ...Object.fromEntries(['drive_id', 'folder_id', 'parent_document_id'].flatMap((key) => (typeof params[key] === 'string' ? [[key, params[key]]] : []))),
    ...(documentId ? { document_id: documentId } : {}),
    ...(params.title !== undefined ? { title: omitted(params.title) } : {}),
    ...(params.markdown !== undefined ? { markdown: omitted(params.markdown) } : {}),
  };
}

function withoutDocumentContent(action: string, paramsValue: unknown, resultValue: unknown): unknown {
  if ((action === 'edit_document' || action === 'create_document') && paramsValue && typeof paramsValue === 'object' && !Array.isArray(paramsValue)) {
    return withoutDocumentToolText(action, paramsValue as Record<string, unknown>, resultValue);
  }
  if (!DOCUMENT_CONTENT_ACTIONS.has(action) || !paramsValue || typeof paramsValue !== 'object' || Array.isArray(paramsValue)) {
    return paramsValue;
  }
  const params = paramsValue as Record<string, unknown>;
  const content = params.content;
  if (content === undefined || content === null) return paramsValue;
  if (typeof content === 'object' && (content as Record<string, unknown>).content_omitted === true) return paramsValue;
  const result = resultValue && typeof resultValue === 'object' ? resultValue as Record<string, unknown> : {};
  const documentId = typeof result.document_id === 'string' ? result.document_id
    : typeof result.canvas_document_id === 'string' ? result.canvas_document_id : null;
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return { ...params, content: { document_id: documentId, content_omitted: true, content_bytes: Buffer.byteLength(text) } };
}

/**
 * Single receipt representation: a document's content left out, module
 * scrub, then secret-key redaction. `resultValue` is the action's result,
 * which names the document. Callers must not use this object for action
 * execution.
 */
export function sanitizeActionParamsForReceipt(
  action: string,
  paramsValue: unknown,
  resultValue?: unknown,
): Record<string, unknown> {
  const moduleSafe = sanitizeModuleActionParamsForReceipt(action, withoutDocumentContent(action, paramsValue, resultValue));
  const redacted = redactSensitiveReceiptValue(moduleSafe);
  return recordValue(redacted);
}
