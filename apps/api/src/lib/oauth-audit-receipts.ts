import { and, eq, inArray } from 'drizzle-orm';
import { projects, spaces, tasks } from '@deft/db/schema';
import { db } from './db.js';

export type AuditReceipt = {
  title: string;
  detail: string;
  href?: string;
  target_kind?: 'task' | 'message' | 'wiki' | 'token' | 'app' | 'tool';
  target_id?: string;
  preview?: string;
};

export type AuditActionRow = {
  id: string;
  event: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
};

export type EnrichedAuditAction<T extends AuditActionRow = AuditActionRow> = T & {
  receipt: AuditReceipt;
};

type ToolResultRecord = Record<string, unknown>;

const TASK_WRITE_TOOLS = new Set(['task_create', 'task_update', 'task_bulk_update', 'task_transition', 'comment_on_task']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function cleanPreview(value: unknown, max = 110): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const compact = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.length > max ? `${compact.slice(0, max - 1)}...` : compact;
}

function parseToolResult(action: AuditActionRow): ToolResultRecord | null {
  const metadata = action.metadata ?? {};
  const result = asRecord(metadata.result);
  if (!result) return null;
  const content = Array.isArray(result.content) ? result.content : [];
  const first = asRecord(content[0]);
  const text = typeof first?.text === 'string' ? first.text : null;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function toolName(action: AuditActionRow): string | null {
  return asString(action.metadata?.tool_name);
}

function taskKey(prefix: string | null | undefined, number: number | null | undefined): string | null {
  if (!prefix || !number) return null;
  return `${prefix}-${number}`;
}

function fallbackTitle(action: AuditActionRow): string {
  const tool = toolName(action);
  if (action.event === 'token_issued') return 'Token created';
  if (action.event === 'token_revoked') return 'Token revoked';
  if (action.event === 'grant_revoked') return 'App connection revoked';
  if (action.event === 'mcp_tool_call') return tool ? `Called ${tool}` : 'Tool call';
  if (action.event === 'mcp_idempotency_result') {
    if (tool === 'task_create') return 'Created task';
    if (tool === 'task_transition') return 'Changed task status';
    if (tool === 'task_update') return 'Updated task';
    if (tool === 'task_bulk_update') return 'Updated tasks';
    if (tool === 'comment_on_task') return 'Commented on task';
    if (tool === 'message_post') return 'Posted message';
    if (tool === 'send_message') return 'Sent message';
    if (tool === 'memory_write') return 'Saved memory';
    if (tool === 'wiki_upsert') return 'Saved knowledge';
    return tool ? `${tool} completed` : 'Write completed';
  }
  return action.event.replaceAll('_', ' ');
}

function defaultReceipt(action: AuditActionRow): AuditReceipt {
  const metadata = action.metadata ?? {};
  if (action.event === 'token_issued') {
    const scopes = Array.isArray(metadata.scopes) ? metadata.scopes.length : null;
    const name = asString(metadata.token_name);
    return {
      title: 'Token created',
      detail: [name, scopes ? `${scopes} scopes granted` : null].filter(Boolean).join(' / ') || 'ready to use',
      target_kind: 'token',
      target_id: asString(metadata.token_id) ?? undefined,
    };
  }
  if (action.event === 'token_revoked') {
    return {
      title: 'Token revoked',
      detail: 'access removed',
      target_kind: 'token',
      target_id: asString(metadata.token_id) ?? undefined,
    };
  }
  if (action.event === 'grant_revoked') {
    return {
      title: 'App connection revoked',
      detail: 'access removed',
      target_kind: 'app',
      target_id: asString(metadata.grant_id) ?? undefined,
    };
  }
  if (action.event === 'mcp_tool_call') {
    const tool = toolName(action);
    const ok = typeof metadata.success === 'boolean' ? (metadata.success ? 'ok' : 'failed') : null;
    return {
      title: tool ? `Called ${tool}` : 'Tool call',
      detail: ok ?? 'recorded',
      target_kind: 'tool',
    };
  }
  return {
    title: fallbackTitle(action),
    detail: 'recorded',
    target_kind: 'tool',
  };
}

export async function enrichOAuthAuditActions<T extends AuditActionRow>(
  orgId: string,
  actions: T[],
): Promise<Array<EnrichedAuditAction<T>>> {
  if (actions.length === 0) return [];

  const parsedResults = new Map<string, ToolResultRecord | null>();
  const taskIds = new Set<string>();
  const spaceIds = new Set<string>();

  for (const action of actions) {
    const result = parseToolResult(action);
    parsedResults.set(action.id, result);
    const tool = toolName(action);
    if (!result || action.event !== 'mcp_idempotency_result') continue;

    if (tool && TASK_WRITE_TOOLS.has(tool)) {
      const id = tool === 'comment_on_task'
        ? asString(result.task_id)
        : asString(result.id) ?? asString(result.task_id);
      if (id) taskIds.add(id);
    }
    if (tool === 'message_post' || tool === 'send_message') {
      const spaceId = asString(result.space_id);
      if (spaceId) spaceIds.add(spaceId);
    }
  }

  const taskMap = new Map<string, {
    id: string;
    number: number | null;
    title: string;
    status: string;
    project_prefix: string | null;
  }>();

  if (taskIds.size > 0) {
    const taskRows = await db
      .select({
        id: tasks.id,
        number: tasks.number,
        title: tasks.title,
        status: tasks.status,
        project_prefix: projects.prefix,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(and(eq(tasks.org_id, orgId), inArray(tasks.id, [...taskIds])));
    for (const task of taskRows) taskMap.set(task.id, task);
  }

  const spaceMap = new Map<string, string>();
  if (spaceIds.size > 0) {
    const spaceRows = await db
      .select({ id: spaces.id, name: spaces.name })
      .from(spaces)
      .where(and(eq(spaces.org_id, orgId), inArray(spaces.id, [...spaceIds])));
    for (const space of spaceRows) spaceMap.set(space.id, space.name);
  }

  return actions.map((action) => {
    const result = parsedResults.get(action.id);
    const metadata = action.metadata ?? {};
    const tool = toolName(action);
    let receipt = defaultReceipt(action);

    if (action.event === 'mcp_idempotency_result' && result && tool) {
      if (TASK_WRITE_TOOLS.has(tool)) {
        if (tool === 'task_bulk_update') {
          const updated = asNumber(result.updated) ?? 0;
          const fields = Array.isArray(result.fields) ? result.fields.filter((field): field is string => typeof field === 'string') : [];
          receipt = {
            title: 'Updated tasks',
            detail: `${updated} task${updated === 1 ? '' : 's'}${fields.length ? `: ${fields.join(', ')}` : ''}`,
            target_kind: 'task',
          };
        } else {
          const taskId = tool === 'comment_on_task'
          ? asString(result.task_id)
          : asString(result.id) ?? asString(result.task_id);
        const task = taskId ? taskMap.get(taskId) : undefined;
        const key = asString(result.task_key)
          ?? taskKey(task?.project_prefix, task?.number)
          ?? taskKey(null, asNumber(result.number))
          ?? 'task';
        const title = task?.title ?? asString(result.title) ?? 'Untitled task';
        const transition = asRecord(result.transition);
        const from = asString(transition?.from);
        const to = asString(transition?.to) ?? task?.status ?? asString(result.status);

          receipt = {
            title: fallbackTitle(action),
            detail: tool === 'task_transition'
              ? `${key}: ${from ?? 'previous'} -> ${to ?? 'updated'}`
              : `${key}: ${title}`,
            href: taskId ? `/tasks?task=${encodeURIComponent(taskId)}` : undefined,
            target_kind: 'task',
            target_id: taskId ?? undefined,
            preview: title,
          };
        }
      } else if (tool === 'message_post' || tool === 'send_message') {
        const messageId = asString(result.id);
        const spaceId = asString(result.space_id);
        const spaceName = asString(result.space_name) ?? (spaceId ? spaceMap.get(spaceId) : null);
        const preview = cleanPreview(result.content);
        const targetUser = asString(result.target_user_name) ?? asString(result.target_user_email);
        const targetKind = asString(result.target_kind);
        receipt = {
          title: tool === 'send_message' ? 'Sent message' : 'Posted message',
          detail: `${targetKind === 'dm' && targetUser ? targetUser : spaceName ? `#${spaceName}` : 'space'}${preview ? `: ${preview}` : ''}`,
          href: messageId && spaceId ? `/chat?space=${encodeURIComponent(spaceId)}&message=${encodeURIComponent(messageId)}` : undefined,
          target_kind: 'message',
          target_id: messageId ?? undefined,
          preview: preview ?? undefined,
        };
      } else if (tool === 'memory_write' || tool === 'wiki_upsert') {
        const title = asString(result.title) ?? asString(metadata.title) ?? 'memory';
        const slug = asString(result.slug);
        const operation = asString(result.operation);
        receipt = {
          title: tool === 'wiki_upsert'
            ? operation === 'updated' ? 'Updated knowledge' : 'Saved knowledge'
            : 'Saved memory',
          detail: title,
          href: slug ? `/knowledge?slug=${encodeURIComponent(slug)}` : undefined,
          target_kind: 'wiki',
          target_id: asString(result.id) ?? slug ?? undefined,
          preview: cleanPreview(result.summary ?? result.content) ?? undefined,
        };
      }
    }

    return { ...action, receipt };
  });
}
