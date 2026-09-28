/** Reconcile presentation only; execution status must come from persisted actions. */
export function reconcileApprovalReplyText(proposal: string, outcome: string): string {
  const facts = proposal
    .replace(/\b(?:This|It) is pending your approval before creation\./gu, '')
    .replace(/Use the approval card below this message to approve or dismiss it\. It is also mirrored in Inbox under Needs you\./gu, '')
    .replace(/Queued the \*\*[^\n]+?\*\* action for your approval — confirm the card above to proceed\./gu, '')
    .replace(/Queued \d+ actions for your approval \([^\n]+\) — confirm the cards above to proceed\./gu, '')
    .replace(/\n{3,}/gu, '\n\n').trim();
  return [facts, outcome].filter(Boolean).join('\n\n');
}
