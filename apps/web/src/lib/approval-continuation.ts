export type ApprovalContinuationMessage = {
  id: string;
  metadata?: Record<string, unknown> | null;
};

type ApprovalContinuationGateInput = {
  spaceType: string;
  confirmationId: string;
  messages: readonly ApprovalContinuationMessage[];
  pendingByMessage: Readonly<Record<string, readonly unknown[]>>;
  pendingActionsLoaded: boolean;
  pendingActionsUnavailable: boolean;
  busy: boolean;
  alreadyContinued: boolean;
};

export type ApprovalContinuationGate = {
  show: boolean;
  disabled: boolean;
  reason:
    | 'ready'
    | 'busy'
    | 'not_agent_conversation'
    | 'not_confirmation'
    | 'pending_actions_loading'
    | 'pending_actions_unavailable'
    | 'pending_actions'
    | 'already_continued'
    | 'stale';
  sourceMessageId?: string;
};

export function approvalContinuationGate(
  input: ApprovalContinuationGateInput,
): ApprovalContinuationGate {
  if (input.spaceType !== 'agent_conversation') {
    return { show: false, disabled: true, reason: 'not_agent_conversation' };
  }

  const confirmationIndex = input.messages.findIndex((message) => message.id === input.confirmationId);
  const confirmation = input.messages[confirmationIndex];
  const metadata = confirmation?.metadata;
  const sourceMessageId = metadata?.approval_confirmation_for_message_id;
  if (
    confirmationIndex < 0
    || metadata?.subtype !== 'approval_confirmation'
    || typeof sourceMessageId !== 'string'
    || !sourceMessageId
  ) {
    return { show: false, disabled: true, reason: 'not_confirmation' };
  }

  if (input.pendingActionsUnavailable) {
    return { show: false, disabled: true, reason: 'pending_actions_unavailable' };
  }
  if (!input.pendingActionsLoaded) {
    return { show: false, disabled: true, reason: 'pending_actions_loading' };
  }
  if ((input.pendingByMessage[sourceMessageId]?.length ?? 0) > 0) {
    return { show: false, disabled: true, reason: 'pending_actions' };
  }
  if (input.alreadyContinued) {
    return { show: false, disabled: true, reason: 'already_continued' };
  }
  if (confirmationIndex !== input.messages.length - 1) {
    return { show: false, disabled: true, reason: 'stale' };
  }
  if (input.busy) {
    return { show: true, disabled: true, sourceMessageId, reason: 'busy' };
  }
  return { show: true, disabled: false, sourceMessageId, reason: 'ready' };
}

/**
 * "Continue with Defty" posts this as an ordinary chat message in the agent
 * conversation (POST /api/messages/:spaceId). The messages route wakes the
 * conversation's agent and the queued agent-reply worker answers it in chat
 * mode, where every write is proposed for approval. The retired
 * /api/agent/conversations/:id/continue stream is no longer used.
 */
export const APPROVAL_CONTINUATION_MESSAGE = 'Continue.';

export function approvalContinuationMessageBody(): { content: string; file_ids: string[] } {
  return { content: APPROVAL_CONTINUATION_MESSAGE, file_ids: [] };
}

const CONTINUATION_KEY_PREFIX = 'approval-continue:';

/**
 * Idempotency-Key for the continuation post. Derived only from the space and
 * the approval-confirmation message, so every retry of the same confirmation
 * (including after a lost response with no working sessionStorage) replays
 * the same key and the server returns the already-committed message instead
 * of starting another agent turn. A later confirmation message gets a
 * different key. Hashed so the result always fits the API's key contract
 * (1-128 chars of [A-Za-z0-9._:-]) whatever characters the IDs contain.
 */
export async function approvalContinuationIdempotencyKey(
  spaceId: string,
  confirmationId: string,
): Promise<string> {
  const material = new TextEncoder().encode(JSON.stringify([spaceId, confirmationId]));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', material);
  const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${CONTINUATION_KEY_PREFIX}${hex}`;
}
