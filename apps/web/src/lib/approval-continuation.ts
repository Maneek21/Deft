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

export async function consumeAgentContinuationStream(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The continuation response had no stream.');

  const decoder = new TextDecoder();
  let buffer = '';
  let streamedError: string | null = null;
  let completed = false;

  const consumeLine = (line: string) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    try {
      const event = JSON.parse(payload) as { type?: unknown; error?: unknown };
      if (event.type === 'error' && typeof event.error === 'string' && event.error.trim()) {
        streamedError ??= event.error;
      }
      if (event.type === 'done') completed = true;
    } catch {
      // Unknown SSE events are ignored; the persisted conversation is authoritative.
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  if (buffer) consumeLine(buffer);

  if (streamedError) throw new Error(streamedError);
  if (!completed) throw new Error('The continuation stream ended before completion.');
}
