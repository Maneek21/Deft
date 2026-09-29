/** Reconcile presentation only; execution status must come from persisted actions. */
export function reconcileApprovalReplyText(proposal: string, outcome: string): string {
  // Generated prose varies. Remove sentences that describe an approval
  // dependency, keeping the surrounding task details and grounding intact.
  // The caller preserves the original proposal in message metadata for audit.
  const facts = proposal
    .replace(/Use the approval card below this message to approve or dismiss it\. It is also mirrored in Inbox under Needs you\./gu, '')
    .split(/(?<=[.!?])(?=\s)|(?=\n)/u)
    .filter((sentence) => {
      // Standing authorization rules remain true after this proposal resolves.
      const standingRule = /\b(?:policy|policies|rule|rules)\s+(?:is|are|requires?|needs?)\b|\bapproval\s+(?:for|on)\s+(?:every|all)\b|\b(?:every|all)\s+\w+\s+(?:requires?|needs?)\s+approval\b/iu;
      if (standingRule.test(sentence)) return true;
      const approvalDependency = /\b(?:await(?:s|ing)?|pending|wait(?:s|ing)?|require(?:s|d)?|need(?:s|ed)?|queue(?:s|d)?)\b[^\n]*\bapproval\b|\bapproval\b[^\n]*\b(?:pending|required|needed)\b/iu;
      const approvalCondition = /\b(?:before|after|once|when|until)\b[^\n]*\b(?:approval|approve)\b|\b(?:approval|approve)\b[^\n]*\b(?:before|to proceed)\b/iu;
      const approvalPrompt = /\b(?:approve|dismiss|confirm)\b[^\n]*\b(?:card|proposal|action)\b|\b(?:card|proposal|action)\b[^\n]*\b(?:approve|dismiss|confirm)\b/iu;
      return !approvalDependency.test(sentence) && !approvalCondition.test(sentence) && !approvalPrompt.test(sentence);
    })
    .join('')
    .replace(/\n{3,}/gu, '\n\n').trim();
  return [facts, outcome].filter(Boolean).join('\n\n');
}
