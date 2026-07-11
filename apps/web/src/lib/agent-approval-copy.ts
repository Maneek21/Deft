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
