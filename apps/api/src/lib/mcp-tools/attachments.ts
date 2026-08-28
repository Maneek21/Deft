import { and, eq } from 'drizzle-orm';
import {
  files,
  messageAttachments,
  messages,
  projects,
  taskAttachments,
  tasks,
} from '@deft/db/schema';
import { db } from '../db.js';
import { localFileStore } from '../file-store.js';
import {
  ensureAttachmentProcessed,
  getAttachmentDerivative,
  loadMessageAttachmentRecords,
  loadTaskAttachmentRecords,
  manifestsForRecords,
  type AttachmentFileRecord,
  type AttachmentReadMode,
} from '../attachment-manifests.js';
import { answerImageAttachmentQuestion } from '../attachment-vision.js';
import { visibleTaskCondition } from '../task-visibility.js';
import { employeeCanAccessSpace } from './employee-space-access.js';
import {
  employeeProjectAccessAllows,
  loadEmployeeProjectAccess,
} from './employee-project-access.js';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';

const MAX_ATTACHMENT_TEXT_CHARS = 64 * 1024;

export type AttachmentListArgs = {
  caller_employee_slug: string;
  message_id?: string;
  task_id?: string;
};

export type AttachmentReadArgs = {
  caller_employee_slug: string;
  attachment_id: string;
  mode?: AttachmentReadMode;
  question?: string;
};

async function canReadMessage(messageId: string, ctx: ToolContext): Promise<boolean> {
  const [message] = await db.select({ space_id: messages.space_id })
    .from(messages)
    .where(and(
      eq(messages.id, messageId),
      eq(messages.org_id, ctx.org_id),
      eq(messages.is_deleted, false),
    ))
    .limit(1);
  return Boolean(message && await employeeCanAccessSpace(ctx.employee_id, ctx.org_id, message.space_id));
}

async function canReadTask(taskId: string, ctx: ToolContext): Promise<boolean> {
  const access = await loadEmployeeProjectAccess(ctx);
  if (!access.resolved) return false;
  const [task] = await db.select({ project_id: tasks.project_id })
    .from(tasks)
    .innerJoin(projects, and(
      eq(projects.id, tasks.project_id),
      eq(projects.org_id, tasks.org_id),
    ))
    .where(and(
      eq(tasks.id, taskId),
      eq(tasks.org_id, ctx.org_id),
      eq(tasks.is_deleted, false),
      eq(projects.is_deleted, false),
      visibleTaskCondition(access.userId),
    ))
    .limit(1);
  return Boolean(task && employeeProjectAccessAllows(access, task.project_id));
}

async function visibleAttachmentRecord(
  attachmentId: string,
  ctx: ToolContext,
): Promise<AttachmentFileRecord | null> {
  const [file] = await db.select().from(files).where(and(
    eq(files.id, attachmentId),
    eq(files.org_id, ctx.org_id),
  )).limit(1);
  if (!file) return null;

  const [messageLinks, taskLinks] = await Promise.all([
    db.select({ message_id: messageAttachments.message_id }).from(messageAttachments).where(and(
      eq(messageAttachments.org_id, ctx.org_id),
      eq(messageAttachments.file_id, attachmentId),
    )),
    db.select({ task_id: taskAttachments.task_id }).from(taskAttachments).where(and(
      eq(taskAttachments.org_id, ctx.org_id),
      eq(taskAttachments.file_id, attachmentId),
    )),
  ]);
  if (messageLinks.length + taskLinks.length > 0) {
    if (messageLinks.length + taskLinks.length !== 1) return null;
    if (messageLinks[0]) return await canReadMessage(messageLinks[0].message_id, ctx) ? file : null;
    return await canReadTask(taskLinks[0]!.task_id, ctx) ? file : null;
  }
  if (file.message_id) return await canReadMessage(file.message_id, ctx) ? file : null;
  if (file.task_id) return await canReadTask(file.task_id, ctx) ? file : null;
  return null;
}

export async function attachmentList(args: AttachmentListArgs, ctx: ToolContext): Promise<ToolResult> {
  const messageId = args.message_id?.trim();
  const taskId = args.task_id?.trim();
  if (Boolean(messageId) === Boolean(taskId)) {
    return errorResult('attachment_list requires exactly one of message_id or task_id');
  }
  if (messageId) {
    if (!(await canReadMessage(messageId, ctx))) return errorResult('attachment_list: message not found or not visible');
    const records = await loadMessageAttachmentRecords({ messageId, orgId: ctx.org_id });
    return textResult({ target: { type: 'message', id: messageId }, attachments: await manifestsForRecords(records) });
  }
  if (!(await canReadTask(taskId!, ctx))) return errorResult('attachment_list: task not found or outside project access');
  const records = await loadTaskAttachmentRecords({ taskId: taskId!, orgId: ctx.org_id });
  return textResult({ target: { type: 'task', id: taskId }, attachments: await manifestsForRecords(records) });
}

export async function attachmentRead(args: AttachmentReadArgs, ctx: ToolContext): Promise<ToolResult> {
  const attachmentId = args.attachment_id?.trim();
  if (!attachmentId) return errorResult('attachment_read requires attachment_id');
  const visible = await visibleAttachmentRecord(attachmentId, ctx);
  if (!visible) return errorResult('attachment_read: attachment not found or not visible');

  const file = await ensureAttachmentProcessed(visible);
  const [manifest] = await manifestsForRecords([file]);
  if (!manifest) return errorResult('attachment_read: attachment metadata unavailable');
  if (file.processing_status === 'blocked') {
    return errorResult(`attachment_read: blocked by safety policy (${file.processing_error ?? 'blocked'})`);
  }
  if (file.processing_status === 'failed') {
    return errorResult(`attachment_read: processing failed (${file.processing_error ?? 'failed'})`);
  }
  if (file.processing_status !== 'ready') return errorResult('attachment_read: processing is still pending');

  const mode = args.mode ?? (manifest.read_modes.includes('text') ? 'text' : manifest.read_modes[0]);
  if (!mode || !manifest.read_modes.includes(mode)) {
    return errorResult(`attachment_read: requested mode is unavailable; available modes: ${manifest.read_modes.join(', ') || 'none'}`);
  }

  if (mode === 'text') {
    const derivative = await getAttachmentDerivative({ fileId: file.id, orgId: ctx.org_id, kind: 'text' });
    if (!derivative) return errorResult('attachment_read: text derivative unavailable');
    const truncated = derivative.content.length > MAX_ATTACHMENT_TEXT_CHARS;
    return textResult({
      attachment: manifest,
      mode,
      content: derivative.content.slice(0, MAX_ATTACHMENT_TEXT_CHARS),
      truncated,
      trust: 'untrusted_attachment_content',
    });
  }

  try {
    const bytes = await localFileStore.get(file.storage_key);
    const result = await answerImageAttachmentQuestion({
      orgId: ctx.org_id,
      bytes,
      mimeType: file.detected_mime_type || file.mime_type,
      question: args.question,
    });
    return textResult({
      attachment: manifest,
      mode,
      question: args.question?.trim() || 'Describe the image and extract any clearly readable text.',
      answer: result.answer,
      model: { provider: result.provider, name: result.model },
      trust: 'untrusted_attachment_evidence',
    });
  } catch (error) {
    const code = error instanceof Error && /^(unsupported_image_type|image_size_limit|vision_provider_unavailable)$/.test(error.message)
      ? error.message
      : 'vision_read_failed';
    return errorResult(`attachment_read: ${code}`);
  }
}
