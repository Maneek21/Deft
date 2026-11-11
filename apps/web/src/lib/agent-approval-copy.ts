export function normalizeInlineApprovalCopy(content: string, hasInlineApproval: boolean) {
  if (!hasInlineApproval) return content;

  const normalized = content
    .replace(
      /\n?\s*Please check your Inbox under the ["']?Approvals["']? tab to approve or reject this task creation\.?/gi,
      '\n\nReview the approval card below.',
    )
    .replace(
      /\n?\s*You can approve the task creation by checking your Inbox under the ["']?Approvals["']? tab\.[\s\S]*?where you can approve or reject it\.?/gi,
      '\n\nReview the approval card below.',
    )
    .replace(
      /\n?\s*This task will be queued for your approval\. You can approve it for it to be created\.?/gi,
      '\n\nReview the approval card below.',
    )
    .replace(
      /\n?\s*You'll see an Approve\/Reject button here to finalize the task creation\. You can also manage this in your Inbox under the Approvals tab\.?/gi,
      '\n\nReview the approval card below.',
    );

  if (/queued for your approval|approve or reject|approval card below|you can approve it/i.test(normalized)) {
    if (/task/i.test(normalized)) return 'I drafted the task. Review the approval card below.';
    return 'I drafted the update. Review the approval card below.';
  }

  return normalized.replace(/\n{3,}/g, '\n\n').trim();
}

type ApprovalCopyMessage = {
  id: string;
  metadata?: { is_agent_reply?: unknown } | Record<string, unknown> | null;
};

/**
 * Text to show for a chat message, given the pending approvals in its space.
 * Only an agent reply that carries its own inline approval card is rewritten;
 * every other message, including any human message, is shown as written.
 */
export function inlineApprovalDisplayContent(
  message: ApprovalCopyMessage,
  content: string,
  pendingByMessage: Record<string, readonly unknown[]> | null | undefined,
) {
  const isAgentReply = (message.metadata as { is_agent_reply?: unknown } | null | undefined)?.is_agent_reply === true;
  const hasInlineApproval = Boolean(pendingByMessage?.[message.id]?.length);
  return normalizeInlineApprovalCopy(content, isAgentReply && hasInlineApproval);
}
