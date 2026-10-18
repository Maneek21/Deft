import assert from 'node:assert/strict';
import test from 'node:test';
import { hasUnverifiedApprovalRoles, hasUnverifiedNativeLinks, hasUnresolvedRecipient, requiresWorkspaceEvidence, requiresRuntimeActionEvidence, hasRuntimeActionEvidence } from '../src/lib/agent-source-grounding.js';

test('runtime availability and authority questions require authoritative current discovery', () => {
  const request = 'Read-only QA: find QA Avery Demo in Contacts CRM and report the company and role. Check whether Email actions are discoverable to you and whether you can send autonomously or must request approval. Use actual tool results, keep the answer brief, and do not send, enqueue, draft, or change anything.';
  assert.equal(requiresRuntimeActionEvidence(request), true);
  for (const input of ['Which App actions are available?', 'Check which runtime capabilities I can use.', 'Are sideloaded actions available?', 'Which actions are discoverable?']) {
    assert.equal(requiresRuntimeActionEvidence(input), true, input);
  }
  for (const input of ['Find the contact company and role.', 'Explain the concept of approval.', 'Create a task named discoverable actions.', 'Find a contact. Create a task named actions.', 'Can you send autonomously?', 'Do calendar actions require approval?', 'Which capabilities are available on this contact record?', 'List available MCP tools.']) {
    assert.equal(requiresRuntimeActionEvidence(input), false, input);
  }
  assert.equal(hasRuntimeActionEvidence([{ action: 'capability_list', success: true, result: { actions: [] } }]), false);
  assert.equal(hasRuntimeActionEvidence([{ action: 'app_runtime_action_list', success: false, result: { error: 'denied' } }]), false);
  assert.equal(hasRuntimeActionEvidence([{ action: 'app_runtime_action_list', success: true, result: { actions: [], has_more: true, next_cursor: 'next' } }]), false);
  assert.equal(hasRuntimeActionEvidence([{ action: 'app_runtime_action_list', success: true, params: {}, result: { actions: [], has_more: false, next_cursor: null, authority: 'discovery_only' } }]), true);
});

test('runtime evidence requires all pages and rejects a detached or mismatched final page', () => {
  const page = (after: string | undefined, next: string | null, installation_id?: string) => ({
    action: 'app_runtime_action_list', success: true, params: { after, installation_id },
    result: { actions: [], has_more: next !== null, next_cursor: next, authority: 'discovery_only' },
  });
  assert.equal(hasRuntimeActionEvidence([page(undefined, 'page-2'), page('page-2', null)]), true);
  assert.equal(hasRuntimeActionEvidence([page('page-2', null)]), false);
  assert.equal(hasRuntimeActionEvidence([page(undefined, 'page-2'), page('wrong-page', null)]), false);
  assert.equal(hasRuntimeActionEvidence([page(undefined, 'page-2', 'app-a'), page('page-2', null, 'app-b')]), false);
  assert.equal(hasRuntimeActionEvidence([page(undefined, null, 'unrelated-app')]), false);
  assert.equal(hasRuntimeActionEvidence([{ action: 'app_runtime_action_list', success: true, result: { actions: [], has_more: false } }]), false);
});

test('a remembered draft link requires a current authorized source', () => {
  const reply = 'Review [Workshop agenda](/modules/accounts/drafts/draft-1).';
  assert.equal(hasUnverifiedNativeLinks(reply, []), true);
  assert.equal(hasUnverifiedNativeLinks(reply, [{ url: '/modules/accounts/drafts/other' }]), true);
  assert.equal(hasUnverifiedNativeLinks(reply, [{ url: '/modules/accounts/drafts/draft-1' }]), false);
});

test('an unresolved recipient becomes a clarification, while requested templates and sender placeholders remain usable', () => {
  assert.equal(hasUnresolvedRecipient('QA Avery Demo works at Acme Studio as Designer. Email input [recipient] requires approval.', 'Read-only QA: find QA Avery Demo in Contacts CRM and report company and role. Check Email action authority; do not send, enqueue, draft, or change anything.'), false);
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
  assert.equal(hasUnverifiedNativeLinks('[Task](https://invented.test/tasks?task=T-1)', [{ url: '/tasks?task=T-1' }]), true);
  assert.equal(hasUnverifiedNativeLinks('[Contact](https://northstar.modules/modules/contacts/contacts/id)', [{ url: '/modules/contacts/contacts/id' }]), true);
  assert.equal(hasUnverifiedNativeLinks('[Task](https://workspace.test/tasks?task=T-1)', [{ url: 'https://workspace.test/tasks?task=T-1' }]), false);
  assert.equal(hasUnverifiedNativeLinks('[Docs](https://example.test/guide)', []), false);
  assert.equal(hasUnverifiedNativeLinks('Which account do you mean?', []), false);
  assert.equal(hasUnverifiedNativeLinks('[Task](/tasks?task=T-1)', [{ type: 'task', id: 'T-1' }]), false);
});
