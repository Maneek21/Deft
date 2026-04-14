/**
 * Phase 5 — thin HTTP wrapper around OpenClaw's OpenAI-compatible
 * chat completions endpoint.
 *
 * Keeps I/O isolated from the envelope parser so both sides stay unit-testable.
 * - 60s default timeout via AbortController
 * - Throws on non-2xx with the response body attached
 * - Returns the raw ReadableStream body for downstream SSE parsing
 *
 * OpenClaw v2026.3.12+ cancels in-flight agent runs when the HTTP client
 * disconnects, so aborting the fetch stops the agent cleanly.
 */
import type { OpenAIChatCompletionRequest } from './openclaw-chat-envelope.js';

export type ChatCompletionParams = {
  connection_url: string;
  gateway_token: string;
  request: OpenAIChatCompletionRequest;
  timeoutMs?: number;
};

export type ChatCompletionResult = {
  stream: ReadableStream<Uint8Array>;
  startTime: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;

export async function chatCompletion(
  params: ChatCompletionParams,
): Promise<ChatCompletionResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Ensure stream:true so the caller actually gets an SSE stream back.
  const body = { ...params.request, stream: true };

  const url = `${params.connection_url.replace(/\/+$/, '')}/v1/chat/completions`;
  const startTime = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${params.gateway_token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `openclawClient.chatCompletion: timeout after ${timeoutMs}ms calling ${url}`,
      );
    }
    throw err;
  }

  if (!res.ok) {
    clearTimeout(timer);
    const errBody = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `openclawClient.chatCompletion: ${res.status} ${res.statusText} from ${url} — ${errBody.slice(0, 500)}`,
    );
  }

  if (!res.body) {
    clearTimeout(timer);
    throw new Error(
      `openclawClient.chatCompletion: response has no body stream (url=${url})`,
    );
  }

  // Clear the timer once headers land. Downstream consumers manage the body.
  // If the stream hangs mid-flight, the caller's own timeout (worker-level)
  // handles it; we don't want to race the body reader here.
  clearTimeout(timer);

  return { stream: res.body, startTime };
}
