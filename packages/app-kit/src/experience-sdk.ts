/** Public author-side SDK leaf. Bundlers inline this into the immutable Worker.
 * It contains no credential, URL, fetch or direct workspace API surface. */
export const DEFT_EXPERIENCE_SDK_VERSION = 'deft.experience_bridge.v1' as const;

export type ExperienceSdkPort = Pick<MessagePort, 'postMessage' | 'close' | 'onmessage'>;
export type ExperienceSdkIntent = 'resource' | 'action' | 'run_status' | 'run_cancel' | 'navigate' | 'dialog';

export function createDeftExperienceSdk(port: ExperienceSdkPort, sessionId: string) {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(sessionId)) throw new Error('Invalid Experience session');
  let sequence = 0;
  let closed = false;
  const pending = new Map<string, { resolve(value: unknown): void; reject(reason: Error): void }>();
  let onUiEvent: ((event: unknown) => void) | undefined;
  port.onmessage = (message: MessageEvent) => {
    const value: unknown = message.data;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const reply = value as Record<string, unknown>;
    if (reply.version !== DEFT_EXPERIENCE_SDK_VERSION || reply.session_id !== sessionId) return;
    if (reply.kind === 'ui_event') { onUiEvent?.(reply.event); return; }
    if (reply.kind !== 'response' || typeof reply.request_id !== 'string') return;
    const promise = pending.get(reply.request_id);
    if (!promise) return;
    pending.delete(reply.request_id);
    if (reply.ok === true) promise.resolve(reply.output);
    else promise.reject(new Error(typeof reply.code === 'string' ? reply.code : 'UNAVAILABLE'));
  };
  const post = (message: Record<string, unknown>): number => {
    if (closed) throw new Error('Experience session closed');
    sequence += 1;
    port.postMessage({ version: DEFT_EXPERIENCE_SDK_VERSION,
      session_id: sessionId, sequence, ...message });
    return sequence;
  };
  return Object.freeze({
    render(view: unknown): void { post({ kind: 'view', view }); },
    request(operation: ExperienceSdkIntent, key?: string, input?: unknown): Promise<unknown> {
      if (pending.size >= 16) return Promise.reject(new Error('Experience request limit'));
      const requestId = `request_${sequence + 1}`;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        try { post({ kind: 'request', request_id: requestId, operation, key, input }); }
        catch (error) { pending.delete(requestId); reject(error); }
      });
    },
    onEvent(handler: (event: unknown) => void): void { onUiEvent = handler; },
    close(): void {
      if (closed) return;
      closed = true;
      for (const request of pending.values()) request.reject(new Error('Experience session closed'));
      pending.clear();
      port.onmessage = null;
      port.close();
    },
  });
}
