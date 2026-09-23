import assert from 'node:assert/strict';
import test from 'node:test';
import { hasUnverifiedApprovalRoles, hasUnverifiedNativeLinks, hasUnresolvedRecipient, requiresWorkspaceEvidence } from '../src/lib/agent-source-grounding.js';

test('a remembered draft link requires a current authorized source', () => {
  const reply = 'Review [Workshop agenda](/modules/accounts/drafts/draft-1).';
  assert.equal(hasUnverifiedNativeLinks(reply, []), true);
  assert.equal(hasUnverifiedNativeLinks(reply, [{ url: '/modules/accounts/drafts/other' }]), true);
  assert.equal(hasUnverifiedNativeLinks(reply, [{ url: '/modules/accounts/drafts/draft-1' }]), false);
});

test('an unresolved recipient becomes a clarification, while requested templates and sender placeholders remain usable', () => {
  assert.equal(hasUnresolvedRecipient('Dear [QA Company Contact Name], how is the pilot?', 'Draft a follow-up for the QA company.'), true);
  assert.equal(hasUnresolvedRecipient('Dear [Recipient], hello.', 'Give me a generic template.'), false);
  assert.equal(hasUnresolvedRecipient('Hi Omar, please review ownership. Regards, [Your Name/Team]', 'Propose an outreach message for Willow Ridge.'), false);
  assert.equal(hasUnresolvedRecipient('Which company do you mean?', 'Draft a follow-up.'), false);
  assert.equal(hasUnresolvedRecipient('Dear [Name], how is the pilot?', 'Draft a follow-up for the QA company.'), true);
  assert.equal(hasUnresolvedRecipient('Hi [Decision Maker], how is the pilot?', 'Draft a follow-up for the QA company.'), true);
  assert.equal(hasUnresolvedRecipient('Hi ____, how is the pilot?', 'Draft a follow-up for the QA company.'), true);
  assert.equal(hasUnresolvedRecipient('The field [Name] is required.', 'Explain this validation rule.'), false);
  assert.equal(hasUnresolvedRecipient('Dear [Name], hello.', 'Give me a sample message.'), false);
});

test('detects explicit workspace lookup intents without treating generic drafts or templates as reads', () => {
  assert.equal(requiresWorkspaceEvidence('Find the current company record for Acme.'), true);
  assert.equal(requiresWorkspaceEvidence('Look up the task for the renewal.'), true);
  assert.equal(requiresWorkspaceEvidence('Summarize Acme Corp'), true);
  assert.equal(requiresWorkspaceEvidence('Summarize Acme'), true);
  assert.equal(requiresWorkspaceEvidence('Draft a generic follow-up template.'), false);
  assert.equal(requiresWorkspaceEvidence('Write a friendly greeting for Sam.'), false);
});

test('rejects invented organizational approvers but permits the actual Deft review explanation', () => {
  assert.equal(hasUnverifiedApprovalRoles('Approval from relevant internal stakeholders (e.g., project lead or account manager) is required.'), true);
  assert.equal(hasUnverifiedApprovalRoles('The user must review the exact recipient and final content in Deft before any governed external action.'), false);
  assert.equal(hasUnverifiedApprovalRoles('No approval from a project lead or account manager is required.'), false);
});

test('native destinations include query identity; external links and plain replies need no native lookup', () => {
  assert.equal(hasUnverifiedNativeLinks('[Task](https://invented.test/tasks?task=T-1)', [{ url: '/tasks?task=T-2' }]), true);
  assert.equal(hasUnverifiedNativeLinks('[Task](https://invented.test/tasks?task=T-1)', [{ url: '/tasks?task=T-1' }]), false);
  assert.equal(hasUnverifiedNativeLinks('[Docs](https://example.test/guide)', []), false);
  assert.equal(hasUnverifiedNativeLinks('Which account do you mean?', []), false);
  assert.equal(hasUnverifiedNativeLinks('[Task](/tasks?task=T-1)', [{ type: 'task', id: 'T-1' }]), false);
});
